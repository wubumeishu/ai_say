// 第三刀 · nav-poll.js（轮询 + 连接态 + 代理页 + 平台记忆，复制自 ichigo-console.html L802-949）
// 依赖：theme.js（applyTheme/getTheme 启动时调）+ util.js（fmtClock/toast/esc）+ state.js（API/POLL_MS/state）
// 第 8 刀收口：兄弟模块调用全部改为直接 import（无 globalThis 桥、无 window 桥）
'use strict';
import { API, POLL_MS, state } from './state.js';
import { fmtClock, toast, esc } from './util.js';
import { getTheme, applyTheme } from './theme.js';
import { isIchigoView } from './view.js'; // 第 8 刀收口：直接 import（无循环：view→nav-poll 单向）
import { renderList, renderHeader } from './ichigo.js'; // 第 8 刀收口：直接 import

// 初始化安全包裹（复制自 L802）
export function safeInit(name, fn) {
  try { fn(); } catch (e) {
    console.error('[init:' + name + ']', e);
    toast('初始化失败(' + name + '): ' + e.message, false);
  }
}

// 平台记忆（复制自 L822）：读 localStorage + 高亮左侧菜单
export function loadPlatforms() {
  var stored = null;
  try { stored = localStorage.getItem('aisay:platform:v1'); } catch (e) { stored = null; }
  fetch('/api/console/platforms').then(function(r) { return r.json(); }).then(function(j) {
    if (!j || !j.ok || !Array.isArray(j.platforms)) return;
    var targetView = (stored === 'kairaku') ? '18595' : '17098';
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function(i) {
      i.classList.toggle('active', i.getAttribute('data-view') === targetView);
    });
  }).catch(function(e) { console.warn('[platforms] load failed', e); });
}

// 收件箱页判定（复制自 L837）
export function onInboxPage() {
  try { return /show_mailbox\.html/i.test(window.location.href); } catch (e) { console.warn('[onInboxPage]', e); return false; }
}

// 轮询收件箱（复制自 L841，含 H3 视图守卫）
export function pollMailbox(initial) {
  if (!initial && !onInboxPage()) {
    var lp0 = document.getElementById('lastPoll');
    if (lp0) lp0.textContent = '非收件箱页，本次跳过刷新';
    return Promise.resolve();
  }
  return fetch(API.mailbox + (initial ? '?force=1' : ''))
    .then(function(r) { return r.json(); })
    .then(function(j) {
      if (!j.ok) { setConn(false); return; }
      setConn(true);
      refreshNetChip(false);
      state.contacts = j.contacts || [];
      state.unread = j.unread || 0;
      state.lastPollAt = new Date();
      // H3 视图守卫：非出会视图下不写出会 DOM（防竞态），数据已存 state
      if (!isIchigoView()) {
        var lpG = document.getElementById('lastPoll');
        if (lpG) lpG.textContent = fmtClock(state.lastPollAt);
        return;
      }
      renderList(); // 第 8 刀收口：直接 import 调用
      if (typeof updateBadge === 'function') updateBadge();
      var lp = document.getElementById('lastPoll');
      if (lp) lp.textContent = fmtClock(state.lastPollAt);
      if (state.selectedId) { var c = findContact(state.selectedId); if (c) renderHeader(c); } // 第 8 刀收口
    })
    .catch(function(e) { console.warn('[pollMailbox] 加载失败', e); setConn(false); });
}

// 网络体检（复制自 L869，渲染到代理页 agentSub/agentGrid）
var lastNetChipAt = 0;
export function refreshNetChip(force) {
  if (!force && Date.now() - lastNetChipAt < 60000) return Promise.resolve();
  lastNetChipAt = Date.now();
  return fetch('/api/console/network/health')
    .then(function(r) { return r.json(); })
    .then(function(j) {
      var sub = document.getElementById('agentSub');
      if (!j.ok) {
        if (sub) sub.textContent = 'CDP 不可达（' + (j.diagnosis || '比特浏览器未连接') + '）';
        var g0 = document.getElementById('agentGrid');
        if (g0) g0.innerHTML = '';
        return;
      }
      var d = (j.health && j.health.diagnosis) || '';
      var plat = j.health && j.health.platform;
      var ip = j.health && j.health.exitIp ? (j.health.exitIp.ip || '') : '';
      if (sub) sub.textContent = '诊断: ' + d + (plat && plat.ok ? (' · 平台 ' + plat.ms + 'ms') : ' · 平台不可达') + (ip ? (' · 出口 IP ' + ip) : '');
      renderAgentPage();
    })
    .catch(function(e) { console.warn('[refreshNetChip] 体检失败', e); });
}

