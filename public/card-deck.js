// 卡片流 · 真数据版（/api/console/card-leads + SendQueue + assistant B v1.1）
'use strict';

var currentIdx = 0;
var leads = [];
var leadsLoaded = false;
var queueItems = [];   // 内存队列(镜像后端 SendQueue; 真发由后端 dispatcher 驱动, 此处只做展示+撤出)
var pendingBlock = null;
var pendingAdjust = null;

function now() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

// ============ 加载真实候选 ============
async function loadLeads() {
  if (String(location.search || '').indexOf('mock=1') !== -1) {
    leads = [MOCK_DEMO_CARD()];
    leadsLoaded = true;
    render();
    return;
  }
  try {
    var r = await fetch('/api/console/card-leads?maxLeads=60&maxLikes=20&maxChats=10');
    var d = await r.json();
    if (d.ok && Array.isArray(d.cards) && d.cards.length) {
      leads = d.cards.map(function(c, i) {
        return mapCard(c, i);
      });
    }
  } catch (e) { /* 网络失败 → mock 兜底 */ }
  if (!leads.length) {
    leads = [{
      id: 'ERR', platform: 'ichigo', platformName: '出会', noRevoke: true, cat: '', source: '',
      customer: { name: '（拉取失败）', age: '', city: '', interests: [], selfIntro: 'CDP 窗口未开或线索池为空。请开 17098/18595 窗口后刷新本页面。', avatarUrls: [] },
      accountSelf: ACCOUNT_SELF, chatHistory: [], lastMsg: '', lastMsgZh: '', lastTime: '', ai: null,
      state: 'PENDING', selectedTalk: null, tags: [], opLog: []
    }];
  }
  leadsLoaded = true;
  // 加载队列快照(后端 SendQueue)
  loadQueueSnapshot();
  refreshWindows();
  render();
}

var ACCOUNT_SELF = { name: 'ともね', age: 38, city: '三重・津市', traits: '美人系·巨乳·B型' };

function mapCard(c, i) {
  var isHappy = c.platform === 'happymail';
  // 后端 card 对象: {name,age,city,onlineIcon,chatHistory,lastMsg,lastMsgZh,interests,selfIntro,platform,noRevoke,...}
  return {
    id: c.id || ('L' + i),
    platform: c.platform || 'ichigo',
    platformName: c.platform === 'happymail' ? '快乐' : '出会',
    noRevoke: c.noRevoke !== false,
    cat: c.cat || '', source: c.source || '',
    memberId: c.memberId || null,
    customer: {
      name: c.name || '（未名）', age: c.age || '', city: c.city || '',
      interests: c.interests || [], selfIntro: c.selfIntro || '',
      avatarUrls: c.avatarUrls || []
    },
    accountSelf: ACCOUNT_SELF,
    onlineIcon: c.onlineIcon || null,
    chatHistory: Array.isArray(c.chatHistory) ? c.chatHistory : [],
    lastMsg: c.lastMsg || '', lastMsgZh: c.lastMsgZh || '', lastTime: c.lastTime || '',
    ai: c.ai,  // 后端没带 ai → 首次渲染时按 4 键调 assistant
    state: 'PENDING', selectedTalk: null, tags: c.tags || [], opLog: c.opLog || []
  };
}

// 4/5 键: 调 assistant B v1.1 真生成
async function generateTalks(l, intent, adjustNote) {
  l.ai = null;
  render();
  try {
    var r = await fetch('/api/console/card/regenerate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: l.id, contactId: l.memberId || l.id,
        platform: l.platform, accountId: l.platform === 'happymail' ? '18595' : '17098',
        intent: intent || 'reply', adjustNote: adjustNote || '',
        history: (l.chatHistory || []).slice(-12).map(function(m) { return { from: m.who === 'me' ? 'me' : 'peer', text: m.text, at: m.time }; })
      })
    });
    var d = await r.json();
    if (d.ok && d.ai && d.ai.replies && Array.isArray(d.ai.replies)) {
      l.ai = {
        analysis: (d.ai.analysis || '').slice(0, 300),
        strategy: (d.ai.strategy || '').slice(0, 300),
        recommendedKey: 'A',
        talks: d.ai.replies.slice(0, 4).map(function(rp, i) {
          var key = ['A', 'B', 'C', 'D'][i] || 'A';
          return { key: key, intent: rp.type || 'reply', textJp: rp.content, textZh: (rp.zh || ''), conf: 0.7 + i * 0.05 };
        })
      };
    } else if (d.ok && d.ai) {
      l.ai = d.ai;
    }
  } catch (e) { /* 降级 */ }
  // 后端没返回时用占位
  if (!l.ai || !l.ai.talks) l.ai = buildPlaceholderAi(l);
  render();
}

