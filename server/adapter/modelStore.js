// =============================================================================
// Ai SAY · 模型配置存储（多模型 + 当前选中）
// settings.json 结构：
//   models:       [{ id, name, provider, baseUrl, model, apiKey, createdAt, updatedAt }]
//   activeModelId: "m_xxx"         ← 当前项目使用的模型
//   model:        { ...active 派生 }  ← 兼容旧代码
// =============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function nowIso() { return new Date().toISOString(); }
function genId() { return 'm_' + crypto.randomBytes(6).toString('hex'); }

function createModelStore(opts) {
  opts = opts || {};
  var settingsPath = opts.settingsPath || path.join(__dirname, '..', '..', 'settings.json');

  function readRaw() {
    try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
    catch (e) { return {}; }
  }
  function writeRaw(s) {
    var tmp = settingsPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(tmp, settingsPath);
    return true;
  }

  // 迁移：旧的单一 model → models[]
  function migrate(s) {
    if (!Array.isArray(s.models)) {
      s.models = [];
      if (s.model && (s.model.baseUrl || s.model.model)) {
        s.models.push(Object.assign({
          id: genId(),
          name: (s.model.provider || 'model') + ' · ' + (s.model.model || 'default'),
          createdAt: nowIso(), updatedAt: nowIso()
        }, s.model));
      }
    }
    if (!s.activeModelId || !s.models.some(function(m) { return m.id === s.activeModelId; })) {
      s.activeModelId = s.models[0] ? s.models[0].id : null;
    }
    return s;
  }

  function load() { return migrate(readRaw()); }

  function syncActive(s) {
    var a = (s.models || []).find(function(m) { return m.id === s.activeModelId; });
    if (a) {
      s.model = { provider: a.provider, baseUrl: a.baseUrl, model: a.model, apiKey: a.apiKey };
    }
    return s;
  }

  function persist(s) { syncActive(s); writeRaw(s); return s; }

  function mask(cfg) {
    var k = String((cfg && cfg.apiKey) || '');
    return {
      hasKey: !!k,
      apiKeyMasked: k ? (k.length <= 8 ? '••••' : k.slice(0, 4) + '••••' + k.slice(-4)) : ''
    };
  }

  function publicView(m, activeId) {
    var mk = mask(m);
    return {
      id: m.id,
      name: m.name || '',
      provider: m.provider || '',
      baseUrl: m.baseUrl || '',
      model: m.model || '',
      hasKey: mk.hasKey,
      apiKeyMasked: mk.apiKeyMasked,
      active: m.id === activeId,
      createdAt: m.createdAt || null,
      updatedAt: m.updatedAt || null
    };
  }

  // ---------- 查询 ----------
  function list() {
    var s = load();
    return { models: (s.models || []).map(function(m) { return publicView(m, s.activeModelId); }), activeId: s.activeModelId };
  }
  function get(id) {
    var s = load();
    return (s.models || []).find(function(m) { return m.id === id; }) || null;
  }
  function getActive() {
    var s = load();
    var a = (s.models || []).find(function(m) { return m.id === s.activeModelId; });
    return a || null;
  }
  // 翻译用：返回可用配置（有 key 且有 baseUrl），否则 null
  function getUsableActive() {
    var a = getActive();
    if (a && a.apiKey && a.baseUrl) return a;
    return null;
  }

  // ---------- 写 ----------
  function create(cfg) {
    var s = load();
    var m = {
      id: genId(),
      name: cfg.name || ((cfg.provider || 'model') + ' · ' + (cfg.model || '')),
      provider: cfg.provider || 'deepseek',
      baseUrl: String(cfg.baseUrl || '').replace(/\/+$/, ''),
      model: cfg.model || '',
      apiKey: cfg.apiKey || '',
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    s.models = s.models || [];
    s.models.push(m);
    // 首个模型自动设为当前
    if (!s.activeModelId) s.activeModelId = m.id;
    persist(s);
    return publicView(m, s.activeModelId);
  }

  function update(id, cfg) {
    var s = load();
    var m = (s.models || []).find(function(x) { return x.id === id; });
    if (!m) return null;
    if (cfg.name != null) m.name = cfg.name;
    if (cfg.provider != null) m.provider = cfg.provider;
    if (cfg.baseUrl != null) m.baseUrl = String(cfg.baseUrl).replace(/\/+$/, '');
    if (cfg.model != null) m.model = cfg.model;
    // apiKey：空字符串=不改（避免编辑时被抹掉）；特殊值 '__CLEAR__' = 清空
    if (cfg.apiKey === '__CLEAR__') m.apiKey = '';
    else if (cfg.apiKey) m.apiKey = cfg.apiKey;
    m.updatedAt = nowIso();
    persist(s);
    return publicView(m, s.activeModelId);
  }

  function remove(id) {
    var s = load();
    var before = (s.models || []).length;
    s.models = (s.models || []).filter(function(m) { return m.id !== id; });
    if (s.models.length === before) return false;
    if (s.activeModelId === id) s.activeModelId = s.models[0] ? s.models[0].id : null;
    persist(s);
    return true;
  }

  function activate(id) {
    var s = load();
    var m = (s.models || []).find(function(x) { return x.id === id; });
    if (!m) return null;
    s.activeModelId = id;
    persist(s);
    return publicView(m, s.activeModelId);
  }

  // ---------- 连通测试（真调一次） ----------
  async function test(cfg, timeoutMs) {
    var c = cfg || {};
    if (!c.baseUrl) return { ok: false, msg: '缺少 baseUrl' };
    if (!c.apiKey) return { ok: false, msg: '缺少 apiKey' };
    var url = String(c.baseUrl).replace(/\/+$/, '') + '/chat/completions';
    var t0 = Date.now();
    try {
      var ctrl = new AbortController();
      var timer = setTimeout(function() { ctrl.abort(); }, timeoutMs || 20000);
      var resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.apiKey },
        body: JSON.stringify({
          model: c.model || 'gpt-4o-mini',
          messages: [{ role: 'user', content: '请只回复两个字：正常' }],
          max_tokens: 16,
          temperature: 0
        }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      var latency = Date.now() - t0;
      var text = await resp.text();
      if (!resp.ok) {
        return { ok: false, status: resp.status, latency: latency, msg: 'HTTP ' + resp.status + ' ' + text.slice(0, 200) };
      }
      var data;
      try { data = JSON.parse(text); } catch (_) { return { ok: false, latency: latency, msg: '返回非 JSON: ' + text.slice(0, 120) }; }
      var content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
      return { ok: true, status: resp.status, latency: latency, sample: content, model: data.model || c.model };
    } catch (e) {
      return { ok: false, latency: Date.now() - t0, msg: String(e && e.message || e) };
    }
  }

  // 测试已保存的模型（可用请求体覆盖未保存的改动）
  async function testById(id, override) {
    var m = get(id);
    if (!m) return { ok: false, msg: '模型不存在' };
    var cfg = Object.assign({}, m, override || {});
    if (override && override.apiKey === '__KEEP__') cfg.apiKey = m.apiKey;
    return test(cfg);
  }

  return {
    list: list, get: get, getActive: getActive, getUsableActive: getUsableActive,
    create: create, update: update, remove: remove, activate: activate,
    test: test, testById: testById,
    _settingsPath: settingsPath
  };
}

module.exports = { createModelStore: createModelStore };
