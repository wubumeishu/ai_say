// 第四刀 · view.js（视图切换 + 竞态守卫，复制自 ichigo-console.html L1468-1589）
// 最敏感模块：switchView 决定 5 列显隐 + 平台数据通道切换；竞态守卫 isIchigoView 防异步串扰。
// 并行副本原则：老内联 switchView/isIchigoView 一字不动；本文件是 module 副本。
// 第 8 刀收口：跨模块调用全部改为直接 import（无 window 桥，无 undefined 风险）。
'use strict';
import { state } from './state.js';
import { toast } from './util.js';
import { pollMailbox, renderAgentPage } from './nav-poll.js';
import { renderList, selectCustomer } from './ichigo.js';
import { renderHappyCustomers, loadHappyCustomer, happyRenderedMemberIDs } from './kairaku.js';
import { renderModelPage } from './models.js';

// 竞态守卫（复制自 L1333）：非出会视图下出会 fetch resolve 不写出会 DOM
export function isIchigoView() {
  var v = state ? state.currentView : '';
  return v === '17098' || v === 'ichigo' || v === 'kanban' || v === 'sessions';
}

// 视图切换（复制自 L1468-1589）：5 列显隐 + 平台分支（models/agents/kanban/kairaku/ichigo）
export function switchView(view) {
  if (state) state.currentView = view; // H3 缺陷 2 · 每次切视图更新 currentView
  var cols = {
    customers: document.getElementById('colCustomers'),
    messages: document.getElementById('colMessages'),
    analysis: document.getElementById('colAnalysis'),
    account: document.getElementById('colAccount'),
    ai: document.getElementById('colAi')
  };
  var mp = document.getElementById('modelPage');
  var ap = document.getElementById('agentPage');
  // 第 8 刀收口：直接 import 调用（无 window 桥）
  if (view === 'models') {
    cols.customers.style.display = 'none';
    cols.messages.style.display = 'none';
    cols.analysis.style.display = 'none';
    if (cols.account) cols.account.style.display = 'none';
    cols.ai.style.display = 'none';
    if (ap) ap.style.display = 'none';
    if (mp) mp.style.display = '';
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function(i) {
      i.classList.toggle('active', i.getAttribute('data-view') === view);
    });
    renderModelPage();
    return;
  }
  if (view === 'agents') {
    cols.customers.style.display = 'none';
    cols.messages.style.display = 'none';
    cols.analysis.style.display = 'none';
    if (cols.account) cols.account.style.display = 'none';
    cols.ai.style.display = 'none';
    if (ap) ap.style.display = '';
    if (mp) mp.style.display = 'none';
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function(i) {
      i.classList.toggle('active', i.getAttribute('data-view') === view);
    });
    renderAgentPage(); // nav-poll 同批次已迁移，直接 import 调用
    return;
  }
  if (view === 'kanban') {
    cols.messages.style.display = 'none';
    cols.analysis.style.display = 'none';
    if (cols.account) cols.account.style.display = 'none';
    cols.ai.style.display = 'none';
    if (ap) ap.style.display = 'none';
    if (mp) mp.style.display = 'none';
    cols.customers.style.display = '';
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function(i) {
      i.classList.toggle('active', i.getAttribute('data-view') === view);
    });
    renderList();
    return;
  }
  if (ap) ap.style.display = 'none';
  if (mp) mp.style.display = 'none';
  cols.analysis.style.display = '';
  if (cols.account) cols.account.style.display = '';
  cols.ai.style.display = '';
  var showAll = ['sessions', 'ichigo', '17098', 'kairaku', '18595'].indexOf(view) !== -1;
  cols.customers.style.display = showAll ? '' : 'none';
  cols.messages.style.display = showAll ? '' : 'none';
  if (view === 'kairaku' || view === '18595') {
    var kLoading = function() {
      return '<div class="empty" style="padding:24px;color:var(--muted,#888);font-size:12px">加载中…（连接 18595 窗口）…</div>';
    };
    var kDegraded = function(msg) {
      return '<div class="empty" style="padding:24px;color:#c0392b;font-size:12px">' + msg + '</div>';
    };
    var cl = document.getElementById('customerList');
    var ml = document.getElementById('msgList');
    var al = document.getElementById('analysisList');
    var rr = document.getElementById('recReplies');
    if (cl) cl.innerHTML = kLoading();
    if (ml) ml.innerHTML = kDegraded('');
    if (al) al.innerHTML = '';
    if (rr) rr.innerHTML = '';
    // 切进快乐视图：重置已渲染集合（第 8 刀收口：直接改 module 导出变量，无 window 桥）
    for (var k in happyRenderedMemberIDs) delete happyRenderedMemberIDs[k];
    fetch('/api/console/happy/inbox?force=1&expand=1') // H4 缺陷6 · 切进快乐视图默认全量拉（expand=1）；「加载更多」保留兜底
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.ok) {
          if (cl) cl.innerHTML = kDegraded('18595 窗口未连接（请确认窗口已开），暂无法加载快乐数据：' + (d.reason || d.msg || ''));
          return;
        }
        renderHappyCustomers(d.contacts || []); // 第 8 刀收口：直接 import 调用
        if (d.unread) { var b = document.getElementById('navBadgeKairaku'); if (b) b.textContent = String(d.unread); }
        // H4 缺陷6 C 项 · 切进快乐视图自动 brief：右侧先占最近活跃客户的详情 + 气泡聊天（不等手点客户）
        fetch('/api/console/happy/inbox/brief').then(function(r) { return r.json(); }).then(function(bd) {
          if (!bd || bd.empty) {
            var mlB = document.getElementById('msgList');
            if (mlB && !mlB.querySelector('.msg-bubble')) {
              mlB.innerHTML = '<div class="empty" style="padding:24px;color:var(--muted,#888);font-size:12px">暂无活跃会话</div>';
            }
            return;
          }
          var mIdB = (bd.contact && (bd.contact.memberID || bd.contact.id)) || '';
          var mailIdB = (bd.contact && bd.contact.mailID) || '';
          if (mIdB) {
            loadHappyCustomer(mIdB, null, mailIdB); // 第 8 刀收口：直接 import 调用
          }
        }).catch(function(e) { console.warn('[happyBrief] 自动占位失败', e); });
      })
      .catch(function(e) { if (cl) cl.innerHTML = kDegraded('快乐数据加载失败：' + (e && e.message || e)); });
  } else if (view === '17098' || view === 'ichigo') {
    try {
      var cl = document.getElementById('customerList');
      var ml = document.getElementById('msgList');
      var al = document.getElementById('analysisList');
      var rr = document.getElementById('recReplies');
      [cl, ml, al, rr].forEach(function(el) { if (el && el.innerHTML.indexOf('H4 接入') !== -1) { el.innerHTML = ''; } });
      [cols.customers, cols.messages, cols.analysis].forEach(function(el) { if (el && el.innerHTML.indexOf('H4 接入') !== -1) { el.innerHTML = ''; } });
      pollMailbox(true); // nav-poll 同批次已迁移，直接调用
      if (state && state.selectedId) {
        selectCustomer(state.selectedId);
      } else { renderList(); }
    } catch (e) { console.warn('[switchView] 出会视图恢复失败', e); }
  }
  Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function(i) {
    i.classList.toggle('active', i.getAttribute('data-view') === view);
  });
  if (view === '18595' || view === 'kairaku') {
    if (view === '18595') toast('已选快乐平台窗口 18595（H4 只读抓取已激活）', true);
    try { localStorage.setItem('aisay:platform:v1', 'kairaku'); } catch (e) { console.warn('platform save failed', e); }
  } else if (view === '17098' || view === 'ichigo') {
    try { localStorage.setItem('aisay:platform:v1', 'ichigo194964'); } catch (e) { console.warn('platform save failed', e); }
  }
}

// 过渡桥接（第 4~7 刀保留，第 8 刀删）：老经典脚本的 switchView/isIchigoView 由 module 桥接管