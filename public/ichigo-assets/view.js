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
import { renderAgentPkgPage } from './agent-pkg.js';
import { renderDomainPage, loadAccountPool, loadToolbox, loadLeads } from './domain.js';

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
  var apk = document.getElementById('agentPkgPage');
  // 跨列页显隐：showWhich ∈ { 'agentPkgPage', 'modelPage', 'agentPage', null }，其余全隐藏
  function setCrossPages(showWhich) {
    var map = { agentPkgPage: apk, modelPage: mp, agentPage: ap };
    var domP = document.getElementById('domainPage');
    if (domP) domP.style.display = 'none';
    Object.keys(map).forEach(function (k) {
      var el = map[k];
      if (el) el.style.display = (k === showWhich) ? '' : 'none';
    });
  }
  // 第 8 刀收口：直接 import 调用（无 window 桥）
  if (view === 'agentPkg') {
    var _dp_agentPkg = document.getElementById('domainPage'); if (_dp_agentPkg) _dp_agentPkg.style.display = 'none';
    cols.customers.style.display = 'none';
    cols.messages.style.display = 'none';
    cols.analysis.style.display = 'none';
    if (cols.account) cols.account.style.display = 'none';
    cols.ai.style.display = 'none';
    setCrossPages('agentPkgPage');
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function(i) {
      i.classList.toggle('active', i.getAttribute('data-view') === view);
    });
    renderAgentPkgPage();
    return;
  }
  if (view === 'models') {
    var _dp_models = document.getElementById('domainPage'); if (_dp_models) _dp_models.style.display = 'none';
    cols.customers.style.display = 'none';
    cols.messages.style.display = 'none';
    cols.analysis.style.display = 'none';
    if (cols.account) cols.account.style.display = 'none';
    cols.ai.style.display = 'none';
    setCrossPages('modelPage');
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function(i) {
      i.classList.toggle('active', i.getAttribute('data-view') === view);
    });
    renderModelPage();
    return;
  }
  if (view === 'agents') {
    var _dp_agents = document.getElementById('domainPage'); if (_dp_agents) _dp_agents.style.display = 'none';
    cols.customers.style.display = 'none';
    cols.messages.style.display = 'none';
    cols.analysis.style.display = 'none';
    if (cols.account) cols.account.style.display = 'none';
    cols.ai.style.display = 'none';
    setCrossPages('agentPage');
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function(i) {
      i.classList.toggle('active', i.getAttribute('data-view') === view);
    });
    renderAgentPage(); // nav-poll 同批次已迁移，直接 import 调用
    return;
  }
  if (view === 'cards') {
    cols.customers.style.display = 'none';
    cols.messages.style.display = 'none';
    cols.analysis.style.display = 'none';
    if (cols.account) cols.account.style.display = 'none';
    cols.ai.style.display = 'none';
    setCrossPages(null);
    var _cpOff = document.getElementById('cardPage'); if (_cpOff) _cpOff.style.display = 'none';
    var domPage = document.getElementById('domainPage'); if (domPage) domPage.style.display = 'none';
    var cardPage = document.getElementById('cardPage');
    if (cardPage) cardPage.style.display = '';
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function(i) {
      i.classList.toggle('active', i.getAttribute('data-view') === view);
    });
    // cardflow ESM 异步 import 可能未就绪 → 轮询直到 window.__cardflow 存在(最多 8s)
    // 自愈: 之前 import 失败(__cardflowError) 时, 切进来就清掉 error + 重新带缓存破坏参数 import 一次
    if (!window.__cardflow && window.__cardflowError) {
      try {
        delete window.__cardflowError;
        import('/ichigo-assets/cardflow.js?_t=' + Date.now()).then(function(m) {
          window.__cardflow = m;
          // 重新进入卡片流(触发已挂好的 __cardflow)
          if (typeof switchView === 'function') switchView('cards');
        }).catch(function(e) { window.__cardflowError = String((e && e.message) || e); });
      } catch (_) { /* ignore */ }
    }
    var cfRoot = document.getElementById('cardPage');
    if (cfRoot && !window.__cardflowError) {
      cfRoot.innerHTML = '<div class="cf-main"><div style="text-align:center;padding:60px;color:var(--muted,#8b8fa3);font-size:13px">⏳ 卡片流加载中…（拉取候选）</div></div>';
    } else if (cfRoot && window.__cardflowError) {
      cfRoot.innerHTML = '<div class="cf-main"><div style="text-align:center;padding:50px;color:#ef4444;font-size:13px">卡片流模块加载失败: ' + window.__cardflowError + '<br><span style="color:var(--muted,#8b8fa3);font-size:12px">重新进入卡片流或 Ctrl+Shift+R 强刷可重试</span></div></div>';
    }
    var _cfRetry = 0;
    (function tryCf(n) {
      var cf = window.__cardflow;
      if (cf) {
        cf.startQueueTick();
        cf.loadLeads();
        return;
      }
      // 页面整合脚本已标记加载失败 → 直接显示原因(不再干等 8s)
      if (window.__cardflowError) {
        if (cfRoot) cfRoot.innerHTML = '<div class="cf-main"><div style="text-align:center;padding:60px;color:#ef4444;font-size:13px">卡片流模块加载失败: ' + window.__cardflowError + '</div></div>';
        return;
      }
      if (n <= 0) {
        // 8s 内 __cardflow 没挂上 → 试一次浏览器侧自救: 重新动态 import(清顽固缓存场景)
        if (_cfRetry === 0) {
          _cfRetry = 1;
          try {
            import('/ichigo-assets/cardflow.js?t=' + Date.now()).then(function(m) {
              window.__cardflow = m;
              if (m.startQueueTick) m.startQueueTick();
              if (m.loadLeads) m.loadLeads();
              if (cfRoot) cfRoot.innerHTML = '';
            }).catch(function(err) {
              if (cfRoot) cfRoot.innerHTML = '<div class="cf-main"><div style="text-align:center;padding:60px;color:#ef4444;font-size:13px">卡片流模块加载失败: ' + String((err && err.message) || err) + '<br><span style="color:var(--muted,#8b8fa3);font-size:12px">仍失败请 Ctrl+Shift+R 强刷, 或检查 /ichigo-assets/cardflow.js 是否 200</span></div></div>';
            });
          } catch (_) {
            if (cfRoot) cfRoot.innerHTML = '<div class="cf-main"><div style="text-align:center;padding:60px;color:#e07b39;font-size:13px">卡片流模块未加载（cardflow.js 未注入 window.__cardflow）。请强刷（Ctrl+Shift+R）。</div></div>';
          }
        } else {
          if (cfRoot) cfRoot.innerHTML = '<div class="cf-main"><div style="text-align:center;padding:60px;color:#e07b39;font-size:13px">卡片流模块未加载（cardflow.js 未注入 window.__cardflow）。请强刷（Ctrl+Shift+R）。</div></div>';
        }
        return;
      }
      setTimeout(function() { tryCf(n - 1); }, 500);
    })(16); // 16 次 × 500ms = 8s
    return;
  }
  var domainViews = ['domain', 'domain-ashiato', 'domain-faces', 'domain-search', 'domain-ignore', 'domain-calendar', 'domain-toolbox', 'domain-pool', 'domain-diary', 'domain-unified', 'domain-leads', 'domain-profiles', 'domain-persona'];
  if (domainViews.indexOf(view) !== -1) {
    cols.customers.style.display = 'none';
    cols.messages.style.display = 'none';
    cols.analysis.style.display = 'none';
    if (cols.account) cols.account.style.display = 'none';
    cols.ai.style.display = 'none';
    setCrossPages(null);
    var _cpOff = document.getElementById('cardPage'); if (_cpOff) _cpOff.style.display = 'none';
    var domPage = document.getElementById('domainPage');
    if (domPage) domPage.style.display = '';
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function(i) {
      i.classList.toggle('active', i.getAttribute('data-view') === view);
    });
    renderDomainPage(view);
    return;
  }
  if (view === 'kanban') {
    var _dp0 = document.getElementById('domainPage'); if (_dp0) _dp0.style.display = 'none';
    cols.messages.style.display = 'none';
    cols.analysis.style.display = 'none';
    if (cols.account) cols.account.style.display = 'none';
    cols.ai.style.display = 'none';
    setCrossPages(null);
    var _cpOff = document.getElementById('cardPage'); if (_cpOff) _cpOff.style.display = 'none';
    cols.customers.style.display = '';
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function(i) {
      i.classList.toggle('active', i.getAttribute('data-view') === view);
    });
    renderList();
    return;
  }
  setCrossPages(null);
    var _cpOff = document.getElementById('cardPage'); if (_cpOff) _cpOff.style.display = 'none';
  var _dp1 = document.getElementById('domainPage'); if (_dp1) _dp1.style.display = 'none';
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
    // 恢复出会五列(客户/消息/画像/账号/AI) + 隐藏卡片流/全域 overlay(防 z-index:100 盖住中间列)
    cols.messages.style.display = '';
    cols.analysis.style.display = '';
    if (cols.account) cols.account.style.display = '';
    cols.ai.style.display = '';
    var _cpOn = document.getElementById('cardPage'); if (_cpOn) _cpOn.style.display = 'none';
    var _dpOn = document.getElementById('domainPage'); if (_dpOn) _dpOn.style.display = 'none';
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
  // 防回归：未知 view 不再静默（未来加视图忘接 switchView 时会告警）
  var knownViews = ['kanban', 'sessions', 'ichigo', '17098', 'kairaku', '18595', 'models', 'agents', 'agentPkg'];
  if (knownViews.indexOf(view) === -1) console.warn('[switchView] 未知视图未处理:', view, '（确认 switchView 已加对应分支）');
}

// 过渡桥接（第 4~7 刀保留，第 8 刀删）：老经典脚本的 switchView/isIchigoView 由 module 桥接管