// 代理池页（复制自 L890）
export function renderAgentPage() {
  fetch('/api/console/proxy/pool').then(function(r) { return r.json(); }).then(function(j) {
    var grid = document.getElementById('agentGrid');
    if (!grid) return;
    var p = j.data;
    if (!p || !Array.isArray(p.slots)) { grid.innerHTML = '<div class="empty">代理池未初始化</div>'; return; }
    var poolMeta = '<div style="font-size:11px;color:var(--muted,#888);padding:4px 0">' + esc(p.provider || '') + (p.host ? (' · ' + esc(p.host) + ':' + p.port) : '') + '</div>';
    grid.innerHTML = poolMeta + p.slots.map(function(s, i) {
      return '<div class="mc-card" style="border:1px solid var(--line,#333);border-radius:8px;padding:10px;background:var(--card,#14171f)">'
        + '<div style="font-size:11px;color:var(--muted,#888)">槽位 ' + (i + 1) + (s.id ? (' · ' + esc(s.id)) : '') + '</div>'
        + '<div style="font-size:13px;margin:4px 0">' + esc(s.account || s.id || '未分配') + '</div>'
        + '<div style="font-size:11px;color:var(--muted,#888)">' + esc(s.status || 'idle') + '</div>'
        + '</div>';
    }).join('') + (p.nextRotateAt ? '<div class="empty" style="font-size:12px;color:var(--muted,#888)">下次体检: ' + esc(p.nextRotateAt) + '</div>' : '');
  }).catch(function(e) { console.warn('[agentPage] 代理池加载失败', e); });
}

// 换 IP（复制自 L906，只读干跑 + 确认执行，不自动换）
export async function rotateIp() {
  var btn = document.getElementById('btnRotateIp');
  if (!btn) return;
  btn.disabled = true; btn.textContent = '换中…';
  try {
    var dry = await fetch('/api/console/proxy/rotate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun: true }) }).then(function(r) { return r.json(); });
    var who = (dry && dry.data && (dry.data.account || dry.data.msg)) || '未知槽位';
    var go = confirm('将把出会窗口换成：\n' + who + '\n\n（粘性 90min，换后 30min 内不能再换）确定执行？');
    if (!go) { btn.disabled = false; btn.textContent = '换 IP'; return; }
    var real = await fetch('/api/console/proxy/rotate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).then(function(r) { return r.json(); });
    if (real && real.ok) {
      toast('已换 IP（' + ((real.data && real.data.random) || '') + '），窗口重开中… 15s 后自动体检', true);
      lastNetChipAt = 0;
      setTimeout(function() { refreshNetChip(true); renderAgentPage(); }, 15000);
    } else {
      toast('换 IP 未执行：' + (((real && real.data) && (real.data.msg || real.data.reason)) || real.msg || '未知'), false);
    }
  } catch (e) { toast('换 IP 请求失败：' + e.message, false); }
  btn.disabled = false; btn.textContent = '换 IP';
}

// 连接态（复制自 L927）
export function setConn(ok) {
  var b = document.getElementById('connBadge');
  if (!b) return;
  while (b.firstChild) b.removeChild(b.firstChild);
  var d = document.createElement('div');
  d.className = 'dot' + (ok ? ' on' : '');
  b.appendChild(d);
  b.appendChild(document.createTextNode(ok ? ' 出会窗口已连接' : ' 比特浏览器未连接'));
  b.classList.toggle('on', ok);
}

// 未读角标（复制自 L943）
export function updateBadge() {
  var b = document.getElementById('navBadge');
  if (!b) return;
  var n = state.contacts.filter(function(c) { return c.unread > 0; }).length;
  b.textContent = n;
  b.style.display = n > 0 ? '' : 'none';
}

// 启动入口（main.js 调）：按原 L810-835 顺序安全初始化
export function initNavPoll() {
  safeInit('theme', function() { applyTheme(getTheme(), false); });
  safeInit('pollMailbox', function() { pollMailbox(true); });
  safeInit('netChip', function() { refreshNetChip(true); });
  safeInit('agentPage', function() { if (typeof state !== 'undefined' && state && state.currentView === 'agents') renderAgentPage(); });
  safeInit('platforms', function() { loadPlatforms(); });
  safeInit('timer', function() { setInterval(function() { pollMailbox(false); }, POLL_MS); });
}

