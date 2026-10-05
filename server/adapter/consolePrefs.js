// =============================================================================
// Ai SAY · 控制台偏好存储（账号信息覆盖 + 常用语）
// data/console-prefs.json
//   account: { "<accountLabel>": { nicknameOverride, profileOverride, places: [...] } }
//   phrases: [ { id, group, text, order, useCount, createdAt, updatedAt } ]
// =============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function nowIso() { return new Date().toISOString(); }
function genId(p) { return (p || 'p') + '_' + crypto.randomBytes(5).toString('hex'); }

// 常用语初始模板（出会场景，可直接编辑/删除）
var DEFAULT_PHRASES = [
  { group: '条件', text: '大人の関係で、キス・フェラあり、ゴムありでお願いしております。', zh: '因为是成年人之间的关系，请安排带有接吻和口交、且使用安全套的服务。' },
  { group: '条件', text: 'ご予算はどのくらいでお考えですか？', zh: '您的预算大概在什么范围？' },
  { group: '地点', text: '待ち合わせ場所はどこがご希望ですか？', zh: '您希望在哪个地点会合？' },
  { group: '婉拒', text: 'せっかくのお誘いありがとうございます。今回は見送らせてください🙇', zh: '非常感谢您的热情邀请。这次我就不去了🙇' },
  { group: '婉拒', text: 'ごめんなさい、今回はタイミングが合いませんでした。またご縁がありましたら😊', zh: '抱歉，这次时间没对上。如果以后有机会再合作的话😊' },
  { group: '邀约', text: 'よかったら一度お会いしてみませんか？😊', zh: '如果有空的话，要不要见个面？😊' },
  { group: '邀约', text: 'お会いできたら嬉しいです。ご都合のいい日はありますか？', zh: '如果能见面就太好了。请问您哪一天方便？' },
  { group: '邀约', text: '近いうちにゆっくりお話しできたら嬉しいです✨', zh: '希望很快能有机会和您悠闲地聊聊天✨' },
  { group: '开场', text: 'はじめまして☺️ メッセージありがとうございます。よかったらお話ししましょう！', zh: '初次见面☺️ 感谢你的留言。如果不介意的话，我们可以聊聊！' },
  { group: '开场', text: 'こんにちは！プロフィール拝見しました。素敵ですね😊', zh: '你好！我看了一下你的个人资料，真棒呢😊' },
  { group: '开场', text: 'お返事ありがとうございます！嬉しいです✨', zh: '谢谢你的回复！真开心✨' },
  { group: '时间', text: 'ご都合のいい日時を教えていただけますか？', zh: '请告诉我您方便的时间。' },
  { group: '时间', text: '平日のお昼でしたら空いておりますがいかがでしょうか？', zh: '如果您平时中午有空的话，要不要预约呢？' },
  { group: '结束', text: 'ありがとうございました！またお会いできるのを楽しみにしています😊', zh: '谢谢！期待再次与您相见😊' }
];

