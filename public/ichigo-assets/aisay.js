// 第七刀 · aisay.js（Ai SAY 面板 + 会话历史桶，复制自 ichigo-console.html L2672-2905/L1983/L2355-2666）
// 依赖：state.js(state/ONLINE) + util.js(esc/toast/findContact) + ichigo.js(translateAll 跨模块保护)
// 无循环：aisay → ichigo 单向（ichigo.js 不 import aisay.js；selectCustomer→aiHistRestore 走 window 保护）
'use strict';
import { state, ONLINE } from './state.js';
import { esc, toast, findContact, copyText } from './util.js'; // 第 8 刀收口：copyText 直接 import

// ---------- 会话历史桶（复制自 L2672-2724）----------
export function _aiHistKey(contactId) {
  return 'aishist:v1:' + (contactId || '_default');
}

export function _curContactId() {
  return (state && state.selectedId) ? state.selectedId : null;
}

export function aiHistLoad(contactId) {
  var cid = (typeof contactId === 'string' && contactId) ? contactId : _curContactId();
  try {
    var raw = localStorage.getItem(_aiHistKey(cid));
    if (!raw) return null;
    var d = JSON.parse(raw);
    if (!d) return null;
    if (Array.isArray(d.sessions)) { return d; }
    if (Array.isArray(d.items)) {
      d.sessions = [{ sessionId: 'legacy', ts: new Date().toISOString(), title: '旧会话（无 6 面板格式）', messages: d.items.map(function(it) { return { role: it.role, text: it.text, ts: it.ts }; }) }];
      delete d.items;
      try { localStorage.setItem(_aiHistKey(cid), JSON.stringify(d)); } catch (e) { console.warn('[aisay] 迁移写失败', e); }
      return d;
    }
    d.sessions = [];
    return d;
  } catch (e) { console.warn('aiHistLoad failed', e); return null; }
}

export function _activeSession(d, cid) {
  if (!d || !Array.isArray(d.sessions) || !d.sessions.length) return null;
  var last = d.sessions[d.sessions.length - 1];
  var refTs = 0;
  if (last && last.ts) refTs = Date.parse(last.ts) || 0;
  if (last && Array.isArray(last.messages) && last.messages.length) {
    refTs = Math.max(refTs, Date.parse(last.messages[last.messages.length - 1].ts || '') || 0);
  }
  if (refTs && Date.now() - refTs > 30 * 60 * 1000) {
    var ns = { sessionId: 's' + Date.now(), ts: new Date().toISOString(), title: '', messages: [] };
    d.sessions.push(ns);
    return ns;
  }
  return last;
}

export function _ensureSession(d, cid) {
  if (!d) return null;
  if (!Array.isArray(d.sessions)) d.sessions = [];
  var s = _activeSession(d, cid);
  if (!s) { s = { sessionId: 's' + Date.now(), ts: new Date().toISOString(), title: '', messages: [] }; d.sessions.push(s); }
  return s;
}

export function aiHistSave(contactId, data) {
  var cid = (typeof contactId === 'string' && contactId) ? contactId : _curContactId();
  var sessions = (data && Array.isArray(data.sessions)) ? data.sessions : [];
  try { localStorage.setItem(_aiHistKey(cid), JSON.stringify({ seq: sessions.length, sessions: sessions })); }
  catch (e) { console.warn('aiHistSave failed (可能 localStorage 超限)', e); toast('本地存储接近上限，部分会话可能未保存', false); }
}

export function aiAppendMsg(role, html, text, classes) {
  var host = document.getElementById('aiList');
  if (!host) return null;
  var node = document.createElement('div');
  node.className = 'ai-msg ' + (role === 'user' ? 'user' : 'bot') + (classes ? ' ' + classes : '');
  node.setAttribute('data-role', role);
  node.innerHTML = html;
  host.appendChild(node);
  host.scrollTop = host.scrollHeight;
  var d = aiHistLoad(_curContactId());
  if (!d) { d = { seq: 0, sessions: [] }; }
  if (!Array.isArray(d.sessions)) d.sessions = [];
  var s = (role === 'user') ? _ensureSession(d, _curContactId()) : _activeSession(d, _curContactId());
  if (!s) { s = _ensureSession(d, _curContactId()); }
  s.messages.push({ role: role, text: String(text || '').slice(0, 500), ts: new Date().toISOString() });
  aiHistSave(_curContactId(), d);
  return node;
}

