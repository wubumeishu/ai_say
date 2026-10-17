// =============================================================================
// Ai SAY · 快乐平台（happymail.co.jp）数据缓存层（H4 缺陷 6 · A 持久化，仿 ichigoCache.js 结构）
// 独立文件 data/happy-cache.json（键前缀 happy:，与会出 console-cache.json 严格分离，不串数据）。
//   收件箱快照（contacts 全量 + unread + fetchedAt）+ 客户详情/会话（按 memberID 键，TTL 5min）。
// 用法（对齐出会 ichigoCache）：
//   端点先读缓存（新鲜窗口如 5min 内直接回缓存 + cached:true）→ 过期/force=1 才真连 CDP → 成功后回写；
//   窗口未开/CDP 失败 → 降级回缓存（stale 标记），不回空。
// §0.3 数据不进 Git（data/happy-cache.json 走 .gitignore 的 data/ 通配，见 .gitignore L9）。
// =============================================================================
const fs = require('fs');
const path = require('path');

function nowIso() { return new Date().toISOString(); }

function createHappyCache(opts) {
  opts = opts || {};
  var filePath = opts.filePath || path.join(__dirname, '..', '..', 'data', 'happy-cache.json');
  // 收件箱 TTL（新鲜窗口）：5min 内直接回缓存，避免重复真连 CDP
  var inboxTtlMs = opts.inboxTtlMs || 5 * 60 * 1000;
  // 客户详情/会话 TTL：5min（同 inbox，可配）
  var customerTtlMs = opts.customerTtlMs || 5 * 60 * 1000;

  var state = {
    version: 1,
    updatedAt: nowIso(),
    inbox: null,        // { contacts, unread, windowId, fetchedAt, more }
    customers: {}       // memberID -> { profile, messages, mailID, fetchedAt }
  };

  function load() {
    try {
      if (fs.existsSync(filePath)) {
        var raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (raw && typeof raw === 'object') {
          state.version = raw.version || 1;
          state.inbox = raw.inbox || null;
          state.customers = raw.customers || {};
          state.updatedAt = raw.updatedAt || nowIso();
        }
      }
    } catch (e) {
      // 损坏则重置（不阻断服务）
      state = { version: 1, updatedAt: nowIso(), inbox: null, customers: {} };
    }
  }

  var saveTimer = null;
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(function() {
      saveTimer = null;
      saveNow();
    }, 800);
  }
  function saveNow() {
    try {
      state.updatedAt = nowIso();
      var dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      var tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (e) {
      // 落盘失败不影响内存态（仿 ichigoCache，不吞错静默——至少可观测）
      console.warn('[happyCache.saveNow] 落盘失败:', e && e.message);
    }
  }

  // ---------- 收件箱快照 ----------
  // 写缓存（scanInbox 成功后回写）
  function upsertInbox(data) {
    state.inbox = {
      contacts: Array.isArray(data && data.contacts) ? data.contacts : [],
      unread: (data && data.unread) || '',
      windowId: (data && data.windowId) || '',
      more: !!(data && data.more),
      fetchedAt: nowIso()
    };
    saveSoon();
    return { changed: true, count: state.inbox.contacts.length };
  }

  // 读缓存（新鲜窗口内直接回；过期返回 null 让调用方真连；stale=true 时即使过期也回旧值兜底）
  function getInbox(opts) {
    opts = opts || {};
    if (!state.inbox || !Array.isArray(state.inbox.contacts)) return null;
    var age = Date.now() - new Date(state.inbox.fetchedAt || 0).getTime();
    var fresh = age < inboxTtlMs;
    if (fresh || opts.stale) {
      return Object.assign({ cached: fresh, stale: opts.stale && !fresh }, state.inbox);
    }
    return null;
  }

  // ---------- 客户详情/会话（按 memberID 键） ----------
  function upsertCustomer(memberID, profile, messages, mailID) {
    if (!memberID) return null;
    state.customers[String(memberID)] = {
      memberID: String(memberID),
      profile: profile || null,
      messages: Array.isArray(messages) ? messages : [],
      mailID: mailID || '',
      fetchedAt: nowIso()
    };
    saveSoon();
    return state.customers[String(memberID)];
  }

  function getCustomer(memberID, opts) {
    opts = opts || {};
    if (!memberID) return null;
    var c = state.customers[String(memberID)];
    if (!c) return null;
    var age = Date.now() - new Date(c.fetchedAt || 0).getTime();
    var fresh = age < customerTtlMs;
    if (fresh || opts.stale) {
      return Object.assign({}, c, { cached: fresh, stale: opts.stale && !fresh });
    }
    return null;
  }

  // 取最近 1 个有 messages>0 的客户（/brief 用：切进快乐视图自动占一个真实客户详情）
  function getBrief() {
    var best = null;
    Object.keys(state.customers || {}).forEach(function(k) {
      var c = state.customers[k];
      if (c && Array.isArray(c.messages) && c.messages.length > 0) {
        var t = new Date(c.fetchedAt || 0).getTime();
        if (!best || t > new Date(best.fetchedAt || 0).getTime()) best = c;
      }
    });
    return best;
  }

  // 收件箱是否有任何 messages>0 的客户（brief 兜底判断）
  function hasAnyWithMessages() {
    return Object.keys(state.customers || {}).some(function(k) {
      return state.customers[k] && Array.isArray(state.customers[k].messages) && state.customers[k].messages.length > 0;
    });
  }

  load();

  return {
    upsertInbox, getInbox,
    upsertCustomer, getCustomer,
    getBrief, hasAnyWithMessages,
    close: function() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveNow(); } }
  };
}

module.exports = { createHappyCache };
