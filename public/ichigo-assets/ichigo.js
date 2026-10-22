// 第五刀 · ichigo.js（出会渲染 + 翻译核心，复制自 ichigo-console.html L956-1288/L2319-2350）
// 依赖：state.js(state/API/ONLINE) + util.js(esc/firstChar/timeRank/hasJa/prettyFields/findContact/toast)
// 跨模块：selectCustomer→aiHistRestore(aisay.js第7刀)、renderRecs/translateAll→翻译；调用点 typeof 保护。
'use strict';
import { state, API, ONLINE, QT_LANG } from './state.js';
import { esc, firstChar, timeRank, hasJa, prettyFields, findContact, toast } from './util.js';
import { isIchigoView } from './view.js';
import { updateBadge } from './nav-poll.js';
import { aiHistRestore } from './aisay.js'; // 第 8 刀收口：直接 import（aisay→state/util，无循环）
import { getCache, setCache } from './translate-cache.js'; // 模块2 · 双层翻译缓存池
import { getCache, setCache, cacheKey } from './translate-cache.js'; // 模块2 · 前端双层翻译缓存池

// 翻译缓存 + 计时器（原 L1083 区）
export var TMEMO = (function() { try { var r = localStorage.getItem('aisay-tmemo'); if (r) { var p = JSON.parse(r); if (p && typeof p === 'object') return p; } } catch (e) { console.warn('[ichigo] TMEMO 读取失败', e); } return {}; })();
var tmemoTimer = null;