function buildPlaceholderAi(c) {
  var it = (c.customer && c.customer.interests && c.customer.interests.length) ? c.customer.interests : [];
  var first = it[0] || '';
  var talks = [
    { key: 'A', intent: '破冰·兴趣切入', textJp: first ? ('最近' + first + 'はよくやりますか？一緒にどうですか？') : 'この前の休日、何しましたか？', textZh: first ? ('最近常玩「' + first + '」吗？要一起吗？') : '上个休息日做了什么？', conf: 0.78 },
    { key: 'B', intent: '推进·线下', textJp: '今週末、少し会えますか？三重でいい場所知ってます。', textZh: '这周末见个面？我知道三重不错的地方。', conf: 0.62 },
    { key: 'C', intent: '轻唤回', textJp: first ? ('先日話した' + first + '、覚えてますか？') : '先日も話した事、覚えてますか？', textZh: first ? ('前几天聊的「' + first + '」还记得吗？') : '前几天聊的事还记得吗？', conf: 0.55 },
    { key: 'D', intent: '婉转', textJp: 'お疲れ様でした。ゆっくり休んでください。', textZh: '辛苦了，好好休息。', conf: 0.40 }
  ];
  var best = talks.reduce(function(b, t) { return t.conf > b.conf ? t : b; }, talks[0]);
  return {
    recommendedKey: best.key,
    analysis: c.lastMsg ? ('对方最后说：「' + c.lastMsg + '」→ ' + (it.length ? ('兴趣重合：' + it.slice(0, 3).join('/') + '，从兴趣切入最稳') : '暂无兴趣数据，建议软话题破冰')) : '（暂无聊天记录）',
    strategy: it.length ? ('从「' + it[0] + '」切入 → 推进线下 → 观察回复节奏') : '先软话题破冰，观察对方回复节奏再推进。',
    talks: talks
  };
}

// ============ 渲染 ============
function render() {
  if (!leadsLoaded) return;
  var l = leads[currentIdx];
  if (!l) { setEmpty(); return; }
  if (!l.ai || !l.ai.talks) l.ai = buildPlaceholderAi(l);
  renderLeft(l); renderMid(l); renderRight(l); renderQueue();
}

function setEmpty() {
  ['colLeft', 'colMid', 'colRight'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = '<div class="empty">（无候选——CDP 窗口未开或线索池为空）</div>';
  });
}

function renderLeft(l) {
  var el = document.getElementById('colLeft');
  var isHappy = l.platform === 'happymail';
  var interests = (l.customer.interests || []).map(function(x) { return '<span class="tag">' + x + '</span>'; }).join('');
  var avatar = '';
  if (l.customer.avatarUrls && l.customer.avatarUrls.length) {
    avatar = '<img src="' + l.customer.avatarUrls[0] + '" style="width:48px;height:48px;border-radius:8px;object-fit:cover;border:1px solid var(--border)" onerror="this.style.display=\'none\'">';
  } else {
    avatar = '<div style="width:48px;height:48px;border-radius:8px;background:var(--panel2);display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:11px">無写真</div>';
  }
  el.innerHTML =
    '<div class="plate"><h4>平台 / 撤回性</h4>'
    + '<span class="badge ' + l.platform + '">' + (isHappy ? '快乐 happymail' : '出会 ichigo') + '</span>'
    + '<span class="badge ' + (l.noRevoke ? 'no-revoke' : 'revoke') + '">' + (l.noRevoke ? '⚠ 出会·不可撤回' : '✓ 快乐·可撤回') + '</span>'
    + '<div style="font-size:10px;color:var(--muted);margin-top:5px">来源: ' + (l.source || '—') + '</div></div>'
    + '<div class="plate"><h4>客户</h4>'
    + '<div style="display:flex;gap:10px;align-items:center">' + avatar
    + '<div><div class="n">' + l.customer.name + '</div><div class="m">'
    + (l.customer.age ? l.customer.age + ' · ' : '') + (l.customer.city || '') + '</div></div></div>'
    + (l.onlineIcon ? '<div style="margin-top:6px;font-size:11px;color:var(--green)">● 在线(' + l.onlineIcon + ')</div>' : '')
    + '</div>'
    + '<div class="plate"><h4>兴趣重合</h4><div class="interests">' + (interests || '<span style="color:var(--muted);font-size:11px">（无兴趣数据）</span>') + '</div></div>'
    + '<div class="plate"><h4>我方人设（' + l.accountSelf.name + '）</h4>'
    + '<div class="m">' + l.accountSelf.age + '歳 · ' + l.accountSelf.city + '</div>'
    + '<div class="m" style="color:var(--purple)">' + l.accountSelf.traits + '</div></div>'
    + '<div class="plate"><h4>自己紹介</h4>'
    + '<p style="font-size:12px;line-height:1.5;color:var(--text)">' + (l.customer.selfIntro ? l.customer.selfIntro.slice(0, 200) : '<span style="color:var(--muted)">（无）</span>') + '</p></div>';
}