export function aiHistRestore(contactId) {
  var host = document.getElementById('aiList');
  if (!host) return;
  var d = aiHistLoad(contactId);
  var cid = (typeof contactId === 'string' && contactId) ? contactId : _curContactId();
  host.innerHTML = '';
  var sessions = (d && Array.isArray(d.sessions)) ? d.sessions : [];
  var latest = sessions.length ? sessions[sessions.length - 1] : null;
  var msgs = (latest && Array.isArray(latest.messages)) ? latest.messages : [];
  if (!msgs.length) {
    host.innerHTML = '<div class="ai-msg bot" data-role="bot">' + (cid ? '新客户，暂无会话记录。' : '你好，我是 Ai SAY 助手。选择客户后我可以帮你分析客户画像、生成推荐话术、翻译消息。所有发送给客户的消息需要你确认后才发出。') + '</div>';
    host.scrollTop = host.scrollHeight;
    return;
  }
  var cObj = state.selectedId ? findContact(state.selectedId) : null;
  msgs.forEach(function(m) {
    if (m.role === 'user') {
      var un = document.createElement('div');
      un.className = 'ai-msg user';
      un.setAttribute('data-role', 'user');
      un.innerHTML = esc(m.text || '');
      host.appendChild(un);
    } else {
      var bn = document.createElement('div');
      bn.className = 'ai-msg bot' + (m.data ? ' has-panel' : '');
      bn.setAttribute('data-role', 'bot');
      bn.innerHTML = esc(m.text || '');
      if (m.data && Array.isArray(m.data.replies) && m.data.replies.length) {
        bn.style.cursor = 'pointer';
        bn.title = '点击展开完整面板';
        bn.addEventListener('click', function() {
          var temp = document.createElement('div');
          renderStructuredAssistant(m.data, cObj, temp);
          Array.prototype.forEach.call(temp.children, function(child) {
            host.insertBefore(child, bn.nextSibling);
            bn = bn.nextSibling;
          });
          bn.remove();
          host.scrollTop = host.scrollHeight;
        });
      }
      host.appendChild(bn);
    }
  });
  host.scrollTop = host.scrollHeight;
}

export function aiHistPush(role, text, dataOpt) {
  var cid = _curContactId();
  var d = aiHistLoad(cid);
  if (!d) { d = { seq: 0, sessions: [] }; }
  if (!Array.isArray(d.sessions)) d.sessions = [];
  var s = _activeSession(d, cid);
  if (!s) { s = _ensureSession(d, cid); }
  var entry = { role: role, text: String(text || '').slice(0, 500), ts: new Date().toISOString() };
  if (dataOpt) { entry.data = dataOpt; }
  s.messages.push(entry);
  aiHistSave(cid, d);
}

export function openAiHistPop() {
  var pop = document.getElementById('aiHistPop');
  if (!pop) return;
  var cid = _curContactId();
  var d = aiHistLoad(cid);
  var sessions = (d && Array.isArray(d.sessions)) ? d.sessions.slice() : [];
  sessions = sessions.slice().reverse();
  var listEl = pop.querySelector('.ai-hist-pop-list');
  var headEl = pop.querySelector('.ai-hist-pop-head span');
  if (headEl) headEl.textContent = cid ? ('客户 ' + cid + ' · 共 ' + sessions.length + ' 个会话') : ('默认会话 · 共 ' + sessions.length + ' 个会话');
  if (!sessions.length) {
    listEl.innerHTML = '<div style="padding:12px;color:var(--muted,#888);font-size:12px">暂无会话记录</div>';
  } else {
    listEl.innerHTML = '';
    sessions.forEach(function(sess) {
      var row = document.createElement('div');
      row.className = 'ai-hist-entry';
      var msgs = (sess && Array.isArray(sess.messages)) ? sess.messages : [];
      var firstUser = '';
      for (var k = 0; k < msgs.length; k++) { if (msgs[k].role === 'user') { firstUser = String(msgs[k].text || '').slice(0, 30); break; } }
      var title = sess.title || firstUser || ('会话 ' + (sess.sessionId || ''));
      row.innerHTML = '<div class="hi-time">' + (sess.ts || '') + ' <span class="hi-role">' + msgs.length + ' 条</span></div><div class="hi-text"></div>';
      row.querySelector('.hi-text').textContent = title;
      row.addEventListener('click', function() { aiHistRestoreSession(sess); closeAiHistPop(); });
      listEl.appendChild(row);
    });
  }
  pop.classList.add('show');
}

