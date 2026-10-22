// 模块2 · 前端双层翻译缓存池（内存 Map + 持久化 localStorage）
// Key 设计：hash(原文 + '|' + 目标语言)（sha1 简版 djb2 足够前端场景）
// 命中 → 瞬间回填（杜绝切客户闪烁 + 重复调 API）；未命中 → 调 API + 自动写回两层
'use strict';

// djb2 简易哈希（32-bit，碰撞率对翻译缓存可接受；比 sha1 快）
function djb2(str) {
  var h = 5381;
  var s = String(str || '');
  for (var i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

// 缓存 key = hash(text + '|' + toLang + '|' + fromLang)
export function cacheKey(text, from, to) {
  return djb2((String(text || '') + '|' + (from || 'ja') + '|' + (to || 'zh-CN')));
}

// ── 双层结构 ──
// Layer1: 内存 Map（会话级，快）
// Layer2: localStorage（持久化，跨会话；key=aisay-tcache-v2，区分老 TMEMO）
var MEM = new Map();
var LS_KEY = 'aisay-tcache-v2';
var LS = loadLayer2();

function loadLayer2() {
  try {
    var r = localStorage.getItem(LS_KEY);
    if (r) { var p = JSON.parse(r); if (p && typeof p === 'object') return p; }
  } catch (e) { console.warn('[tcache] layer2 读取失败', e); }
  return {};
}

// 读：内存 → localStorage → null
export function getCache(text, from, to) {
  var k = cacheKey(text, from, to);
  if (MEM.has(k)) return MEM.get(k);
  if (Object.prototype.hasOwnProperty.call(LS, k)) return LS[k];
  return null;
}

// 写：两层都写（内存同步 + 持久化防抖）
var _saveTimer = null;
export function setCache(text, from, to, entry) {
  if (!entry || !entry.translated) return;
  var k = cacheKey(text, from, to);
  MEM.set(k, entry);
  LS[k] = entry;
  // 防抖保存（2s 合并写 localStorage）
  if (_saveTimer) return;
  _saveTimer = setTimeout(function() {
    _saveTimer = null;
    try {
      // 裁剪：超 5000 条只保留最近 4000
      var ks = Object.keys(LS);
      if (ks.length > 5000) {
        var keep = {};
        ks.slice(-4000).forEach(function(x) { keep[x] = LS[x]; });
        LS = keep;
      }
      localStorage.setItem(LS_KEY, JSON.stringify(LS));
    } catch (e) { console.warn('[tcache] layer2 保存失败', e); }
  }, 2000);
}

// 命中统计（供调试/面板展示）
export function cacheStats() {
  return { mem: MEM.size, persist: Object.keys(LS).length };
}
