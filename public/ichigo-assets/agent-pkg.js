// ichigo-assets/agent-pkg.js · agent 包管理视图（总控 2026-10-25）
// 功能：列 agent（内置+动态）/ 新增动态 agent / 删动态 agent / 试跑（执行器）
// 调端点：GET /api/console/agent-pkg + POST /add + DELETE /:id + POST /run
'use strict';
import { toast } from './util.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

const SIDE_ICON = { none: '🟢', weak: '🟡', strong: '🔴' };

// 主渲染：进视图时调
export function renderAgentPkgPage() {
  var page = document.getElementById('agentPkgPage');
  if (!page) return;
  var grid = document.getElementById('agentPkgGrid');
  var sub = document.getElementById('agentPkgSub');
  if (sub) sub.textContent = '加载中…';
  fetch('/api/console/agent-pkg').then(function (r) { return r.json(); }).then(function (j) {
    if (!j || !j.ok || !Array.isArray(j.agents)) {
      if (sub) sub.textContent = '加载失败：' + ((j && j.msg) || '未知');
      if (grid) grid.innerHTML = '<div class="empty">agent 包未加载（服务未起或端点缺失）</div>';
      return;
    }
    var nBuiltin = 0, nDyn = 0;
    j.agents.forEach(function (a) { a.dynamic ? nDyn++ : nBuiltin++; });
    if (sub) sub.textContent = '共 ' + j.agents.length + ' 个 agent（内置 ' + nBuiltin + ' · 动态 ' + nDyn + '）；强副作用 🔴 仅生成确认卡片';
    grid.innerHTML = j.agents.map(function (a) {
      var toolType = (a.llmType || a.type || a.id);
      var badge = a.dynamic ? '<span class="apk-badge dyn">动态</span>' : '<span class="apk-badge">内置</span>';
      var side = SIDE_ICON[a.sideEffect] || '⚪';
      var confirmTag = a.needsConfirm ? '<span class="apk-badge cfrm">需确认</span>' : '';
      var params = (a.params || []).map(function (pm) {
        return esc(pm.name) + (pm.required ? '*' : '');
      }).join(', ');
      var canDelete = !!a.dynamic;
      return '<div class="mc-card apk-card">'
        + '<div class="apk-head">' + side + ' <b>' + esc(a.name || a.id) + '</b> ' + badge + confirmTag
        + ' <span class="apk-id">llm:' + esc(toolType) + '</span></div>'
        + '<div class="apk-desc">' + esc(a.desc || '') + '</div>'
        + '<div class="apk-meta">端点 ' + esc((a.endpoint && a.endpoint.method) || 'GET') + ' ' + esc((a.endpoint && a.endpoint.path) || '')
        + (params ? ' · 参数 ' + params : '') + '</div>'
        + '<div class="apk-actions">'
        + '<button class="apk-btn" data-run="' + esc(a.id) + '">▶ 试跑</button>'
        + (canDelete ? '<button class="apk-btn danger" data-del="' + esc(a.id) + '">🗑 删除</button>' : '<span class="apk-na">内置不可删（改 registry.js）</span>')
        + '</div>'
        + (a.lastRun ? '<div class="apk-lastrun">上次试跑：' + esc(a.lastRun) + '</div>' : '')
        + '</div>';
    }).join('');
    // 绑定动作
    grid.querySelectorAll('[data-run]').forEach(function (b) {
      b.addEventListener('click', function () { runAgent(b.getAttribute('data-run')); });
    });
    grid.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () { delAgent(b.getAttribute('data-del')); });
    });
    var addBtn = document.getElementById('btnAgentPkgAdd');
    if (addBtn) addBtn.onclick = showAddForm;
  }).catch(function (e) {
    if (grid) grid.innerHTML = '<div class="empty">加载失败 ' + esc(e && e.message || e) + '</div>';
    if (sub) sub.textContent = '加载失败';
  });
}