export function aiHistRestoreSession(sess) {
  var host = document.getElementById('aiList');
  if (!host) return;
  host.innerHTML = '';
  var msgs = (sess && Array.isArray(sess.messages)) ? sess.messages : [];
  if (!msgs.length) { host.innerHTML = '<div class="ai-msg bot" data-role="bot">（空会话）</div>'; return; }
  var cObj = state.selectedId ? findContact(state.selectedId) : null;
  msgs.forEach(function(m) {
    if (m.role === 'user') {
      var un = document.createElement('div');
      un.className = 'ai-msg user';
      un.setAttribute('data-role', 'user');
      un.innerHTML = esc(m.text || '');
      host.appendChild(un);
    } else {
      if (m.data && m.data.analysis !== undefined) {
        renderStructuredAssistant(m.data, cObj, host);
      } else {
        var bn = document.createElement('div');
        bn.className = 'ai-msg bot';
        bn.setAttribute('data-role', 'bot');
        bn.innerHTML = esc(m.text || '');
        host.appendChild(bn);
      }
    }
  });
  host.scrollTop = host.scrollHeight;
}

export function closeAiHistPop() {
  var pop = document.getElementById('aiHistPop');
  if (pop) pop.classList.remove('show');
}

export function bindAiHistPopDismiss() {
  document.addEventListener('click', function(e) {
    var pop = document.getElementById('aiHistPop');
    if (!pop || !pop.classList.contains('show')) return;
    if (pop.contains(e.target)) return;
    var btn = document.getElementById('btnAiHist');
    if (btn && btn.contains(e.target)) return;
    closeAiHistPop();
  });
}

export function aiHistNewSession() {
  var cid = _curContactId();
  var d = aiHistLoad(cid);
  if (!d) { d = { seq: 0, sessions: [] }; }
  if (!Array.isArray(d.sessions)) d.sessions = [];
  var s = { sessionId: 's' + Date.now(), ts: new Date().toISOString(), title: '', messages: [] };
  d.sessions.push(s);
  aiHistSave(cid, d);
  var host = document.getElementById('aiList');
  if (!host) return;
  host.innerHTML = '<div class="ai-msg bot" data-role="bot">你好，我是 Ai SAY 助手。选择客户后我可以帮你分析客户画像、生成推荐话术、翻译消息。所有发送给客户的消息需要你确认后才发出。</div>';
  toast('新会话已开启（旧会话仍在「历史」可见）', true);
}

export function aiHistClear() {
  var cid = _curContactId();
  try { localStorage.removeItem(_aiHistKey(cid)); } catch (e) { console.warn('aiHistClear failed', e); }
  var host = document.getElementById('aiList');
  if (!host) return;
  host.innerHTML = '<div class="ai-msg bot" data-role="bot">你好，我是 Ai SAY 助手。选择客户后我可以帮你分析客户画像、生成推荐话术、翻译消息。所有发送给客户的消息需要你确认后才发出。</div>';
  toast('会话历史已清空', true);
}

// ---------- Ai SAY 面板核心（复制自 L2355-2666/L1983）----------
export function bindAiChips() {
  var host = document.getElementById('aiChips');
  if (!host) return;
  Array.prototype.forEach.call(host.querySelectorAll('.ai-chip'), function(chip) {
    chip.addEventListener('click', function() {
      if (chip.disabled) return;
      var intent = chip.getAttribute('data-intent') || 'analyze';
      if (intent === 'followup') { askFollowupSop(); return; }
      askAssistantWithIntent(intent);
    });
  });
}