function createConsolePrefs(opts) {
  opts = opts || {};
  var filePath = opts.filePath || path.join(__dirname, '..', '..', 'data', 'console-prefs.json');

  var state = { version: 1, account: {}, phrases: [] };

  function load() {
    try {
      if (fs.existsSync(filePath)) {
        var raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (raw && typeof raw === 'object') {
          state.account = raw.account || {};
          state.phrases = Array.isArray(raw.phrases) ? raw.phrases : [];
        }
      }
    } catch (_) { state = { version: 1, account: {}, phrases: [] }; }
    // 首次：灌入默认常用语
    if (!state.phrases.length && opts.seedDefaults !== false) {
      state.phrases = DEFAULT_PHRASES.map(function(p, i) {
        return { id: genId('ph'), group: p.group, text: p.text, zh: p.zh || '', order: i, useCount: 0, createdAt: nowIso(), updatedAt: nowIso() };
      });
      saveNow();
    }
  }

  function saveNow() {
    try {
      var dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      var tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
      return true;
    } catch (e) { return false; }
  }
  var t = null;
  function saveSoon() { if (t) return; t = setTimeout(function() { t = null; saveNow(); }, 500); }

  // ---------- 账号覆盖 ----------
  function getAccountOverride(label) {
    return state.account[label] || null;
  }
  function setAccountOverride(label, patch) {
    if (!label) return null;
    var cur = state.account[label] || { nicknameOverride: '', profileOverride: '', places: [] };
    if (patch.nicknameOverride != null) cur.nicknameOverride = String(patch.nicknameOverride);
    if (patch.profileOverride != null) cur.profileOverride = String(patch.profileOverride);
    if (Array.isArray(patch.places)) {
      cur.places = patch.places.map(function(p) {
        return {
          id: p.id || genId('pl'),
          label: String(p.label || ''),
          address: String(p.address || ''),
          note: String(p.note || '')
        };
      });
    }
    cur.updatedAt = nowIso();
    state.account[label] = cur;
    saveNow();
    return cur;
  }

  // ---------- 账号资料卡（从 snsmypage/show_profile.html 抓取后缓存）----------
  function getAccountProfile(label) {
    var a = state.account[label];
    return (a && a.profileCard) || null;
  }
  function setAccountProfile(label, profile) {
    if (!label) return null;
    var cur = state.account[label] || { nicknameOverride: '', profileOverride: '', places: [] };
    cur.profileCard = profile || null;
    cur.profileFetchedAt = nowIso();
    state.account[label] = cur;
    saveNow();
    return cur.profileCard;
  }

  // ---------- 常用语 ----------
  function listPhrases() {
    return state.phrases.slice().sort(function(a, b) {
      var ga = a.group || '', gb = b.group || '';
      if (ga !== gb) return ga.localeCompare(gb, 'ja');
      return (a.order || 0) - (b.order || 0);
    });
  }
  function createPhrase(cfg) {
    var maxOrder = state.phrases.reduce(function(m, p) { return Math.max(m, p.order || 0); }, 0);
    var ph = {
      id: genId('ph'),
      group: String(cfg.group || '未分组'),
      text: String(cfg.text || ''),
      order: maxOrder + 1,
      useCount: 0,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    state.phrases.push(ph);
    saveNow();
    return ph;
  }
  function updatePhrase(id, cfg) {
    var ph = state.phrases.find(function(p) { return p.id === id; });
    if (!ph) return null;
    if (cfg.group != null) ph.group = String(cfg.group);
    if (cfg.text != null) ph.text = String(cfg.text);
    if (cfg.order != null) ph.order = Number(cfg.order) || 0;
    ph.updatedAt = nowIso();
    saveSoon();
    return ph;
  }
  function deletePhrase(id) {
    var n = state.phrases.length;
    state.phrases = state.phrases.filter(function(p) { return p.id !== id; });
    if (state.phrases.length === n) return false;
    saveNow();
    return true;
  }
  function bumpUse(id) {
    var ph = state.phrases.find(function(p) { return p.id === id; });
    if (!ph) return null;
    ph.useCount = (ph.useCount || 0) + 1;
    ph.lastUsedAt = nowIso();
    saveSoon();
    return ph;
  }
  function groups() {
    var seen = {};
    state.phrases.forEach(function(p) { seen[p.group || '未分组'] = true; });
    return Object.keys(seen);
  }

  load();

  return {
    getAccountOverride: getAccountOverride,
    setAccountOverride: setAccountOverride,
    getAccountProfile: getAccountProfile,
    setAccountProfile: setAccountProfile,
    listPhrases: listPhrases,
    createPhrase: createPhrase,
    updatePhrase: updatePhrase,
    deletePhrase: deletePhrase,
    bumpUse: bumpUse,
    groups: groups,
    saveNow: saveNow,
    _filePath: filePath
  };
}

// 预置译文列表（text → zh），供启动时预热翻译缓存
function presetTranslations() {
  return DEFAULT_PHRASES.filter(function(p) { return p.zh; }).map(function(p) {
    return { text: p.text, from: 'ja', to: 'zh-CN', translated: p.zh };
  });
}

module.exports = { createConsolePrefs: createConsolePrefs, DEFAULT_PHRASES: DEFAULT_PHRASES, presetTranslations: presetTranslations };