function renderMid(l) {
  var el = document.getElementById('colMid');
  var ai = l.ai || {};
  var chat = (l.chatHistory || []).slice(-5).map(function(m) {
    var who = (m.who === 'me' || m.dir === 'send') ? '私:' : '彼:';
    var jp = m.textJp || m.text || '';
    var zh = m.zh || m.textZh || '';
    var t = m.at || m.time || '';
    return '<div class="mline"><div class="jp">' + who + ' 「' + jp + '」</div>'
      + (zh ? '<div class="zh">' + zh + '</div>' : '')
      + (t ? '<div class="t">' + t + '</div>' : '') + '</div>';
  }).join('');
  el.innerHTML =
    '<div class="ai-box"><h5>🧠 心理分析</h5><p>' + (ai.analysis || '<span style="color:var(--muted)">按 4 键生成…</span>') + '</p></div>'
    + '<div class="ai-box"><h5>🎯 应对策略</h5><p>' + (ai.strategy || '<span style="color:var(--muted)">按 4 键生成…</span>') + '</p></div>'
    + '<div class="chat"><h5>💬 最近 5 轮对话（日原文 + 中译文）</h5>'
    + (chat ? chat : '<div style="color:var(--muted);font-size:11px;padding:10px;text-align:center">（暂无聊天记录——未开聊或无数据）</div>')
    + '</div>';
}

function renderRight(l) {
  var el = document.getElementById('colRight');
  var ai = l.ai || buildPlaceholderAi(l);
  var talks = (ai.talks || []).map(function(t) {
    return '<div class="talk ' + (l.selectedTalk === t.key ? 'sel' : '') + '" data-key="' + t.key + '">'
      + '<div class="head"><span class="key">' + t.key + '</span><span class="intent">' + (t.intent || 'reply') + '</span>'
      + '<span class="conf">conf ' + (t.conf != null ? t.conf : '-') + '</span></div>'
      + '<div class="jp">「' + t.textJp + '」</div>'
      + (t.textZh ? '<div class="zh">' + t.textZh + '</div>' : '')
      + '</div>';
  }).join('');
  el.innerHTML = '<div style="font-size:11px;color:var(--muted);margin-bottom:8px">💬 话术 A-D（日原文 + 中译文 · 按 A~D 入队滑卡）</div>'
    + (talks || '<div class="empty">（按 4 键生成话术）</div>')
    + '<div style="margin-top:10px;font-size:11px;color:var(--muted);line-height:1.8">'
    + '<kbd style="background:var(--panel2);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-size:10px">A</kbd>~'
    + '<kbd style="background:var(--panel2);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-size:10px">D</kbd> 选话术入待发送队列（20s±10s 浮动串行）'
    + '<br><kbd style="background:var(--panel2);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-size:10px">4</kbd> 重新生成 · '
    + '<kbd style="background:var(--panel2);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-size:10px">5</kbd> AI 对话微调</div>';
}

function renderQueue() {
  // 顶栏统计
  var active = queueItems.filter(function(q) { return q.status === 'queued' || q.status === 'pending'; });
  document.getElementById('qCount').textContent = active.length;
  var next = active[0];
  document.getElementById('qNext').textContent = next ? ('下条 ' + countdown(next.scheduledAt) + ' 后') : '';
  // 底部队列条
  var qbar = document.getElementById('qbar');
  qbar.innerHTML = active.slice(0, 6).map(function(q) {
    var l = leads.find(function(x) { return x.id === q.leadId; });
    var name = l ? l.customer.name : q.leadId;
    var cancelBtn = '<span class="cancel" onclick="cancelQueueItem(\'' + q.id + '\')">×</span>';
    var revokeBtn = (q.platform === 'happymail' && q.status === 'sent') ? '<span class="revoke" onclick="revokeQueueItem(\'' + q.id + '\')">↩撤回</span>' : '';
    return '<div class="qitem"><span>' + name + ' · 话术' + q.talkKey + '</span>'
      + '<span class="timer">' + countdown(q.scheduledAt) + '</span>' + cancelBtn + revokeBtn + '</div>';
  }).join('');
}

