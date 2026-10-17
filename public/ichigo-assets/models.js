// 第七刀 · models.js（模型管理页，复制自 ichigo-console.html L1594-1780）
// 依赖：state.js(API) + util.js(esc/toast)
'use strict';
import { API } from './state.js';
import { esc, toast } from './util.js';

// 模型表单状态（原 L1592 mfState）
export var mfState = { editingId: null };

// 模型页渲染（复制自 L1594）
export function renderModelPage() {
  fetch(API.models).then(function(r) { return r.json(); }).then(function(j) {
    if (!j.ok) {
      var _mEl = document.getElementById('mpSub');
      _mEl.textContent = (j && j.msg) ? j.msg : '模型服务未就绪';
      _mEl.title = (j && j.reason) || '';
      return;
    }
    var models = j.models || [];
    var active = models.filter(function(m) { return m.active; })[0];
    document.getElementById('mpSub').textContent = active
      ? ('当前使用：' + active.name + '（' + active.model + '）' + (active.hasKey ? '' : ' ⚠ 未配置 Key'))
      : '尚未选择当前模型';
    document.getElementById('modelEmpty').style.display = models.length ? 'none' : '';
    var grid = document.getElementById('modelGrid');
    grid.innerHTML = models.map(cardHtml).join('');
    Array.prototype.forEach.call(grid.querySelectorAll('[data-act]'), function(btn) {
      btn.addEventListener('click', function() {
        var act = btn.getAttribute('data-act');
        var id = btn.getAttribute('data-id');
        if (act === 'activate') doActivate(id);
        else if (act === 'edit') openModelForm(id);
        else if (act === 'test') doTest(id, btn);
        else if (act === 'delete') doDelete(id, btn.getAttribute('data-name'));
      });
    });
  }).catch(function(e) {
    var el = document.getElementById('mpSub');
    var msg = String((e && e.message) || '');
    if (/fetch|network|Failed to fetch/i.test(msg)) {
      el.textContent = '模型服务未连接（检查 8300 服务是否启动，或 /api/console/models 是否可达）';
    } else if (msg) {
      el.textContent = '加载失败: ' + msg;
    } else {
      el.textContent = '加载失败（未知错误）';
    }
  });
}

// 模型卡片 HTML（复制自 L1633）
function cardHtml(m) {
  var cls = 'mcard' + (m.active ? ' active' : '') + (m.hasKey ? '' : ' nokey');
  var badge = m.active ? '<span class="mc-badge">✓ 当前使用</span>' : '';
  var keyLine = m.hasKey
    ? '<span class="mc-ok">🔑 ' + esc(m.apiKeyMasked) + '</span>'
    : '<span class="mc-warn">⚠ 未配置 API Key</span>';
  return '' +
    '<div class="' + cls + '">' +
      '<div class="mc-head">' +
        '<div class="mc-name">' + esc(m.name || '(未命名)') + '</div>' + badge +
      '</div>' +
      '<div class="mc-rows">' +
        '<div class="mc-row"><span class="k">Provider</span><span class="v">' + esc(m.provider || '—') + '</span></div>' +
        '<div class="mc-row"><span class="k">模型</span><span class="v">' + esc(m.model || '—') + '</span></div>' +
        '<div class="mc-row"><span class="k">Base URL</span><span class="v" title="' + esc(m.baseUrl) + '">' + esc(m.baseUrl || '—') + '</span></div>' +
        '<div class="mc-row"><span class="k">Key</span><span class="v">' + keyLine + '</span></div>' +
      '</div>' +
      '<div class="mc-test" data-test-for="' + esc(m.id) + '"></div>' +
      '<div class="mc-actions">' +
        (m.active ? '' : '<button class="primary" data-act="activate" data-id="' + esc(m.id) + '">设为当前</button>') +
        '<button data-act="test" data-id="' + esc(m.id) + '">测试</button>' +
        '<button data-act="edit" data-id="' + esc(m.id) + '">编辑</button>' +
        '<button class="danger" data-act="delete" data-id="' + esc(m.id) + '" data-name="' + esc(m.name) + '">删除</button>' +
      '</div>' +
    '</div>';
}

