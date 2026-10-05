// =============================================================================
// Ai SAY · 翻译缓存（内容寻址，持久化）
// key = sha1(from|to|text)  →  切回已看过的客户/消息不再等翻译
// 策略：模型译文长期有效；词典译文在有模型后失效重翻
// =============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createTranslationCache(opts) {
  opts = opts || {};
  var filePath = opts.filePath || path.join(__dirname, '..', '..', 'data', 'translation-cache.json');
  var maxEntries = opts.maxEntries || 20000;

  var map = Object.create(null);

  function load() {
    try {
      if (fs.existsSync(filePath)) {
        var raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (raw && raw.entries) map = raw.entries;
      }
    } catch (_) { map = Object.create(null); }
  }

  var saveTimer = null;
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(function() { saveTimer = null; saveNow(); }, 1500);
  }
  function saveNow() {
    try {
      var keys = Object.keys(map);
      // 超限时裁掉最旧的一半
      if (keys.length > maxEntries) {
        keys.sort(function(a, b) { return (map[a].at || 0) - (map[b].at || 0); });
        var drop = keys.slice(0, Math.floor(keys.length / 2));
        drop.forEach(function(k) { delete map[k]; });
      }
      var dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      var tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries: map }), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (_) {}
  }

  function keyOf(text, from, to) {
    return crypto.createHash('sha1').update(String(from || 'ja') + '|' + String(to || 'zh-CN') + '|' + String(text || '')).digest('hex');
  }

  // 返回缓存条目；modelConfigured=true 时词典结果视为失效
  function get(text, from, to, modelConfigured) {
    var k = keyOf(text, from, to);
    var e = map[k];
    if (!e) return null;
    if (e.source === 'dict-fallback' && modelConfigured) return null;   // 有模型了 → 词典译文作废
    return e;
  }

  function set(text, from, to, entry) {
    var k = keyOf(text, from, to);
    map[k] = { translated: entry.translated, source: entry.source, model: entry.model || null, at: Date.now() };
    saveSoon();
    return k;
  }

  // 批量查询：返回 { hit: {text: entry}, miss: [text] }
  function getMany(items, modelConfigured) {
    var hit = {}, miss = [];
    (items || []).forEach(function(it) {
      var e = get(it.text, it.from, it.to, modelConfigured);
      if (e) hit[it.text] = e; else miss.push(it);
    });
    return { hit: hit, miss: miss };
  }

  function stats() {
    var keys = Object.keys(map);
    var model = 0, dict = 0;
    keys.forEach(function(k) { if (map[k].source === 'model') model++; else dict++; });
    return { total: keys.length, model: model, dict: dict };
  }

  function clear() { map = Object.create(null); saveNow(); return true; }

  load();
  return { get: get, set: set, getMany: getMany, keyOf: keyOf, stats: stats, clear: clear, saveNow: saveNow, _filePath: filePath };
}

module.exports = { createTranslationCache: createTranslationCache };