// v5.3 · 跟进 SOP chip：走 /api/console/followup（关心/软推进ライン/理解退路，不直接说 LINE 品牌）
export async function askFollowupSop() {
  var cid = state.selectedId ? findContact(state.selectedId).contactId : null;
  if (!cid) {
    var h = document.getElementById('aiList');
    if (h) { var m = document.createElement('div'); m.className = 'ai-msg bot err'; m.textContent = '请先选择客户，再生成跟进 SOP'; h.appendChild(m); h.scrollTop = h.scrollHeight; }
    return;
  }
  aiAppendMsg('user', '跟进 SOP（加ライン）：' + cid, 'followup');
  var host = document.getElementById('aiList');
  var thinking = document.createElement('div');
  thinking.className = 'ai-msg bot';
  thinking.innerHTML = '<span class="ai-thinking">正在算该做的跟进动作…</span>';
  host.appendChild(thinking); host.scrollTop = host.scrollHeight;
  try {
    var q = '/api/console/followup?conversationId=' + encodeURIComponent(cid) + '&name=' + encodeURIComponent((state.selectedId ? (findContact(state.selectedId).nickname || findContact(state.selectedId).displayName) : 'あなた'));
    var res = await fetch(q);
    var j = await res.json();
    thinking.remove();
    if (!j || j.ok !== true) {
      aiAppendMsg('bot', esc((j && j.msg) || (j && j.reason) || '跟进 SOP 不可用'), 'followup-err');
      return;
    }
    renderFollowupSop(j, host);
  } catch (e) {
    thinking.remove();
    aiAppendMsg('bot', esc('跟进 SOP 请求失败：' + e.message), 'followup-err');
  }
}

// 渲染 SOP 结果：stage 状态 + 推荐动作 + 3 类参考话术卡（复制/填入按钮）
function renderFollowupSop(j, host) {
  var card = document.createElement('div');
  card.className = 'ai-msg bot';
  var head = '跟进 SOP · stage=' + j.stage + ' · 距上条 ' + j.daysSinceLast + ' 天';
  var rec = j.recommended;
  card.innerHTML =
    '<div style="font-weight:600;margin-bottom:4px">' + esc(head) + '</div>' +
    '<div style="font-size:11px;color:var(--muted,#888);margin-bottom:6px">' + esc((j.decision && j.decision.note) || '') + '（LINE 一律 ライン 软推进）</div>' +
    j.talks.map(function(tk) {
      var label = { care: '💗 关心', nudge: '⏰ 软推进（ライン）', understand: '🤝 理解退路', meet: '🎯 约见面' }[tk.kind] || tk.kind;
      return '<div class="ai-reply-card">' +
        '<span class="ai-reply-type">' + esc(label) + '</span>' +
        '<div class="ai-reply-content">' + esc(tk.ja) + '</div>' +
        '<div class="ai-reply-trans">' + esc(tk.zh) + '</div>' +
        '<div class="ai-card-btns">' +
          '<button data-copy="' + tk.kind + '">复制</button>' +
          '<button data-fill="' + tk.kind + '">填入输入框</button>' +
        '</div></div>';
    }).join('');
  host.appendChild(card); host.scrollTop = host.scrollHeight;
  // 绑定 复制/填入（只写 input，不发送，铁律 §0.1）
  Array.prototype.forEach.call(card.querySelectorAll('[data-fill]'), function(b) {
    b.addEventListener('click', function() {
      var k = b.getAttribute('data-fill');
      var tk = j.talks.find(function(x) { return x.kind === k; });
      if (tk) { var mi = document.getElementById('msgInput'); if (mi) { mi.value = tk.ja; mi.focus(); } }
    });
  });
  Array.prototype.forEach.call(card.querySelectorAll('[data-copy]'), function(b) {
    b.addEventListener('click', function() {
      var k = b.getAttribute('data-copy');
      var tk = j.talks.find(function(x) { return x.kind === k; });
      if (tk && navigator.clipboard) navigator.clipboard.writeText(tk.ja).catch(function() {});
    });
  });
}

export async function askAssistantWithIntent(intent) {
  var inp = document.getElementById('aiInput');
  var t = inp ? inp.value.trim() : '';
  if (t) {
    inp.value = '';
    var labelMap = { analyze: '深度心理分析', reply: '生成高情商回复', deflect: '委婉拉扯/拒绝', meet: '引导线下约会', followup: '跟进 SOP（加ライン）' };
    var msg = t + '（意图：' + (labelMap[intent] || intent) + '）';
    await askAssistantCore(msg, intent);
  } else {
    var defaultMsg = { analyze: '请对当前客户做深度心理分析', reply: '请生成高情商回复建议', deflect: '请给出委婉拉扯/拒绝的话术', meet: '请引导客户到线下见面', followup: '请按跟进 SOP 给当前客户生成参考话术（关心/软推进ライン/理解退路）' };
    await askAssistantCore(defaultMsg[intent] || intent, intent);
  }
}