// 试跑：弹 prompt 收集参数（简化版，JSON 输入），调 POST /api/console/agent-pkg/run
async function runAgent(agentId) {
  var raw = prompt('agent ' + agentId + ' 试跑参数（JSON，可空 {}）：', '{}');
  if (raw === null) return;
  var params;
  try { params = raw.trim() ? JSON.parse(raw) : {}; }
  catch (e) { toast('参数 JSON 非法：' + e.message, 'err'); return; }
  // 强副作用默认不 confirmed（试跑只看会返回 confirmation-required，不真执行）
  var r = await fetch('/api/console/agent-pkg/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: agentId, params: params })
  }).then(function (r) { return r.json(); }).catch(function (e) { return { ok: false, msg: String(e) }; });
  if (!r || !r.ok) {
    if (r && r.reason === 'confirmation-required') { toast(agentId + ' 是强副作用，试跑不真执行（铁律）。需 confirmed=true 才执行。', 'warn'); }
    else toast('试跑失败：' + ((r && (r.error || r.msg)) || '未知'), 'err');
    return;
  }
  toast('试跑 ' + agentId + '：ok httpStatus=' + r.httpStatus + (r.data ? ' · ' + JSON.stringify(r.data).slice(0, 120) : ''), 'ok');
}

// 删动态 agent
async function delAgent(agentId) {
  if (!confirm('删除动态 agent ' + agentId + '？（内置 agent 不可删）')) return;
  var r = await fetch('/api/console/agent-pkg/' + encodeURIComponent(agentId), { method: 'DELETE' })
    .then(function (r) { return r.json(); }).catch(function (e) { return { ok: false, msg: String(e) }; });
  if (!r || !r.ok) { toast('删除失败：' + ((r && r.msg) || '未知'), 'err'); return; }
  toast('已删 ' + agentId, 'ok');
  renderAgentPkgPage();
}

// 新增动态 agent 表单（展开一行）
function showAddForm() {
  var host = document.getElementById('agentPkgAddRow');
  if (!host) return;
  if (host.style.display !== 'none') { host.style.display = 'none'; return; } // toggle
  host.style.display = '';
  host.innerHTML = [
    '<div class="apk-form">',
    ' <div><label>id <input id="apkId"></label> <label>名称 <input id="apkName"></label></div>',
    ' <div><label>模块 <input id="apkModule" value="custom"></label>',
    ' <select id="apkSide"><option value="none">none（只读）</option><option value="weak">weak（弱副作用）</option><option value="strong">strong（强副作用·需确认）</option></select></div>',
    ' <div><label>端点方法 <select id="apkMethod"><option>GET</option><option>POST</option></select></label>',
    ' <label>端点路径 <input id="apkPath" placeholder="/api/console/..."></label></div>',
    ' <div><label>描述 <input id="apkDesc"></label></div>',
    ' <div><label>参数(JSON数组，可空 []) <input id="apkParams" value="[]"></label></div>',
    ' <div class="apk-formbtns"><button id="apkSave">保存</button><button id="apkCancel">取消</button></div>',
    '</div>'
  ].join('');
  document.getElementById('apkCancel').onclick = function () { host.style.display = 'none'; };
  document.getElementById('apkSave').onclick = saveNewAgent;
}

async function saveNewAgent() {
  var id = document.getElementById('apkId').value.trim();
  var name = document.getElementById('apkName').value.trim();
  var mod = document.getElementById('apkModule').value.trim() || 'custom';
  var side = document.getElementById('apkSide').value;
  var method = document.getElementById('apkMethod').value;
  var pth = document.getElementById('apkPath').value.trim();
  var desc = document.getElementById('apkDesc').value.trim();
  var paramsRaw = document.getElementById('apkParams').value.trim() || '[]';
  var params;
  try { params = JSON.parse(paramsRaw); if (!Array.isArray(params)) throw new Error('params 需数组'); }
  catch (e) { toast('参数 JSON 非法：' + e.message, 'err'); return; }
  var agent = {
    id: id, name: name, module: mod, desc: desc, sideEffect: side,
    params: params, endpoint: { method: method, path: pth },
    needsConfirm: side === 'strong' ? true : false,
    dynamic: true
  };
  if (!id || !name || !pth) { toast('id / 名称 / 端点路径 必填', 'err'); return; }
  var r = await fetch('/api/console/agent-pkg/add', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(agent)
  }).then(function (r) { return r.json(); }).catch(function (e) { return { ok: false, msg: String(e) }; });
  if (!r || !r.ok) { toast('保存失败：' + ((r && r.msg) || '未知'), 'err'); return; }
  toast('已保存 ' + id + (r.replaced ? '（覆盖）' : ''), 'ok');
  document.getElementById('agentPkgAddRow').style.display = 'none';
  renderAgentPkgPage();
}
