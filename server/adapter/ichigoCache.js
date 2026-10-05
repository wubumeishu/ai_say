// =============================================================================
// Ai SAY · 控制台数据缓存层（P0）
// 三层分离：收件箱快照（高频轻量） / 会话历史（按需+永久缓存） / 资料卡（一次+永久）
// 单一 JSON 文件，原子写，进程内内存态 + 落盘。
// =============================================================================
const fs = require('fs');
const path = require('path');

function nowIso() { return new Date().toISOString(); }

function createIchigoCache(opts) {
  opts = opts || {};
  var filePath = opts.filePath || path.join(__dirname, '..', '..', 'data', 'console-cache.json');

  var state = { version: 1, updatedAt: nowIso(), contacts: {} };

  function load() {
    try {
      if (fs.existsSync(filePath)) {
        var raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (raw && typeof raw === 'object') {
          state.version = raw.version || 1;
          state.contacts = raw.contacts || {};
          state.updatedAt = raw.updatedAt || nowIso();
        }
      }
    } catch (e) {
      // 损坏则重置（不阻断服务）
      state = { version: 1, updatedAt: nowIso(), contacts: {} };
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
    } catch (e) { /* 落盘失败不影响内存态 */ }
  }

  function blank(contactId) {
    return {
      contactId: contactId,
      name: '', age: '', region: '', ageNum: null,
      lastMsg: '', lastMsgTime: '',
      onlineTier: null,
      avatarUrl: '', avatarIsDefault: true,
      historyUrl: '', profileUrl: '',
      firstSeen: nowIso(), lastSeen: nowIso(),
      // 未读判定
      lastMsgTimeSeen: '',      // 用户已看过的最新消息时间
      lastMsgTimeNotified: '',  // 已提示过的最新消息时间
      unread: 0,
      // 缓存
      messages: null, messagesFetchedAt: null, msgFetchedForTime: null,
      profile: null, profileFetchedAt: null
    };
  }

  // ---------- 收件箱快照（2min 轮询写入，只做"发现"） ----------
  function upsertMailbox(list) {
    var changed = [];
    var seenIds = {};
    (list || []).forEach(function(c) {
      if (!c || !c.contactId) return;
      seenIds[c.contactId] = true;
      // 姓名别名：若 contactId 是新的但同名条目已存在（q token 轮换），继承旧数据
      if (!state.contacts[c.contactId] && c.name) {
        var aliasKey = null;
        Object.keys(state.contacts).forEach(function(k) {
          if (!aliasKey && state.contacts[k].name === c.name && state.contacts[k].messages) aliasKey = k;
        });
        if (aliasKey) {
          var adopted = state.contacts[aliasKey];
          delete state.contacts[aliasKey];
          adopted.contactId = c.contactId;
          state.contacts[c.contactId] = adopted;
        }
      }
      var cur = state.contacts[c.contactId] || blank(c.contactId);
      var isNew = !state.contacts[c.contactId];
      var prevMsgTime = cur.lastMsgTime;
      // 轻量字段覆盖
      cur.name = c.name || cur.name;
      cur.age = c.age || cur.age;
      cur.region = c.region || cur.region;
      cur.ageNum = (c.ageNum != null) ? c.ageNum : cur.ageNum;
      cur.lastMsg = c.lastMsg || cur.lastMsg;
      cur.lastMsgTime = c.lastMsgTime || cur.lastMsgTime;
      cur.onlineTier = c.onlineTier || cur.onlineTier;
      if (c.avatarUrl && !c.avatarIsDefault) { cur.avatarUrl = c.avatarUrl; cur.avatarIsDefault = false; }
      cur.historyUrl = c.historyUrl || cur.historyUrl;
      cur.lastSeen = nowIso();
      // 未读判定：最新消息时间变了 → 有未读
      if (cur.lastMsgTime && cur.lastMsgTime !== cur.lastMsgTimeSeen) {
        cur.unread = (cur.lastMsgTime === cur.lastMsgTimeNotified) ? cur.unread : Math.max(1, cur.unread);
      } else {
        cur.unread = 0;
      }
      if (!isNew && prevMsgTime !== cur.lastMsgTime) changed.push(cur.contactId);
      cur.lastMsgTimeNotified = cur.lastMsgTime;
      state.contacts[c.contactId] = cur;
    });
    saveSoon();
    return { total: Object.keys(seenIds).length, changed: changed };
  }

  function getContacts() {
    return Object.keys(state.contacts).map(function(k) { return state.contacts[k]; });
  }
  function getContact(contactId) { return state.contacts[contactId] || null; }

  // ---------- 会话历史（按需抓 + 永久缓存） ----------
  function setMessages(contactId, messages, meta) {
    var cur = state.contacts[contactId] || blank(contactId);
    cur.messages = messages || [];
    cur.messagesFetchedAt = nowIso();
    cur.msgFetchedForTime = cur.lastMsgTime || null;   // 记录"这份历史对应的最新消息时间"
    if (meta && meta.avatarUrl && !meta.avatarIsDefault) { cur.avatarUrl = meta.avatarUrl; cur.avatarIsDefault = false; }
    if (meta && meta.historyUrl) cur.historyUrl = meta.historyUrl;
    state.contacts[contactId] = cur;
    saveSoon();
    return cur.messages.length;
  }
  function getMessages(contactId) {
    var c = state.contacts[contactId];
    return c ? (c.messages || null) : null;
  }
  function needsMessages(contactId, maxAgeMs, force) {
    if (force) return true;   // 强制重抓（发送成功后 / 手动刷新用）
    var c = state.contacts[contactId];
    if (!c || !c.messages) return true;
    if (!c.messagesFetchedAt) return true;
    // 已抓过"当前最新消息时间"这一版 → 新鲜，不重抓
    if (c.lastMsgTime && c.msgFetchedForTime === c.lastMsgTime) return false;
    var age = Date.now() - new Date(c.messagesFetchedAt).getTime();
    return age > (maxAgeMs || 10 * 60 * 1000);
  }

  // ---------- 资料卡（一次抓 + 永久缓存） ----------
  function setProfile(contactId, profile) {
    var cur = state.contacts[contactId] || blank(contactId);
    cur.profile = profile || null;
    cur.profileFetchedAt = nowIso();
    if (profile && profile.avatarUrl && !profile.avatarIsDefault) { cur.avatarUrl = profile.avatarUrl; cur.avatarIsDefault = false; }
    if (profile && profile.avatarIsDefault) { cur.avatarIsDefault = true; }
    state.contacts[contactId] = cur;
    saveSoon();
    return true;
  }
  function getProfile(contactId) {
    var c = state.contacts[contactId];
    return c ? (c.profile || null) : null;
  }
  function needsProfile(contactId, maxAgeDays) {
    var c = state.contacts[contactId];
    if (!c || !c.profile) return true;
    if (!c.profileFetchedAt) return true;
    var age = Date.now() - new Date(c.profileFetchedAt).getTime();
    return age > (maxAgeDays || 30) * 24 * 3600 * 1000;
  }

  // ---------- 已读 / 未读 ----------
  function markRead(contactId) {
    var c = state.contacts[contactId];
    if (!c) return false;
    c.lastMsgTimeSeen = c.lastMsgTime;
    c.unread = 0;
    saveSoon();
    return true;
  }
  function unreadTotal() {
    return getContacts().reduce(function(n, c) { return n + (c.unread > 0 ? 1 : 0); }, 0);
  }

  function stats() {
    var cs = getContacts();
    return {
      contacts: cs.length,
      withMessages: cs.filter(function(c) { return c.messages && c.messages.length; }).length,
      withProfile: cs.filter(function(c) { return !!c.profile; }).length,
      unread: unreadTotal(),
      updatedAt: state.updatedAt
    };
  }

  load();

  return {
    upsertMailbox: upsertMailbox,
    getContacts: getContacts,
    getContact: getContact,
    setMessages: setMessages,
    getMessages: getMessages,
    needsMessages: needsMessages,
    setProfile: setProfile,
    getProfile: getProfile,
    needsProfile: needsProfile,
    markRead: markRead,
    unreadTotal: unreadTotal,
    stats: stats,
    saveNow: saveNow,
    _filePath: filePath
  };
}

module.exports = { createIchigoCache: createIchigoCache };
