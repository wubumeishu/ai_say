// 第六刀 · kairaku.js（快乐渲染，复制自 ichigo-console.html L1340-1459）
// 依赖：util.js(escapeHtml) + state.js + ichigo.js(translateAll) + view.js(isIchigoView)
'use strict';
import { escapeHtml, toast, hasJa } from './util.js';
import { translateAll } from './ichigo.js'; // H4 缺陷6 · 复用出会翻译（TMEMO 本地缓存 /api/console/translate/batch 批量回填）
import { isIchigoView } from './view.js'; // H4 缺陷6 · 视图守卫（快乐数据不串出会）
import { state } from './state.js'; // 第 8 刀收口：直接 import state

// 已渲染 memberID 集合（追加去重；第 8 刀收口：module 独占，无 window 桥）
export var happyRenderedMemberIDs = {};

// 快乐客户列表渲染（复制自 L1340；追加模式 + 加载更多）
export function renderHappyCustomers(list, more) {
  var cl = document.getElementById('customerList');
  if (!cl) return;
  if (!Array.isArray(list) || !list.length) {
    if (!more) cl.innerHTML = '<div class="empty" style="padding:24px;color:var(--muted,#888);font-size:12px">收件箱无客户（18595 窗口数据为空）</div>';
    return;
  }
  var htm = '';
  var addedCount = 0;
  list.forEach(function(c) {
    var nm = c.name || c.memberID || '(未命名)';
    var ym = c.yearMarket ? c.yearMarket : '';
    var last = c.lastMessage ? c.lastMessage.slice(0, 40) : '';
    var tm = c.lastTime ? c.lastTime : '';
    var mId = c.memberID || '';
    var mailId = c.mailID || '';
    if (mId) happyRenderedMemberIDs[mId] = true;
    addedCount++;
    htm += '<div class="cust-card" data-happy="' + encodeURIComponent(mId + '|' + mailId) + '" style="padding:10px;border-bottom:1px solid var(--line,#333);cursor:pointer">'
      + '<div style="font-size:14px;font-weight:600">' + escapeHtml(nm) + (ym ? ' <span style="color:var(--muted,#888);font-weight:400;font-size:12px">' + escapeHtml(ym) + '</span>' : '') + '</div>'
      + (last ? '<div style="font-size:12px;color:var(--muted,#888);margin-top:4px">' + escapeHtml(last) + '</div>' : '')
      + (tm ? '<div style="font-size:11px;color:var(--muted,#888);margin-top:2px">' + escapeHtml(tm) + '</div>' : '')
      + '</div>';
  });
  htm += '<div class="happy-load-more" style="padding:12px;text-align:center;cursor:pointer;color:#3b82f6;font-size:12px">加载更多客户…</div>';
  htm += '<div class="empty" style="padding:8px;color:var(--muted,#888);font-size:11px" id="happyLoadHint">收件箱未读数见左侧（共 N 位，已加载 M 位）</div>';
  cl.innerHTML = htm;

  // 绑定客户点按 → 拉详情（带 mailID）
  Array.prototype.forEach.call(cl.querySelectorAll('.cust-card[data-happy]'), function(card) {
    card.addEventListener('click', function() {
      var raw = decodeURIComponent(card.getAttribute('data-happy') || '');
      var segs = raw.split('|');
      var mId = segs[0] || '';
      var mailId = segs[1] || '';
      loadHappyCustomer(mId, card, mailId);
    });
  });
  // 绑定「加载更多」按钮 → /happy/inbox?more=1 拉全量追加
  var moreBtn = cl.querySelector('.happy-load-more');
  if (moreBtn) {
    moreBtn.addEventListener('click', function() {
      moreBtn.textContent = '加载中…';
      moreBtn.style.pointerEvents = 'none';
      fetch('/api/console/happy/inbox?more=1&force=1')
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.ok && Array.isArray(d.contacts)) {
            renderHappyCustomers(d.contacts, true);
            var hint = document.getElementById('happyLoadHint');
            if (hint) hint.textContent = '已加载 ' + Object.keys(happyRenderedMemberIDs).length + ' 位客户（未读数见左侧 nav）';
          } else {
            moreBtn.textContent = '加载更多失败：' + (d.reason || d.msg || '未知');
            moreBtn.style.color = '#c0392b';
          }
        })
        .catch(function(e) { moreBtn.textContent = '加载失败：' + (e && e.message || e); moreBtn.style.color = '#c0392b'; });
    });
  }
}

