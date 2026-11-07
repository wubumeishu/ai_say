// 第 8 刀 · main.js（入口模块：事件绑定 + 初始化编排）
// 替代老经典脚本 L737-2962 的全部职责；单一数据源 = state.js 导出的 state（含 qtDir）
// 无 window 桥、无 __AISAY__、无 globalThis 挂载
'use strict';
import { state, API, POLL_MS } from './state.js';
import { toast, findContact } from './util.js';
import { getTheme, applyTheme, toggleTheme } from './theme.js';
import { safeInit, loadPlatforms, pollMailbox, refreshNetChip, renderAgentPage, rotateIp, updateBadge } from './nav-poll.js';
import { switchView } from './view.js';
import { renderHeader, renderMessages, renderQtDir, doQt, renderAnalysis, renderRecs } from './ichigo.js';
import { openModelForm, closeModelForm, saveModelForm, testModelForm } from './models.js';
import { loadAccount, bindAccountEvents } from './accounts.js';
import { loadPhrases } from './phrases.js';
import { aiHistRestore, aiHistNewSession, aiHistClear, openAiHistPop, closeAiHistPop, bindAiHistPopDismiss, bindAiChips, askAssistantCore } from './aisay.js';
import { initBatchBar } from './batch.js'; // 模块 1 · 出会批量操作栏