function countdown(ts) {
  if (!ts) return '-';
  var diff = new Date(ts) - Date.now();
  if (diff <= 0) return '0s';
  var s = Math.ceil(diff / 1000);
  return s + 's';
}

// 撤出队列(调后端 /card/send-queue/cancel)
function cancelQueueItem(id) {
  var q = queueItems.find(function(x) { return x.id === id; });
  if (!q) return;
  queueItems = queueItems.filter(function(x) { return x.id !== id; });
  renderQueue();
  fetch('/api/console/card/send-queue/cancel?id=' + encodeURIComponent(id), { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    .then(function(r) { return r.json(); }).then(function(d) {
      if (d && d.ok) { /* 已撤出 */ }
    }).catch(function() {});
}

// 快乐平台撤回(调后端 /card/send-queue/revoke)
function revokeQueueItem(id) {
  fetch('/api/console/card/send-queue/revoke?id=' + encodeURIComponent(id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result: 'user-revoke' }) })
    .then(function(r) { return r.json(); }).then(function(d) {
      if (d && d.ok) {
        var q = queueItems.find(function(x) { return x.id === id; });
        if (q) q.status = 'revoked';
        renderQueue();
      }
    }).catch(function() {});
}

// 加载后端队列快照
function loadQueueSnapshot() {
  fetch('/api/console/card/send-queue?status=pending&limit=50')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok && Array.isArray(d.queue)) {
        queueItems = d.queue.map(function(q) {
          return {
            id: q.queueId, leadId: q.conversationId, talkKey: q.talkIntent || '',
            talkText: q.talkText, scheduledAt: q.scheduledAt, status: q.status,
            platform: q.platform
          };
        });
        renderQueue();
      }
    }).catch(function() {});
}

// 窗口状态灯(轮询 /window/status, 90s 降频防 BitBrowser 限频)
function refreshWindows() {
  ['17098', '18595'].forEach(function(wid) {
    fetch('/api/console/window/status?windowId=' + wid)
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var el = document.getElementById('win' + wid);
        if (!el) return;
        var isOpen = d && (d.isOpen === true || d.open === true);
        el.className = 'win-pill ' + (isOpen ? 'open' : 'closed');
      }).catch(function() {});
  });
}
setInterval(refreshWindows, 90000); // 90s 降频(§9 BitBrowser 限频)

// 队列倒计时刷新(1s 一次)
setInterval(function() { renderQueue(); }, 1000);

// ============ 操作处理 ============
function selectTalk(idx, talkKey) {
  var l = leads[idx];
  if (!l || l.state === 'SENT' || l.state === 'BLOCKED') return;
  var talk = (l.ai && l.ai.talks ? l.ai.talks.find(function(t) { return t.key === talkKey; }) : null);
  if (!talk) { generateTalks(l, 'reply'); return; }
  l.selectedTalk = talkKey;
  l.state = 'DRAFTED';
  l.opLog.push({ op: 'select-talk', at: now(), note: '选 ' + talkKey + '「' + talk.textJp.slice(0, 12) + '…」' });
  // 入后端 SendQueue(20s±10s 浮动串行)
  enqueueToBackend(l, talk, talkKey);
  currentIdx = Math.min(idx + 1, leads.length - 1);
  render();
}

function enqueueToBackend(l, talk, talkKey) {
  fetch('/api/console/card/send-queue', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: l.id, platform: l.platform,
      accountId: l.platform === 'happymail' ? '18595' : '17098',
      contactKey: l.memberId || l.id,
      talkText: talk.textJp, talkZh: talk.textZh, talkIntent: talk.intent, talkConfidence: talk.conf
    })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.ok && d.queue) {
      queueItems.push({
        id: d.queue.queueId, leadId: l.id, talkKey: talkKey,
        talkText: talk.textJp, scheduledAt: d.queue.scheduledAt,
        status: d.queue.status, platform: l.platform
      });
      renderQueue();
    }
  }).catch(function() {});
}