// 点快乐客户 → /happy/inbox/customer?id={memberID}&mailID={mailID}（复制自 L1409）
export function loadHappyCustomer(mId, cardEl, mailId) {
  // H4 缺陷6 · 视图守卫：当前非快乐视图（出会/看板等）→ 不写快乐 DOM（防切出会时快乐 fetch resolve 串出会数据）
  var cv = (state && state.currentView) || '';
  if (cv !== 'kairaku' && cv !== '18595') { return; }
  var ml = document.getElementById('msgList');
  var al = document.getElementById('analysisList');
  var rr = document.getElementById('recReplies');
  if (ml) ml.innerHTML = '<div class="empty" style="padding:24px;color:var(--muted,#888);font-size:12px">加载会话中…</div>';
  if (al) al.innerHTML = '';
  if (rr) rr.innerHTML = '';
  if (cardEl) cardEl.style.background = 'rgba(80,120,200,0.15)';
  var happyQs = 'id=' + encodeURIComponent(mId) + (mailId ? '&mailID=' + encodeURIComponent(mailId) : '');
  fetch('/api/console/happy/inbox/customer?' + happyQs)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.ok) {
        if (ml) ml.innerHTML = '<div class="empty" style="padding:24px;color:#c0392b;font-size:12px">客户数据加载失败：' + (d.reason || d.msg || '') + '</div>';
        return;
      }
      if (al) {
        var fields = (d.profile && d.profile.fields) || {};
        var ks = Object.keys(fields);
        if (ks.length) {
          al.innerHTML = '<div style="padding:8px;font-size:12px">' + ks.map(function(k) {
            return '<div style="margin:4px 0"><span style="color:var(--muted,#888)">' + escapeHtml(k) + '</span>：' + escapeHtml(String(fields[k] || '')) + '</div>';
          }).join('') + '</div>';
        } else if (d.contact && d.contact.name) {
          al.innerHTML = '<div style="padding:8px;font-size:12px">' + escapeHtml(d.contact.name) + '（详情字段暂缺）</div>';
        }
      }
      if (ml) {
        var ms = Array.isArray(d.messages) ? d.messages : [];
        if (ms.length) {
          // H4 缺陷6 · 聊天区改出会同款 .msg-bubble 气泡（self/peer 对齐出会 renderMessages L1064 的 who/正文/text-zh/ts 已读 4 段）
          ml.innerHTML = ms.map(function(m) {
            var mine = m.role === 'self';
            var cls = mine ? 'self' : 'peer';
            var who = mine ? '我方' : '客户';
            var h = '<div class="msg-bubble ' + cls + '">';
            h += '<div class="who">' + who + '</div>';
            h += '<div class="text">' + escapeHtml(m.text || '').replace(/\n/g, '<br>') + '</div>';
            // 日文明言自动插「译文加载中…」(.text-zh data-src) → translateAll 批量回填（复用出会 TMEMO 本地缓存）
            if (hasJa(m.text)) h += '<div class="text-zh" data-src="' + escapeHtml(m.text) + '">译文加载中…</div>';
            h += '<div class="ts">' + escapeHtml(m.time || '') + (m.readReceipt ? ' · 已读' : '') + '</div>';
            h += '</div>';
            return h;
          }).join('');
          // 滚到底 + 批量翻译回填（TMEMO 命中秒填，未命中走 /api/console/translate/batch）
          ml.scrollTop = ml.scrollHeight;
          translateAll(ml.querySelectorAll('.text-zh'));
        } else {
          ml.innerHTML = mailId
            ? '<div class="empty" style="padding:24px;color:var(--muted,#888);font-size:12px">该客户暂无历史消息</div>'
            : '<div class="empty" style="padding:24px;color:var(--muted,#888);font-size:12px">暂无会话（该客户无 mailID，无法拉历史）</div>';
        }
      }
      if (rr) rr.innerHTML = '<div class="empty" style="padding:24px;color:var(--muted,#888);font-size:12px">快乐推荐回复（H5 接入 talkEngine）</div>';
    })
    .catch(function(e) { if (ml) ml.innerHTML = '<div class="empty" style="padding:24px;color:#c0392b;font-size:12px">请求失败：' + (e && e.message || e) + '</div>'; });
}

// 过渡桥接（第 6~7 刀保留，第 8 刀删）