// ---- 事件绑定（复制自老经典脚本 L2215-2364，全部改指 module 函数）----
function bindEvents() {
  var btnRotate = document.getElementById('btnRotateIp');
  if (btnRotate) btnRotate.addEventListener('click', function() { rotateIp(); });

  document.getElementById('btnSend').addEventListener('click', function() {
    var t = document.getElementById('msgInput').value.trim();
    if (!t) return;
    document.getElementById('btnSend').disabled = true;
    document.getElementById('pendingNote').textContent = '待确认：' + t.slice(0, 30) + '…';
    toast('已填入，点"确认发送"才真正发出');
  });

  document.getElementById('btnConfirm').addEventListener('click', function() {
    var t = document.getElementById('msgInput').value.trim();
    if (!t) { toast('没有可发送的内容', false); return; }
    if (!state.selectedId) { toast('请先选择客户', false); return; }
    var c = findContact(state.selectedId);
    if (!c || !c.contactId) { toast('客户数据缺失，无法发送', false); return; }
    document.getElementById('pendingNote').textContent = '正在真发 → ' + (c.name || c.contactId) + ' …';
    document.getElementById('btnConfirm').disabled = true;
    fetch(API.sendLive, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId: c.contactId, name: c.name, text: t })
    })
    .then(function(r) { return r.json(); })
    .then(function(j) {
      document.getElementById('btnConfirm').disabled = false;
      if (j.ok && j.data && j.data.sent) {
        document.getElementById('pendingNote').textContent = '已发送给 ' + (c.name || c.contactId) + ' · ' + new Date().toLocaleTimeString();
        document.getElementById('msgInput').value = '';
        document.getElementById('btnSend').disabled = true;
        toast('已发送 ✓（已返回收件箱）', true);
        fetch(API.detail + '?id=' + encodeURIComponent(c.contactId) + '&read=1&force=1')
          .then(function(r2) { return r2.json(); })
          .then(function(j2) {
            if (j2.ok && j2.contact) {
              state.details[c.contactId] = j2.contact;
              var lc = findContact(c.contactId);
              if (lc) { lc.unread = 0; lc.lastMsg = j2.contact.lastMsg || lc.lastMsg; }
              renderMessages(j2.contact.messages || []);
              renderHeader(j2.contact);
              updateBadge();
            }
          })
          .catch(function() { /* 刷新失败不影响发送结果 */ });
      } else {
        document.getElementById('pendingNote').textContent = '发送失败：' + ((j.data && (j.data.reason || j.data.msg)) || j.msg || '未知');
        toast('发送失败：' + ((j.data && (j.data.reason || j.data.msg)) || j.msg || '未知'), false);
      }
    })
    .catch(function(e) {
      document.getElementById('btnConfirm').disabled = false;
      document.getElementById('pendingNote').textContent = '发送请求失败：' + e.message;
      toast('发送请求失败', false);
    });
  });

  document.getElementById('btnRefresh').addEventListener('click', function() {
    if (!state.selectedId) { toast('请先选择客户'); return; }
    toast('正在重抓历史 + 资料…');
    fetch(API.refresh + '?id=' + encodeURIComponent(state.selectedId), { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(j) {
        if (j.ok && j.contact) {
          state.details[state.selectedId] = j.contact;
          renderMessages(j.contact.messages || []);
          renderAnalysis(j.contact.profile);
          renderRecs(j.contact);
          toast('已刷新：' + (j.fetched || []).join(' + '), true);
        } else toast('刷新失败', false);
      }).catch(function() { toast('刷新失败', false); });
  });

  document.getElementById('btnBbs').addEventListener('click', function() {
    var d = state.details[state.selectedId];
    var bbs = d && d.profile && d.profile.bbsPosts;
    if (bbs && bbs.length) {
      alert('招募帖：\n' + bbs.map(function(p) { return (p.time || '') + ' ' + (p.content || ''); }).join('\n'));
    } else toast('该客户暂无招募帖');
  });

  document.getElementById('btnTranslate').addEventListener('click', function() {
    var t = document.getElementById('msgInput').value.trim();
    if (!t) return;
    document.getElementById('qtSource').value = t;
    doQt();
  });

  document.getElementById('btnQtGo').addEventListener('click', doQt);
  document.getElementById('qtSwap').addEventListener('click', function() {
    state.qtDir = (state.qtDir === 'ja2zh') ? 'zh2ja' : 'ja2zh'; // 第 8 刀：qtDir 存 state
    renderQtDir();
  });
  // 输入自动翻译（防抖 600ms）
  var qtTimer = null;
  document.getElementById('qtSource').addEventListener('input', function() {
    clearTimeout(qtTimer);
    qtTimer = setTimeout(function() {
      if (document.getElementById('qtSource').value.trim().length >= 2) doQt();
    }, 600);
  });
  renderQtDir();

  // ---- Ai SAY 助手面板 ----
  // 自由问答（回车/发送按钮）
  function askAssistant() {
    var t = document.getElementById('aiInput').value.trim();
    if (!t) return;
    document.getElementById('aiInput').value = '';
    return askAssistantCore(t, null);
  }

  document.getElementById('btnAiSend').addEventListener('click', function() { askAssistant(); });
  var aiClearBtn = document.getElementById('btnAiClear');
  var aiNewBtn = document.getElementById('btnAiNew');
  var aiHistBtn = document.getElementById('btnAiHist');
  if (aiNewBtn) aiNewBtn.addEventListener('click', aiHistNewSession);
  if (aiClearBtn) aiClearBtn.addEventListener('click', aiHistClear);
  if (aiHistBtn) aiHistBtn.addEventListener('click', function(e) { e.stopPropagation(); openAiHistPop(); });
  var aiHistCloseEl = document.getElementById('aiHistClose');
  if (aiHistCloseEl) aiHistCloseEl.addEventListener('click', function(e) { e.stopPropagation(); closeAiHistPop(); });
  bindAiHistPopDismiss();
  document.getElementById('aiInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askAssistant(); }
  });

  bindAccountEvents();

  var tbtn = document.getElementById('themeToggle');
  if (tbtn) tbtn.addEventListener('click', toggleTheme);

  document.getElementById('btnAddModel').addEventListener('click', function() { openModelForm(null); });
  document.getElementById('btnMfSave').addEventListener('click', saveModelForm);
  document.getElementById('btnMfTest').addEventListener('click', testModelForm);
  document.getElementById('btnMfCancel').addEventListener('click', closeModelForm);

  // 快捷键：Ctrl/Cmd + Shift + L 切换主题
  document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
      e.preventDefault(); toggleTheme();
    }
  });

  // 左侧菜单导航
  Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function(item) {
    item.addEventListener('click', function() {
      var view = item.getAttribute('data-view');
      if (item.classList.contains('has-children')) {
        var g = item.parentElement;
        g.setAttribute('data-open', g.getAttribute('data-open') === 'true' ? 'false' : 'true');
        if (view === 'kairaku') switchView('kairaku');
        return;
      }
      if (view) switchView(view);
    });
  });
}