export async function askAssistantCore(msgText, intent) {
  var t = String(msgText || '').trim();
  if (!t) return;
  aiAppendMsg('user', esc(t), t);
  var cid = state.selectedId ? findContact(state.selectedId).contactId : null;
  var c = cid ? findContact(state.selectedId) : null;
  var history = [];
  if (c) {
    var d = state.details[c.contactId] || {};
    history = (d.messages || []).slice(-12).map(function(m) {
      return { role: m.role || m.direction || 'in', text: String(m.text || m.body || '').slice(0, 160), ts: m.ts || m.timeIso };
    });
  }
  var host = document.getElementById('aiList');
  var thinking = document.createElement('div');
  thinking.className = 'ai-msg bot';
  thinking.setAttribute('data-role', 'bot');
  thinking.innerHTML = '<span class="ai-thinking">正在思考…</span>';
  host.appendChild(thinking);
  host.scrollTop = host.scrollHeight;
  try {
    var body = { message: t, contactId: cid, history: history, maxMsgs: 12 };
    if (intent) body.intent = intent;
    var res = await fetch('/api/console/assistant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var j = await res.json();
    thinking.remove();
    if (!j || j.ok !== true) {
      var errText = (j && j.msg) || (j && j.reason) || ('助手不可用（' + res.status + '）');
      aiAppendMsg('bot', esc(errText), '助手不可用：' + errText);
      var lastNode = document.querySelector('#aiList .ai-msg.bot:last-child');
      if (lastNode) lastNode.classList.add('err');
    } else {
      renderStructuredAssistant(j, c, host);
    }
  } catch (e) {
    thinking.remove();
    var failText = '助手请求失败：' + e.message + '（已降级本地摘要）';
    var node = document.createElement('div');
    node.className = 'ai-msg bot';
    node.setAttribute('data-role', 'bot');
    node.innerHTML = esc(failText) + '<br>' + esc(aiReply());
    host.appendChild(node);
    host.scrollTop = host.scrollHeight;
    aiHistPush('bot', failText + '\n' + aiReply());
  }
  host.scrollTop = host.scrollHeight;
}

export function fillDraftIntoMsgInput(text) {
  var ta = document.getElementById('msgInput');
  if (!ta) { toast('没找到消息输入框（先选客户）', false); return; }
  if (ta.value.trim() && ta.value.trim() !== text.trim() && !confirm('覆盖当前输入？')) return;
  ta.value = text;
  ta.focus();
  toast('已填入发送框，请检查后手动点发送', true);
  aiHistPush('bot', '已填入发送框：' + text.slice(0, 60) + (text.length > 60 ? '…' : ''));
}

// 结构化 6 面板渲染（复制自 L2386；铁律 1 发送只填不发）
export function renderStructuredAssistant(j, c, host) {
  var node = document.createElement('div');
  node.className = 'ai-msg bot' + (j.degraded ? ' degraded' : '');
  node.setAttribute('data-role', 'bot');
  var analysis = String(j.analysis || '').trim();
  if (analysis) {
    var acc1 = document.createElement('div');
    acc1.className = 'ai-acc';
    acc1.innerHTML = '<div class="ai-acc-head">心理分析</div><div class="ai-acc-body"></div>';
    acc1.querySelector('.ai-acc-body').textContent = analysis;
    acc1.querySelector('.ai-acc-head').addEventListener('click', function() { acc1.classList.toggle('open'); });
    node.appendChild(acc1);
  }
  var strategy = String(j.strategy || '').trim();
  if (strategy) {
    var acc2 = document.createElement('div');
    acc2.className = 'ai-acc';
    acc2.innerHTML = '<div class="ai-acc-head">应对策略</div><div class="ai-acc-body"></div>';
    acc2.querySelector('.ai-acc-body').textContent = strategy;
    acc2.querySelector('.ai-acc-head').addEventListener('click', function() { acc2.classList.toggle('open'); });
    node.appendChild(acc2);
  }
  var replyText = String(j.reply || '').trim();
  if (replyText) {
    var bodyEl = document.createElement('div');
    bodyEl.style.marginTop = '6px';
    bodyEl.textContent = replyText;
    node.appendChild(bodyEl);
  }
  if (j.degraded) {
    var tag = document.createElement('div');
    tag.className = 'ai-degraded-tag';
    tag.textContent = '降级模式：' + (j.reason || '模型不可用或返回非标准 JSON，以下为本地摘要');
    node.appendChild(tag);
  }
  var typeLabelMap = { opening: '开场', followup: '跟进', deflect: '拉扯', meet: '见面', close: '收尾', other: '其他' };
  var replies = Array.isArray(j.replies) ? j.replies : [];
  var validReplies = replies.filter(function(r) { return r && String(r.content || '').trim(); });
  var replyCount = validReplies.length;
  validReplies.forEach(function(r, i) {
    var label = String(i + 1);
    var cardPanel = document.createElement('div');
    cardPanel.className = 'ai-acc open';
    cardPanel.innerHTML = '<div class="ai-acc-head">参考回复 ' + label + '</div><div class="ai-acc-body"></div>';
    cardPanel.querySelector('.ai-acc-head').addEventListener('click', function() { cardPanel.classList.toggle('open'); });
    var cardBody = cardPanel.querySelector('.ai-acc-body');
    var t = String(r.type || 'other');
    var contentSnapshot = String(r.content).trim();
    var card = document.createElement('div');
    card.className = 'ai-reply-card';
    card.innerHTML =
      '<span class="ai-reply-type">' + esc(typeLabelMap[t] || '其他') + '</span>' +
      '<div class="ai-reply-content"></div>' +
      '<div class="ai-card-btns">' +
        '<button class="ai-copy-btn" title="复制日文原文到剪贴板">复制</button>' +
        '<button class="ai-fill-btn" title="填入中栏发送框，不自动发送">填入发送框</button>' +
        '<button class="ai-send-btn" title="填入后点中栏「确认发送」才真正发出">发送（需确认）</button>' +
      '</div>';
    card.querySelector('.ai-reply-content').textContent = contentSnapshot;
    card.querySelector('.ai-copy-btn').addEventListener('click', function() {
      copyText(contentSnapshot, '已复制日文原文'); // 第 8 刀收口：直接 import 调用
    });
    card.querySelector('.ai-fill-btn').addEventListener('click', function() {
      fillDraftIntoMsgInput(contentSnapshot);
    });
    // 铁律 1 · 发送（需确认）只填不发
    card.querySelector('.ai-send-btn').addEventListener('click', function() {
      fillDraftIntoMsgInput(contentSnapshot);
    });
    cardBody.appendChild(card);
    node.appendChild(cardPanel);
    var tr = String(r.translation || '').trim();
    if (tr) {
      var transPanel = document.createElement('div');
      transPanel.className = 'ai-acc open';
      transPanel.innerHTML = '<div class="ai-acc-head">参考回复 ' + label + '-翻译</div><div class="ai-acc-body"></div>';
      transPanel.querySelector('.ai-acc-head').addEventListener('click', function() { transPanel.classList.toggle('open'); });
      var transBody = transPanel.querySelector('.ai-acc-body');
      var item = document.createElement('div');
      item.className = 'ai-trans-item';
      item.textContent = tr;
      transBody.appendChild(item);
      node.appendChild(transPanel);
    }
  });
  if (j.actions && j.actions.length) {
    var actionsDiv = document.createElement('div');
    actionsDiv.className = 'ai-actions';
    j.actions.forEach(function(a, i) {
      var btn = document.createElement('button');
      btn.className = 'ai-action' + (a.sideEffect === 'strong' ? ' strong' : '');
      btn.setAttribute('data-aiact', String(i));
      btn.textContent = (a.sideEffect === 'strong' ? '确认发送 ' : '') + (a.label || a.type);
      btn.title = (a.desc || a.type) + (a.needConfirm ? '（需你确认后才真发）' : '');
      btn.addEventListener('click', function() { runAction(a, c); });
      actionsDiv.appendChild(btn);
    });
    node.appendChild(actionsDiv);
  }
  host.appendChild(node);
  host.scrollTop = host.scrollHeight;
  var chips = document.querySelectorAll('.ai-chips .ai-chip');
  if (j.degraded) {
    Array.prototype.forEach.call(chips, function(ch) { ch.disabled = true; ch.title = (ch.title || '') + '（降级模式仍可用）'; });
  }
  var textSnap = [];
  if (analysis) textSnap.push('【分析】' + analysis.slice(0, 200));
  if (strategy) textSnap.push('【策略】' + strategy.slice(0, 200));
  if (replyText) textSnap.push(replyText.slice(0, 200));
  if (replyCount) textSnap.push('[' + replyCount + ' 条话术]');
  (validReplies || []).forEach(function(r, ri) {
    var seg = '【话术' + (ri + 1) + '】' + String(r.content || '').slice(0, 300);
    if (r.translation) { seg += '\n（译）' + String(r.translation).slice(0, 300); }
    textSnap.push(seg);
  });
  if (j.actions && j.actions.length) textSnap.push('[动作] ' + j.actions.map(function(x) { return x.label || x.type; }).join('、'));
  aiHistPush('bot', textSnap.join('\n') || '(无回复)', { analysis: analysis, strategy: strategy, replies: (j && j.replies) || [], actions: (j && j.actions) || [], degraded: !!(j && j.degraded) });
}

export function showCustomerBrief(c) {
  var host = document.getElementById('aiList');
  var d = state.details[c.contactId] || {};
  var p = d.profile || {};
  var fs2 = [];
  if (c.age) fs2.push('年龄 ' + c.age);
  if (p.region) fs2.push('地区 ' + p.region);
  if (p.occupation) fs2.push('职业 ' + p.occupation);
  var msgs = (d.messages || []);
  var briefHtml = '<div class="ai-msg bot" style="margin:0">【' + esc(c.name) + '】 ' + esc(fs2.join(' · ')) + (msgs.length ? (' · 共 ' + msgs.length + ' 条消息') : '') + '</div>';
  host.innerHTML += briefHtml;
  host.scrollTop = host.scrollHeight;
  aiHistPush('bot', '【' + c.name + '】 ' + fs2.join(' · ') + (msgs.length ? (' · 共 ' + msgs.length + ' 条消息') : ''));
}

export function aiReply() {
  var c = state.selectedId ? findContact(state.selectedId) : null;
  if (!c) return '请先在左侧选择一个客户。';
  var d = state.details[c.contactId] || {};
  var parts = ['【' + c.name + '】'];
  var od = ONLINE[c.onlineTier];
  if (od) parts.push(od.tip);
  if (c.age) parts.push(c.age);
  if (c.lastMsgTime) parts.push('最近聊天 ' + c.lastMsgTime);
  if (d.profile && d.profile.fields) {
    var f = d.profile.fields, fs = [];
    if (f.occupation) fs.push('职业 ' + f.occupation);
    if (f.marital) fs.push(f.marital);
    if (f.height) fs.push(f.height);
    if (fs.length) parts.push(fs.join(' · '));
  }
  if (d.profile && d.profile.interestIcons && d.profile.interestIcons.length) {
    parts.push('兴趣：' + d.profile.interestIcons.map(function(i) { return i.label || i.icon; }).join('、'));
  }
  var msgs = d.messages || [];
  if (msgs.length) {
    parts.push('共 ' + msgs.length + ' 条消息');
    var lastPeer = null;
    for (var i = msgs.length - 1; i >= 0; i--) if (msgs[i].from === 'peer') { lastPeer = msgs[i]; break; }
    if (lastPeer) parts.push('客户最后说："' + (lastPeer.text || '').slice(0, 40) + '"');
  }
  return parts.join('；');
}

// runAction（复制自原代码；跨模块走 window 保护）
function runAction(a, c) {
  var w = (typeof window !== 'undefined') ? window : null;
  if (!a || !a.type) return;
  if (a.type === 'fill_draft' || a.type === 'send_message') {
    // 铁律 1：fill_draft 只填；send_message 也先填后手动确认（不走 fetch send-live）
    fillDraftIntoMsgInput(String(a.payload && a.payload.text || a.payload || ''));
    return;
  }
  if (a.type === 'translate' && w && typeof w.translate === 'function') {
    w.translate(String(a.payload && a.payload.text || ''), 'ja', 'zh-CN').then(function(j) { if (j && j.ok) toast(j.translated, true); });
    return;
  }
  if (a.type === 'mark_read' && c && w && typeof w.selectCustomer === 'function') {
    w.selectCustomer(c.contactId);
    return;
  }
  toast('动作「' + (a.label || a.type) + '」未接入（只读降级）', false);
}

// 过渡桥接（第 7 刀保留，第 8 刀删）