// 客户列表渲染（复制自 L956）
export function renderList() {
  var host = document.getElementById('customerList');
  var cc = document.getElementById('custCount'); if (cc) cc.textContent = state.contacts.length;
  if (!state.contacts.length) { host.innerHTML = '<div class="empty" style="padding:20px;text-align:center">没有正在进行的消息记录<br><span style="font-size:10px;color:var(--muted)">（窗口可达 · 可点「📁 已归档」查看历史备份）</span></div>'; return; }
  var list = state.contacts.slice().sort(function(a, b) {
    var d = timeRank(b.lastMsgTime) - timeRank(a.lastMsgTime);
    if (d !== 0) return d;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  var html = '';
  list.forEach(function(c) {
    var active = state.selectedId === c.contactId ? ' active' : '';
    var od = ONLINE[c.onlineTier];
    var dot = od ? '<span class="od ' + od.cls + '" title="' + od.tip + '"></span>' : '<span class="od od-none" title="未知"></span>';
    var av = (c.avatarUrl && !c.avatarIsDefault)
      ? '<img src="' + esc(c.avatarUrl) + '" alt="">'
      : '<span class="av-txt">' + esc(firstChar(c.name)) + '</span>';
    var flags = '';
    if (c.blacklisted) flags += '<span class="ci-flag blacklisted" title="已拉黑">拉黑</span>';
    if (c.archived) flags += '<span class="ci-flag archived" title="已归档">归档</span>';
    var isArchivedCls = (c.archived || c.blacklisted || !c.inLiveInbox) ? ' is-archived' : '';
    html += '<div class="cust-item' + active + (c.unread > 0 ? ' unread' : '') + isArchivedCls + '" data-id="' + esc(c.contactId) + '">';
    html +=   '<div class="ci-top">';
    html +=     '<input type="checkbox" class="ci-check" data-cid="' + esc(c.contactId) + '" title="勾选后批量操作">';
    html +=     '<div class="ci-av">' + av + '</div>';
    html +=     '<div class="ci-main">';
    html +=       '<div class="ci-name">' + dot + esc(c.name) + flags + '</div>';
    html +=       '<div class="ci-last">' + esc((c.lastMsg || '').slice(0, 42)) + '</div>';
    html +=     '</div>';
    html +=     '<div class="ci-right">';
    html +=       '<div class="ci-time">' + esc(c.lastMsgTime || '') + '</div>';
    if (c.unread > 0) html += '<div class="ci-unread">新</div>';
    html +=     '</div>';
    html +=   '</div>';
    html += '</div>';
  });
  host.innerHTML = html;
  Array.prototype.forEach.call(host.querySelectorAll('.cust-item'), function(el) {
    el.addEventListener('click', function(e) {
      if (e.target && e.target.classList && e.target.classList.contains('ci-check')) return;
      selectCustomer(el.getAttribute('data-id'));
    });
  });
  host.onchange = function(e) {
    if (e.target && e.target.classList && e.target.classList.contains('ci-check')) {
      var item = e.target.closest('.cust-item');
      if (item) item.classList.toggle('selected', e.target.checked);
      if (typeof window.__onBatchSelectionChanged === 'function') window.__onBatchSelectionChanged();
    }
  };
}

// 选客户（复制自 L1019；竞态守卫 + aiHistRestore 跨模块保护）
export function selectCustomer(id) {
  state.selectedId = id;
  aiHistRestore(id); // 第 8 刀收口：直接 import 调用（无循环依赖）
  var c = findContact(id);
  if (!c) return;
  renderList();
  renderHeader(c);
  var d = state.details[id];
  if (d && d.messages) { renderMessages(d.messages); renderAnalysis(d.profile); renderRecs(d); }
  else {
    document.getElementById('msgList').innerHTML = '<div class="empty">加载中…</div>';
    document.getElementById('analysisList').innerHTML = '<div class="empty">加载中…</div>';
    document.getElementById('recReplies').innerHTML = '<div class="empty">加载中…</div>';
  }
  fetch(API.detail + '?id=' + encodeURIComponent(id) + '&read=1')
    .then(function(r) { return r.json(); })
    .then(function(j) {
      if (!j.ok || !j.contact) return;
      var ct = j.contact;
      state.details[id] = ct;
      var lc = findContact(id);
      if (lc) lc.unread = 0;
      if (!isIchigoView()) return; // H3 视图守卫：切快乐后会出 detail 不写出会 DOM
      renderList();
      updateBadge(); // 第 8 刀收口：直接 import 调用
      renderHeader(ct);
      renderMessages(ct.messages || []);
      renderAnalysis(ct.profile);
      renderRecs(ct);
    })
    .catch(function(e) { console.warn('detail failed', e); });
}

// 客户头（复制自 L1052）
export function renderHeader(c) {
  document.getElementById('msgCustName').textContent = c.name || '';
  var od = ONLINE[c.onlineTier];
  var bits = [];
  if (c.age) bits.push(c.age);
  if (od) bits.push(od.tip);
  if (c.lastMsgTime) bits.push('最近聊天 ' + c.lastMsgTime);
  document.getElementById('msgCustMeta').textContent = bits.join(' · ');
}

// 消息渲染（复制自 L1064；自动触发批量翻译）
export function renderMessages(msgs) {
  var host = document.getElementById('msgList');
  if (!msgs || !msgs.length) { host.innerHTML = '<div class="empty">暂无消息记录</div>'; return; }
  var html = '';
  msgs.forEach(function(m) {
    var cls = m.from === 'self' ? 'self' : 'peer';
    var who = m.from === 'self' ? '我方' : '客户';
    html += '<div class="msg-bubble ' + cls + '">';
    html +=   '<div class="who">' + who + '</div>';
    html +=   '<div class="text">' + esc(m.text).replace(/\n/g, '<br>') + '</div>';
    if (m.quote) html += '<div class="quote">引用：' + esc(m.quote).replace(/\n/g, ' ').slice(0, 80) + '</div>';
    if (hasJa(m.text)) html += '<div class="text-zh" data-src="' + esc(m.text) + '">译文加载中…</div>';
    html +=   '<div class="ts">' + esc(m.time || '') + (m.read ? ' · 已读' : '') + '</div>';
    html += '</div>';
  });
  host.innerHTML = html;
  host.scrollTop = host.scrollHeight;
  translateAll(host.querySelectorAll('.text-zh'));
}

// 翻译 memo 保存（复制自 L1089）
export function tmemoSave() {
  if (tmemoTimer) return;
  tmemoTimer = setTimeout(function() {
    tmemoTimer = null;
    try {
      var ks = Object.keys(TMEMO);
      if (ks.length > 4000) { var n = {}; ks.slice(-3000).forEach(function(k) { n[k] = TMEMO[k]; }); TMEMO = n; }
      localStorage.setItem('aisay-tmemo', JSON.stringify(TMEMO));
    } catch (e) { console.warn('[ichigo] TMEMO 保存失败', e); }
  }, 1200);
}

// 中文译文填回（复制自 L1100）
export function paintZh(el, entry) {
  if (!entry) return;
  el.textContent = entry.translated;
  var keep = String(el.className || '').split(/\s+/).filter(function(c) {
    return c && c !== 'text-zh' && c !== 'translated' && c !== 'dict';
  });
  keep.unshift('text-zh', 'translated');
  if (entry.source === 'dict-fallback') keep.push('dict');
  el.className = keep.join(' ');
}

// 缺失补翻（模块2 · 只补正在加载节点；已失败节点跳过，用户点重试才再发）
export function retryMissing(allNodes) {
  var pending = allNodes.filter(function(el) {
    if (el.getAttribute('data-failed')) return false; // 已失败的不自动补（用户点重试才发）
    var t = el.textContent || '';
    return t === '翻译中…' || t === '译文加载中…' || (t === '' && el.getAttribute('data-loading'));
  });
  if (!pending.length) return;
  var i = 0;
  function worker() {
    if (i >= pending.length) return Promise.resolve();
    var el = pending[i++];
    var src = el.getAttribute('data-src') || '';
    if (!src) { el.textContent = ''; return worker(); }
    if (TMEMO[src]) { paintZh(el, TMEMO[src]); return worker(); }
    return translate(src, 'ja', 'zh-CN').then(function(j) {
      if (j && j.ok) { TMEMO[src] = { translated: j.translated, source: j.source }; paintZh(el, TMEMO[src]); }
      else el.textContent = '（翻译失败）';
    }).catch(function() { el.textContent = '（翻译失败）'; }).then(worker);
  }
  var ws = [];
  for (var k = 0; k < 2; k++) ws.push(worker());
  return Promise.all(ws).then(function() { tmemoSave(); });
}

// 批量翻译（模块2 · 总控紧急修复：死锁 + 双层缓存 + 失败恢复原文）
// 渲染消息/常用语时优先查双层缓存（内存 Map + localStorage），命中瞬间回填；
// 未命中发请求自动写回两层。5s AbortController 超时 + try/catch + finally，
// 失败/超时立即退 Loading 态、恢复原文、标 data-failed 允许重试，杜绝永久卡死。
export function translateAll(nodes) {
  var arr = Array.prototype.slice.call(nodes);
  if (!arr.length) return Promise.resolve();
  var miss = [];
  var missSeen = {};
  arr.forEach(function(el) {
    var src = el.getAttribute('data-src') || '';
    // ① 双层缓存优先（内存 Map → localStorage）
    var hit = getCache(src, 'ja', 'zh-CN');
    if (hit && hit.translated) { paintZh(el, hit); return; }
    // 兼容老 TMEMO（迁移过渡）
    var m = TMEMO[src];
    if (m) { paintZh(el, m); setCache(src, 'ja', 'zh-CN', m); return; }
    // ② 未命中：显 Loading（带 data-loading，失败可精确恢复）
    el.textContent = '翻译中…';
    el.setAttribute('data-loading', '1');
    if (!missSeen[src]) { missSeen[src] = []; miss.push(src); }
    missSeen[src].push(el);
  });
  if (!miss.length) return Promise.resolve();
  // ③ 发批量请求：5s 硬超时（AbortController）
  var ctrl = new AbortController();
  var timer = setTimeout(function() { try { ctrl.abort(); } catch (_) {} }, 5000);
  var done = function() {
    clearTimeout(timer);
    // ④ 失败兜底：所有仍 Loading 且未标失败的节点恢复原文（杜绝"翻译中…"死锁）
    Object.keys(missSeen).forEach(function(t) {
      (missSeen[t] || []).forEach(function(el) {
        if (el.getAttribute('data-loading') && !el.getAttribute('data-failed')) {
          el.removeAttribute('data-loading');
          el.textContent = el.getAttribute('data-src') || '';
          el.classList.add('text-zh-failed');
          el.setAttribute('data-failed', '1');
          el.title = '翻译失败/超时，点原文可重试';
        }
      });
    });
    retryMissing(arr);
  };
  return fetch('/api/console/translate/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: miss.map(function(t) { return { text: t, from: 'ja', to: 'zh-CN' }; }) }),
    signal: ctrl.signal,
  }).then(function(r) { return r.json(); }).then(function(j) {
    clearTimeout(timer);
    if (j && j.ok && j.results) {
      Object.keys(j.results).forEach(function(t) {
        var e = j.results[t];
        var els = missSeen[t] || [];
        if (e && e.ok && e.translated) {
          TMEMO[t] = { translated: e.translated, source: e.source };
          setCache(t, 'ja', 'zh-CN', TMEMO[t]); // 自动写回双层缓存
          els.forEach(function(el) { paintZh(el, TMEMO[t]); el.removeAttribute('data-loading'); });
        } else {
          // 单条失败：恢复原文 + 标失败（不影响其他成功条目）
          els.forEach(function(el) {
            el.removeAttribute('data-loading');
            el.textContent = el.getAttribute('data-src') || '';
            el.classList.add('text-zh-failed');
            el.setAttribute('data-failed', '1');
            el.title = '翻译失败，点原文可重试';
          });
        }
      });
      tmemoSave();
    }
    done();
  }).catch(function() {
    done();
  });
}

// 模块2 · 失败重试：点失败节点 → 重新 translateAll（缓存未命中才会真发请求）
export function retryTranslate(el) {
  if (!el) return;
  el.removeAttribute('data-failed');
  el.classList.remove('text-zh-failed');
  translateAll([el]);
}

// 单条翻译（模块2 · 死锁修复 + 5s 超时 + 缓存优先）
// 返回 Promise<{ ok, translated, source, cached?, timeout? }>；失败/超时不 reject
export function translate(text, from, to, ctx) {
  from = from || 'ja'; to = to || 'zh-CN';
  // ① 双层缓存优先
  var hit = getCache(text, from, to);
  if (hit && hit.translated) return Promise.resolve({ ok: true, translated: hit.translated, source: hit.source, cached: true });
  // ② 未命中 → 发请求，5s 硬超时（AbortController）
  var ctrl = new AbortController();
  var timer = setTimeout(function() { try { ctrl.abort(); } catch (_) {} }, 5000);
  var qs = new URLSearchParams({ text: text, from: from, to: to });
  if (ctx && ctx.context) qs.set('context', ctx.context);
  if (ctx && ctx.personaId) qs.set('personaId', ctx.personaId);
  return fetch(API.translate + '?' + qs.toString(), { signal: ctrl.signal })
    .then(function(r) { return r.json(); })
    .then(function(j) {
      clearTimeout(timer);
      if (j && j.ok && j.translated) setCache(text, from, to, { translated: j.translated, source: j.source });
      return j || { ok: false };
    })
    .catch(function(e) {
      clearTimeout(timer);
      var timedOut = (e && e.name === 'AbortError');
      return { ok: false, timeout: !!timedOut, msg: timedOut ? '翻译超时（5s）' : String((e && e.message) || e) };
    });
}

// 画像分析渲染（复制自 L1224）
export function renderAnalysis(profile) {
  var host = document.getElementById('analysisList');
  if (!profile) { host.innerHTML = '<div class="empty">资料卡未抓取</div>'; return; }
  var html = '';
  var top = [];
  top.push({ k: '现居', v: profile.region ? (profile.region) : '—', hl: true });
  top.push({ k: '出身', v: (profile.birthplace || (profile.fields && profile.fields.birthplace)) || '—', hl: true });
  if (profile.ageNum) top.unshift({ k: '年龄', v: profile.ageNum + '岁', hl: false });
  if (profile.onlineText) top.push({ k: '在线', v: profile.onlineText, hl: false });
  html += '<div class="pf-top">' + top.map(function(t) {
    return '<div class="pf-top-row' + (t.hl ? ' hl' : '') + '"><span class="pk">' + t.k + '</span><span class="pv">' + esc(t.v) + '</span></div>';
  }).join('') + '</div>';
  var byGroup = profile.byGroup;
  var groups = [];
  if (byGroup && typeof byGroup === 'object' && Object.keys(byGroup).length) {
    var ORDER = ['基本情報', '見た目', '大人の交際', '生活', 'お相手に望むこと'];
    groups = ORDER.filter(function(g) { return byGroup[g] && byGroup[g].length; })
      .map(function(g) { return { title: g, items: byGroup[g] }; });
    Object.keys(byGroup).forEach(function(g) { if (ORDER.indexOf(g) === -1 && byGroup[g].length) groups.push({ title: g, items: byGroup[g] }); });
  } else if (profile.fields) {
    var LABELMAP = { birthplace: '出身地', marital: '交際ステータス', children: '子供', occupation: '職業', income: '年収', bloodType: '血液型', zodiac: '星座', carrier: 'キャリア', height: '身長', build: 'スタイル', type: 'タイプ', eyes: '目', dateWant: 'デートでしたいこと', meetingIntent: '出会うまでの希望', smoking: 'タバコ', drinking: 'お酒', car: '車', prefAge: '希望年齢', prefHeight: '希望身長', prefBuild: '希望スタイル', prefPersonality: '希望の見た目・性格' };
    var items = Object.keys(LABELMAP).filter(function(k) { return profile.fields[k]; }).map(function(k) {
      return { key: k, label: LABELMAP[k], value: profile.fields[k] };
    });
    if (items.length) groups = [{ title: '基本情報', items: items }];
  }
  html += groups.map(function(g) {
    return '<div class="pf-group">' +
        '<div class="pf-group-title">' + esc(g.title) + '</div>' +
        g.items.map(function(f) {
          return '<div class="pf-row"><span class="pk">' + esc(f.label) + '</span><span class="pv">' + prettyFields(f.key, f.value) + '</span></div>';
        }).join('') +
      '</div>';
  }).join('');
  var icons = profile.interestIcons || [];
  if (icons.length) {
    var labels = icons.map(function(i) {
      if (i && typeof i === 'object') return i.label || (i.icon ? ('未知(' + i.icon + ')') : '未知');
      return '未知(' + String(i) + ')';
    });
    html += '<div class="pf-group"><div class="pf-group-title">兴趣（' + icons.length + '）</div><div class="pf-row"><span class="pv">' + esc(labels.join('、')) + '</span></div></div>';
  }
  if (profile.bbsPosts && profile.bbsPosts.length) {
    html += '<div class="pf-group"><div class="pf-group-title">招募帖（' + profile.bbsPosts.length + '）</div>' +
      profile.bbsPosts.map(function(p) {
        return '<div class="pf-row"><span class="pv">' + esc((p.time || '') + ' ' + (p.content || '')) + '</span></div>';
      }).join('') + '</div>';
  }
  var empty = !top.length && !groups.length && !icons.length;
  host.innerHTML = empty ? '<div class="empty">资料解析为空</div>' : html;
}

// 推荐回复渲染（复制自 L1288；铁律 1 只填不发）
export function renderRecs(cust) {
  var host = document.getElementById('recReplies');
  var msgs = (cust && cust.messages) || [];
  if (!msgs.length) { host.innerHTML = '<div class="empty">无消息，无法生成推荐</div>'; return; }
  var lastPeer = null;
  for (var i = msgs.length - 1; i >= 0; i--) if (msgs[i].from === 'peer') { lastPeer = msgs[i]; break; }
  var lt = lastPeer ? (lastPeer.text || '') : '';
  var recs = [];
  if (/胸|カップ/.test(lt)) {
    recs.push('Dカップです。大きいですか？よかったら一度お会いしませんか？✨');
    recs.push('胸は大事ですよね！ゆっくりお話ししながら確認しましょう。よろしかったら近くで会いませんか？');
  } else if (/出会|会え/.test(lt)) {
    recs.push('まだいい出会いは見つかっていないです。よかったら一度お会いしませんか？');
    recs.push('出会いってタイミングですよね。ゆっくりお話ししながら、よかったらお会いしましょう。');
  } else if (/予算|いくら|金額/.test(lt)) {
    recs.push('ご予算はどのくらいでお考えですか？よかったら一度お会いしてお話ししましょう😊');
  } else {
    recs.push('ありがとうございます！ゆっくりお話しできたら嬉しいです。よかったらお会いしませんか？');
    recs.push('メッセージありがとうございます！もしよければ、一度お会いしませんか？');
  }
  if (cust.profile && cust.profile.interestIcons && cust.profile.interestIcons.length) {
    var i0 = cust.profile.interestIcons[0];
    if (i0 && i0.label) recs.push('「' + i0.label + '」お好きなんですね！私も興味あります😊 よかったらお話ししましょう。');
  }
  host.innerHTML = recs.map(function(r, i) {
    return '<div class="rec-reply" data-copy="' + i + '" title="点击复制到输入框">' +
      '<div class="text">' + esc(r) + '</div>' +
      '<div class="text-zh" data-src="' + esc(r) + '">翻译中…</div>' +
      '<div class="rec-foot"><span class="rec-copy-hint">📋 点击复制</span><span class="pending-tag">待确认 · 需点"确认发送"</span></div>' +
    '</div>';
  }).join('');
  translateAll(host.querySelectorAll('.text-zh'));
  Array.prototype.forEach.call(host.querySelectorAll('.rec-reply'), function(card) {
    card.addEventListener('click', function() {
      var t = recs[+card.getAttribute('data-copy')];
      var mi = document.getElementById('msgInput');
      if (mi) mi.value = t;
      var bs = document.getElementById('btnSend'); if (bs) bs.disabled = false;
      var pn = document.getElementById('pendingNote'); if (pn) pn.textContent = '已填入输入框，点"确认发送"发出';
      toast('已复制到输入框，请点「确认发送」');
    });
  });
}

// 快捷翻译方向渲染（复制自 L2319）
export function renderQtDir() {
  var dir = (state && state.qtDir) ? state.qtDir : 'ja2zh';
  var d = QT_LANG[dir] || QT_LANG['ja2zh'];
  var g = function(id) { return document.getElementById(id); };
  var a = g('qtFromLang'), b = g('qtToLang'), c = g('qtOutLabel'), s = g('qtSource'), t = g('qtTarget'), m = g('qtMeta');
  if (a) a.textContent = d.fromName;
  if (b) b.textContent = d.toName;
  if (c) c.textContent = d.toName + '（译文）';
  if (s) s.placeholder = '在这里输入' + d.fromName + '…';
  if (t) t.value = '';
  if (m) m.textContent = '';
}

// 快捷翻译（复制自 L2332）
export function doQt() {
  var src = document.getElementById('qtSource').value.trim();
  var tgt = document.getElementById('qtTarget');
  if (!src) { tgt.value = ''; var qm0 = document.getElementById('qtMeta'); if (qm0) qm0.textContent = ''; return; }
  var dir = (state && state.qtDir) ? state.qtDir : 'ja2zh';
  var d = QT_LANG[dir] || QT_LANG['ja2zh'];
  var memoKey = d.from + '|' + d.to + '|' + src;
  if (TMEMO[memoKey]) {
    tgt.value = TMEMO[memoKey].translated;
    var qm1 = document.getElementById('qtMeta'); if (qm1) qm1.textContent = '来源: ' + TMEMO[memoKey].source + '（本地缓存）';
    return;
  }
  tgt.value = '翻译中…';
  translate(src, d.from, d.to).then(function(j) {
    tgt.value = j.ok ? j.translated : (j.note || '翻译失败');
    var qm2 = document.getElementById('qtMeta'); if (qm2) qm2.textContent = j.ok ? ('来源: ' + j.source + (j.model ? ' · ' + j.model : '')) : (j.msg || '');
    if (j.ok) { TMEMO[memoKey] = { translated: j.translated, source: j.source }; tmemoSave(); }
  });
}
// 过渡桥接（第 5~7 刀保留，第 8 刀删）：老经典脚本的 window 版函数指向 module 实现