function handleAction(idx, action) {
  var l = leads[idx];
  switch (action) {
    case '1':
      l.tags = l.tags || [];
      if (l.tags.indexOf('重点') === -1) l.tags.push('重点');
      l.opLog.push({ op: 'mark', at: now(), note: '标记为重点跟进' });
      render();
      break;
    case '2':
      pendingBlock = idx;
      document.getElementById('blockTargetName').textContent = l.customer.name + ' · ' + (l.customer.age || '');
      document.getElementById('blockOverlay').classList.add('show');
      break;
    case '3':
      l.state = 'SKIPPED';
      var qi = queueItems.findIndex(function(q) { return q.leadId === l.id && q.status !== 'sent' && q.status !== 'skipped'; });
      if (qi !== -1) queueItems.splice(qi, 1);
      l.opLog.push({ op: 'skip', at: now(), note: '跳过' });
      currentIdx = Math.min(idx + 1, leads.length - 1);
      render();
      break;
    case '4':
      generateTalks(l, 'reply', '');
      break;
    case '5':
      pendingAdjust = idx;
      document.getElementById('adjustNote').value = '';
      document.getElementById('adjustOverlay').classList.add('show');
      break;
    case '6':
      // 展开: 滚动到全部
      document.querySelectorAll('.col').forEach(function(c) { c.scrollTop = 0; });
      break;
  }
}

function confirmBlock() {
  if (pendingBlock === null) return;
  var l = leads[pendingBlock];
  l.state = 'BLOCKED';
  l.opLog.push({ op: 'block', at: now(), note: '拉黑 ' + l.customer.name });
  document.getElementById('blockOverlay').classList.remove('show');
  // 调后端 /card/block(落库 Contact.blacklisted + OperationLog)
  fetch('/api/console/card/block', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: l.id, contactId: l.memberId || l.id, platform: l.platform, accountId: l.platform === 'happymail' ? '18595' : '17098', reason: 'card-deck 2键拉黑' })
  }).catch(function() {});
  pendingBlock = null;
  currentIdx = Math.min(pendingBlock + 1, leads.length - 1);
  render();
}
function cancelBlock() {
  pendingBlock = null;
  document.getElementById('blockOverlay').classList.remove('show');
}

// 微调(5键)
function doAdjust() {
  if (pendingAdjust === null) return;
  var l = leads[pendingAdjust];
  var note = document.getElementById('adjustNote').value.trim();
  document.getElementById('adjustOverlay').classList.remove('show');
  generateTalks(l, 'reply', note);
  pendingAdjust = null;
}
function cancelAdjust() {
  document.getElementById('adjustOverlay').classList.remove('show');
  pendingAdjust = null;
}

// ============ 键盘快捷键 ============
document.addEventListener('keydown', function(e) {
  if (document.activeElement && /input|textarea/i.test(document.activeElement.tagName)) return;
  var k = e.key.toLowerCase();
  if (pendingBlock !== null) {
    if (k === 'y') { e.preventDefault(); confirmBlock(); }
    if (k === 'escape') { e.preventDefault(); cancelBlock(); }
    return;
  }
  if (pendingAdjust !== null) {
    if (k === 'escape') { e.preventDefault(); cancelAdjust(); }
    return;
  }
  switch (k) {
    case 'a': selectTalk(currentIdx, 'A'); e.preventDefault(); break;
    case 'b': selectTalk(currentIdx, 'B'); e.preventDefault(); break;
    case 'c': selectTalk(currentIdx, 'C'); e.preventDefault(); break;
    case 'd': selectTalk(currentIdx, 'D'); e.preventDefault(); break;
    case '1': handleAction(currentIdx, '1'); e.preventDefault(); break;
    case '2': handleAction(currentIdx, '2'); e.preventDefault(); break;
    case '3': handleAction(currentIdx, '3'); e.preventDefault(); break;
    case '4': handleAction(currentIdx, '4'); e.preventDefault(); break;
    case '5': handleAction(currentIdx, '5'); e.preventDefault(); break;
    case '6': handleAction(currentIdx, '6'); e.preventDefault(); break;
    case 'arrowright':
    case ' ': currentIdx = Math.min(currentIdx + 1, leads.length - 1); render(); e.preventDefault(); break;
    case 'arrowleft': currentIdx = Math.max(currentIdx - 1, 0); render(); e.preventDefault(); break;
  }
});

window.onerror = function(msg, src, line, col, err) {
  try {
    var el = document.getElementById('colMid');
    if (el) el.innerHTML = '<div style="padding:20px;color:#ef4444;font-family:monospace;font-size:12px">JS 错误: ' + msg + '</div>';
  } catch (_) {}
  console.error('[card-deck] onerror:', msg);
};

loadLeads();