// ---- 启动入口（DOM 就绪后调）----
export function initMain() {
  var navBadgeEl = document.getElementById('navBadge');
  if (navBadgeEl) navBadgeEl.textContent = '0';
  safeInit('theme', function() { applyTheme(getTheme(), false); });
  safeInit('account', function() { loadAccount(); });
  safeInit('phrases', function() { loadPhrases(); });
  safeInit('bindEvents', function() { bindEvents(); });
  safeInit('aiHistRestore', function() { aiHistRestore(state.selectedId || null); });
  safeInit('aiChips', function() { bindAiChips(); });
  safeInit('batchBar', function() { initBatchBar(); }); // 模块 1 · 出会批量操作
  safeInit('pollMailbox', function() { pollMailbox(true); });
  safeInit('netChip', function() { refreshNetChip(true); });
  safeInit('agentPage', function() { if (state.currentView === 'agents') renderAgentPage(); });
  safeInit('agentPkgPage', function() { if (state.currentView === 'agentPkg') renderAgentPkgPage(); });
  safeInit('platforms', function() { loadPlatforms(); });
  safeInit('timer', function() { setInterval(function() { pollMailbox(false); }, POLL_MS); });

  // 平台记忆刷新（第四刀 · 老代码 L2309/2312 的 module 版，幂等）
  var stored = null;
  try { stored = localStorage.getItem('aisay:platform:v1'); } catch (e) { /* ignore */ }
  try { if (stored === 'kairaku') switchView('18595'); else switchView('17098'); } catch (e) { console.warn('[main-init] 平台记忆刷新失败', e); }

  // 卡片流键盘绑定(A~D/1~6/→←, 仅 cards 视图激活时生效)
  document.addEventListener('keydown', function(e) {
    var cur = state.currentView;
    if (cur !== 'cards') return; // 只在卡片流视图拦截键盘
    if (document.activeElement && /input|textarea/i.test(document.activeElement.tagName)) return;
    var cf = window.__cardflow;
    if (!cf) return;
    // 拉黑/微调 overlay 激活时只处理 Y/Esc
    if (cf.isCardFlowBusy()) {
      var k = e.key.toLowerCase();
      if (k === 'y') { e.preventDefault(); cf.confirmBlock(); }
      if (k === 'escape') { e.preventDefault(); cf.cancelBlock(); cf.cancelAdjust(); }
      return;
    }
    switch (e.key.toLowerCase()) {
      var _ci = cf._idx ? cf._idx() : 0;
      case 'a': cf.selectTalk(_ci, 'A'); break;
      case 'b': cf.selectTalk(_ci, 'B'); break;
      case 'c': cf.selectTalk(_ci, 'C'); break;
      case 'd': cf.selectTalk(_ci, 'D'); break;
      case '1': cf.handleAction(_ci, '1'); break;
      case '2': cf.handleAction(_ci, '2'); break;
      case '3': cf.handleAction(_ci, '3'); break;
      case '4': cf.handleAction(_ci, '4'); break;
      case '5': cf.handleAction(_ci, '5'); break;
      case '6': cf.handleAction(_ci, '6'); break;
      case 'arrowright':
      case ' ': cf.nextCard(); break;
      case 'arrowleft': cf.prevCard(); break;
    }
    // 选中/操作类拦截默认
    if (['a','b','c','d','1','2','3','4','5','6','arrowright','arrowleft',' '].indexOf(e.key.toLowerCase()) !== -1) e.preventDefault();
  });
}