// 设为当前（复制自 L1660）
export function doActivate(id) {
  fetch(API.mActivate + '?id=' + encodeURIComponent(id), { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(j) {
      toast(j.ok ? '已设为当前模型：' + (j.model && j.model.name) : (j.msg || '设置失败'), !!j.ok);
      renderModelPage();
    }).catch(function(e) { console.warn('[models] activate 失败', e); toast('设置失败', false); });
}

// 删除（复制自 L1669）
export function doDelete(id, name) {
  if (!confirm('确定删除模型「' + (name || '') + '」？')) return;
  fetch(API.mDelete + '?id=' + encodeURIComponent(id), { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(j) {
      toast(j.ok ? '已删除' : (j.msg || '删除失败'), !!j.ok);
      renderModelPage();
    }).catch(function(e) { console.warn('[models] delete 失败', e); toast('删除失败', false); });
}

// 测试连通（复制自 L1679）
export function doTest(id, btn) {
  var box = document.querySelector('[data-test-for="' + id + '"]');
  if (box) { box.className = 'mc-test testing'; box.textContent = '测试中…'; }
  if (btn) btn.disabled = true;
  fetch(API.mTest + '?id=' + encodeURIComponent(id), { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(j) {
      if (btn) btn.disabled = false;
      if (!box) return;
      if (j.ok) {
        box.className = 'mc-test ok';
        box.textContent = '✅ 连通正常 · ' + j.latency + 'ms · 返回「' + (j.sample || '').slice(0, 20) + '」';
      } else {
        box.className = 'mc-test fail';
        box.textContent = '❌ ' + (j.latency ? j.latency + 'ms · ' : '') + (j.msg || '失败').slice(0, 140);
      }
    }).catch(function(e) {
      if (btn) btn.disabled = false;
      if (box) { box.className = 'mc-test fail'; box.textContent = '❌ ' + e.message; }
    });
}

// 打开模型表单（复制自 L1701）
export function openModelForm(id) {
  mfState.editingId = id || null;
  document.getElementById('mfTitle').textContent = id ? '编辑模型' : '新增模型';
  document.getElementById('mfResult').textContent = '';
  var g = function(x) { return document.getElementById(x); };
  if (id) {
    fetch(API.models).then(function(r) { return r.json(); }).then(function(j) {
      var m = (j.models || []).filter(function(x) { return x.id === id; })[0];
      if (!m) return;
      g('mfName').value = m.name || '';
      g('mfProvider').value = m.provider || '';
      g('mfBaseUrl').value = m.baseUrl || '';
      g('mfModel').value = m.model || '';
      g('mfApiKey').value = '';
      g('mfApiKey').placeholder = m.hasKey ? '留空 = 不修改（当前 ' + m.apiKeyMasked + '）' : 'sk-...';
      g('mfKeyHint').textContent = m.hasKey ? '已保存 Key，留空表示不修改' : '';
    });
  } else {
    g('mfName').value = '';
    g('mfProvider').value = 'deepseek';
    g('mfBaseUrl').value = 'https://api.deepseek.com/v1';
    g('mfModel').value = 'deepseek-chat';
    g('mfApiKey').value = '';
    g('mfApiKey').placeholder = 'sk-...';
    g('mfKeyHint').textContent = '';
  }
  document.getElementById('modelForm').style.display = 'flex';
}

// 关闭模型表单（复制自 L1730）
export function closeModelForm() { document.getElementById('modelForm').style.display = 'none'; }

// 收集表单（复制自 L1732）
export function collectForm() {
  var g = function(x) { return document.getElementById(x).value; };
  return {
    name: g('mfName').trim(),
    provider: g('mfProvider').trim(),
    baseUrl: g('mfBaseUrl').trim(),
    model: g('mfModel').trim(),
    apiKey: g('mfApiKey')
  };
}

// 保存模型（复制自 L1743）
export function saveModelForm() {
  var cfg = collectForm();
  var res = document.getElementById('mfResult');
  if (!cfg.baseUrl) { res.textContent = '请填写 Base URL'; return; }
  var isEdit = !!mfState.editingId;
  var url = isEdit ? (API.mUpdate + '?id=' + encodeURIComponent(mfState.editingId)) : API.mCreate;
  if (!isEdit && !cfg.apiKey) { res.textContent = '请填写 API Key'; return; }
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) })
    .then(function(r) { return r.json(); })
    .then(function(j) {
      if (j.ok) {
        toast(isEdit ? '已保存' : '已新增模型', true);
        closeModelForm();
        renderModelPage();
      } else {
        res.textContent = j.msg || '保存失败';
      }
    }).catch(function(e) { res.textContent = '保存失败: ' + e.message; });
}

// 测试表单（复制自 L1763）
export function testModelForm() {
  var cfg = collectForm();
  var res = document.getElementById('mfResult');
  res.textContent = '测试中…';
  var body = { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey };
  var url = API.mTest;
  if (mfState.editingId) {
    url += '?id=' + encodeURIComponent(mfState.editingId);
    if (!cfg.apiKey) body.apiKey = '';
  }
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function(r) { return r.json(); })
    .then(function(j) {
      res.textContent = j.ok
        ? ('✅ 连通正常 · ' + j.latency + 'ms · 返回「' + (j.sample || '').slice(0, 30) + '」')
        : ('❌ ' + (j.latency ? j.latency + 'ms · ' : '') + (j.msg || '失败'));
    }).catch(function(e) { res.textContent = '❌ ' + e.message; });
}

// 过渡桥接（第 7 刀保留，第 8 刀删）