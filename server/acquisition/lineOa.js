// =============================================================================
// Ai SAY M3 · LINE OA 服务端（lineOa.js）
// 依据：docs/plan/03-acquisition.md §4（LINE 官方 API 对接）+ §6.2（LINE 侧风控）
//
// 导出：createLineOa({ store, webhookSecret, channelAccessToken, channelSecret,
//                       fetchImpl, phoneResolver, welcomeText, lineId,
//                       monthlyUsed, monthlyBudget, cfg })
//
// 职责（严格对齐任务边界）：
//   1. handleWebhook(request) → 校验 X-Line-Signature（HMAC-SHA256, webhookSecret）；
//      解析 follow / unfollow / message 事件
//   2. follow 事件 → 自动欢迎语 + 身份绑定
//      （优先 phone join key（LINE Login 获取，调用方经 phoneResolver 注入）；
//        openId 兜底；写 LineMember + LineBind）
//   3. Messaging API：reply(text,{to}) / push(text,{to}) /
//      multicast(text,{to[]}) / addFollowers / getProfile(openId)
//   4. 标签定向群发 tagCampaign：按 Tag 层筛选 LineMember，
//      静默 30 天自动移出；批 ≤50 / 间隔 ≥5s / 单用户 24h push ≤2 / 预算双层告警
//   5. 风控：失败率 >5% 降速（stats() 暴露）、敏感词审核、
//      hot 客户人工闸门（tagCampaign 需外部放行时由调用方经 governanceRules 注入）
//
// 约束：只用 LINE 官方 API；不写 DOM / UI；M4 前 fetchImpl 走内置 mock，
//       M4 接真实凭据时传 fetchImpl=fetch 即可。
// =============================================================================
'use strict';

const crypto = require('crypto');

const LINE_API = 'https://api.line.me/v2';

// 默认风控参数（可被 opts.cfg 覆盖）
const DEFAULTS = {
  batchSize: 50,             // 群发批上限（≤50）
  batchGapMs: 5000,         // 批间隔 ≥5s
  perUser24hPush: 2,        // 单用户 24h 主动 push ≤ 2
  silentDays: 30,           // 静默 30 天未互动移出群发名单
  failRateThreshold: 0.05,  // 失败率 >5% ⇒ 降速标记
  sensitiveWords: [],       // 敏感词库（金融/医疗/政治/赌博）
  welcomeText: '',          // 欢迎语（留空用内置）
};

// 内置 mock fetch（M4 前使用；返回结构对齐 LINE 官方 API）
function mockFetch() {
  const sent = [];
  const impl = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(String(opts.body)) : null;
    sent.push({ url, method, body, at: new Date().toISOString() });
    let res;
    if (url.includes('/profile/')) {
      res = { status: 200, json: async () => ({ displayName: 'MockUser', pictureUrl: '', statusMessage: '', region: 'JP' }) };
    } else if (url.includes('/message/reply')) {
      res = { status: 200, json: async () => ({ destination: body ? (body.to || '') : '', messages: body ? [body] : [], failedDescription: 'Succeeded' }) };
    } else if (url.includes('/message/push')) {
      res = { status: 200, json: async () => ({ destination: body ? body.to : '', messages: body ? [body] : [], failedDescription: 'Succeeded' }) };
    } else if (url.includes('/message/multicast')) {
      res = { status: 200, json: async () => ({ failureCount: 0, succeeded: body ? (body.to ? body.to.length : 0) : 0, failedDescription: 'Succeeded' }) };
    } else if (url.includes('/friend')) {
      res = { status: 200, json: async () => ({ users: [{ userId: 'U_MOCK', displayName: 'MockFollower' }], next: null, total: 1 }) };
    } else {
      res = { status: 200, json: async () => ({ ok: true }) };
    }
    return res;
  };
  return { sent, impl };
}

// 敏感词审核
function containsSensitive(text, words) {
  const lower = String(text || '').toLowerCase();
  const hit = (words || []).filter((w) => w && lower.includes(String(w).toLowerCase()));
  return { hit, ok: hit.length === 0 };
}

function createLineOa(opts = {}) {
  const store = opts.store || null;
  const webhookSecret = String(opts.webhookSecret || '');
  const channelAccessToken = String(opts.channelAccessToken || '');
  const cfg = Object.assign({}, DEFAULTS, opts.cfg || {});
  // fetchImpl：M4 前默认内置 mock；M4 传 fetchImpl=fetch 切真实
  const _mock = mockFetch();
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : _mock.impl;
  const nowIso = opts.nowIso || (() => new Date().toISOString());

  // 风控账本
  const pushLedger = {};  // openId → [ts,...] 最近 24h push 时间戳
  let sendCount = 0;
  let failCount = 0;
  let degraded = false;

  function trackSend(ok) {
    sendCount += 1;
    if (!ok) failCount += 1;
    const rate = sendCount ? failCount / sendCount : 0;
    if (rate > cfg.failRateThreshold) degraded = true;
    return rate;
  }

  // --------------------------------------------------------- 签名校验 ------
  /**
   * verifySignature(body, signatureHeader)
   * body: 原始请求体（string）；signatureHeader: 'x-line-signature' 值（base64）
   * → { ok, reason }
   */
  function verifySignature(body, signatureHeader) {
    if (!webhookSecret) return { ok: true, reason: 'no-secret-configured（M3 mock 放行）' };
    const expected = crypto.createHmac('sha256', webhookSecret).update(String(body || '')).digest('base64');
    const got = String(signatureHeader || '');
    return { ok: got === expected, reason: got === expected ? '' : 'signature-mismatch' };
  }

  // --------------------------------------------------------- Webhook -------
  /**
   * handleWebhook(request)
   * request: { body: string, headers: { 'x-line-signature': '...' } }
   * → { ok, reason?, events: [{ type, ... }] }
   */
  async function handleWebhook(request) {
    const raw = String((request && request.body) ? request.body : '{}');
    const sig = (request && request.headers) ? request.headers['x-line-signature'] : '';
    const sigCheck = verifySignature(raw, sig);
    if (!sigCheck.ok) return { ok: false, reason: sigCheck.reason, events: [] };

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { return { ok: false, reason: 'invalid-json', events: [] }; }

    const events = [];
    for (const evt of (parsed.events || [])) {
      const type = evt.type;
      const out = { type: type || 'unknown' };

      if (type === 'follow') {
        const openId = evt.source && evt.source.userId;
        const r = await onFollow({ openId, source: evt.source });
        Object.assign(out, r);
      } else if (type === 'unfollow') {
        const openId = evt.source && evt.source.userId;
        Object.assign(out, onUnfollow({ openId }));
      } else if (type === 'message') {
        const openId = evt.source && evt.source.userId;
        const msg = evt.message || {};
        Object.assign(out, onMessage({ openId, text: msg.text || '', messageId: msg.id }));
      } else {
        out.skipped = true;
      }
      events.push(out);
    }
    return { ok: true, events, webhookSecretConfigured: !!webhookSecret };
  }

  // --------------------------------------------------- follow 事件 ----------
  /**
   * onFollow({ openId, source })
   * 写 LineMember + 身份绑定（phone 优先，openId 兜底）+ 自动欢迎语
   * → { bound, openId, joinKey, contactId, welcomeSent }
   */
  async function onFollow({ openId, source }) {
    if (!openId) return { bound: false, reason: 'no-openId' };

    // 1. 写 LineMember
    upsertLineMember(openId, { displayName: '', region: '' });

    // 2. 身份绑定：phone 优先（LINE Login 拿到，调用方经 phoneResolver 注入）
    const phone = opts.phoneResolver ? opts.phoneResolver(openId) : null;
    let joinKey = 'openId';
    let contactId = null;
    if (phone) {
      contactId = findByPhone(phone);
      joinKey = 'phone';
    }
    if (!contactId) {
      contactId = findByOpenId(openId);
      joinKey = 'openId';
    }

    // 3. 写 LineBind（仅当有 contactId 对应关系时）
    let bind = null;
    if (contactId) {
      bind = upsertLineBind(contactId, openId, joinKey, joinKey === 'phone' ? 0.95 : 0.6);
    }

    // 4. 自动欢迎语（经 push，走敏感词 + 风控）
    let welcomeSent = false;
    try {
      const text = cfg.welcomeText || ('こんにちは！お友達登録ありがとうございます。LINE: ' + (opts.lineId || 'aisay.official'));
      const wres = await push(text, { to: openId });
      welcomeSent = !!(wres && wres.ok);
    } catch (e) { welcomeSent = false; }

    return { bound: true, openId, joinKey, contactId: contactId || null, bind, welcomeSent, source: source || {} };
  }

  function onUnfollow({ openId }) {
    if (!openId) return { ok: false, reason: 'no-openId' };
    // 标记：silentDays=999（远超 30 天阈值），tagCampaign 自动移出
    try {
      if (store && store.db) {
        store.db.prepare('UPDATE LineMember SET silentDays=999, updatedAt=? WHERE openId=?').run(nowIso(), openId);
      }
    } catch (e) {}
    return { ok: true, openId, marked: 'unfollowed' };
  }

  function onMessage({ openId, text, messageId }) {
    // 互动重置：silentDays=0
    try {
      if (store && store.db) {
        store.db.prepare('UPDATE LineMember SET silentDays=0, updatedAt=? WHERE openId=?').run(nowIso(), openId);
      }
    } catch (e) {}
    return { ok: true, openId, text, messageId, handled: true };
  }

  // ------------------------------------------------------ Messaging API ----
  function headers() {
    return { 'Authorization': 'Bearer ' + channelAccessToken, 'Content-Type': 'application/json' };
  }

  /**
   * reply(text, { to }) — 会话内 1:1 回复（LINE 官方 reply 通道；不计群发预算）
   * → { ok, to, via:'reply' }
   */
  async function reply(text, { to } = {}) {
    const gate = sensitive(text);
    if (!gate.ok) return { ok: false, reason: 'sensitive:' + gate.hit.join(','), to };
    if (degraded) return { ok: false, reason: 'degraded-fail-rate', to };
    const url = LINE_API + '/message/reply';
    const body = { replyToken: String(to || ''), messages: [{ type: 'text', text }] };
    const res = await doFetch(url, body);
    const ok = !!(res && res.status === 200);
    trackSend(ok);
    return { ok, to, via: 'reply' };
  }

  /**
   * push(text, { to }) — 主动推送（受 单用户 24h ≤2 / 敏感词 / 降速 约束）
   * → { ok, to, via:'push' }
   */
  async function push(text, { to } = {}) {
    const gate = sensitive(text);
    if (!gate.ok) return { ok: false, reason: 'sensitive:' + gate.hit.join(','), to };
    if (degraded) return { ok: false, reason: 'degraded-fail-rate', to };
    // 单用户 24h push 限频
    const now = Date.now();
    const key = String(to || '');
    const bucket = (pushLedger[key] || []).filter((ts) => now - ts < 24 * 3600 * 1000);
    if (bucket.length >= cfg.perUser24hPush) {
      return { ok: false, reason: 'per-user-24h-limit', to: key };
    }
    const url = LINE_API + '/message/push';
    const body = { to: key, messages: [{ type: 'text', text }] };
    const res = await doFetch(url, body);
    const ok = !!(res && res.status === 200);
    if (ok) { bucket.push(now); pushLedger[key] = bucket; }
    trackSend(ok);
    return { ok, to: key, via: 'push' };
  }

  /**
   * multicast(text, { to: [] }) — 批量推送（官方上限 500/次；按 cfg.batchSize 分批，批间隔 ≥5s）
   * → { ok, results:[{chunk, ok}], via:'multicast' }
   */
  async function multicast(text, { to } = {}) {
    const list = (Array.isArray(to) ? to : [to]).filter(Boolean).map(String);
    const gate = sensitive(text);
    if (!gate.ok) return { ok: false, reason: 'sensitive:' + gate.hit.join(','), results: [] };
    const results = [];
    for (let i = 0; i < list.length; i += cfg.batchSize) {
      const chunk = list.slice(i, i + cfg.batchSize);
      const url = LINE_API + '/message/multicast';
      const body = { to: chunk, messages: [{ type: 'text', text }] };
      const res = await doFetch(url, body);
      const ok = !!(res && res.status === 200);
      trackSend(ok);
      results.push({ chunk, ok, failureCount: ok ? 0 : chunk.length });
      if (i + cfg.batchSize < list.length && cfg.batchGapMs > 0) {
        await new Promise((r) => setTimeout(r, cfg.batchGapMs));
      }
    }
    return { ok: results.every((r) => r.ok), results, via: 'multicast' };
  }

  /** addFollowers({ limit }) → { ok, users:[], total } */
  async function addFollowers({ limit = 100, start = 0 } = {}) {
    const url = LINE_API + '/friend?limit=' + limit + '&start=' + start;
    const res = await doFetch(url);
    const parsed = res && res.json ? await res.json() : null;
    return { ok: !!(parsed && parsed.users), users: (parsed && parsed.users) || [], total: parsed ? (parsed.total || 0) : 0 };
  }

  /** getProfile(openId) → { ok, profile } */
  async function getProfile(openId) {
    const url = LINE_API + '/profile/' + encodeURIComponent(String(openId || ''));
    const res = await doFetch(url);
    const parsed = res && res.json ? await res.json() : null;
    return { ok: !!(parsed && parsed.displayName), profile: parsed };
  }

  async function doFetch(url, body) {
    const o = { method: body ? 'POST' : 'GET', headers: headers() };
    if (body) o.body = JSON.stringify(body);
    try {
      const res = await fetchImpl(url, o);
      if (res && res.status >= 400) {
        const text = res.text ? await res.text().catch(() => '') : '';
        const err = new Error('LINE API HTTP ' + res.status + ' ' + text.slice(0, 200));
        err.status = res.status;
        throw err;
      }
      return res;
    } catch (e) {
      // 失败不抛（风控统计用）；mock 模式下不会到这里
      return { status: e.status || 500, json: async () => ({ error: e.message }) };
    }
  }

  // ----------------------------------------------------- 标签定向群发 ------
  /**
   * tagCampaign({ layer, value, text })
   *  1. 按 Tag 层（source/intent/category/status/ops）筛选 LineMember
   *  2. 静默 30 天未互动用户自动移出（silentDays ≥ 30）
   *  3. 批 ≤50 / 间隔 ≥5s / 单用户 24h push ≤2（multicast 内部保证）
   *  4. 敏感词 + 风控（失败率>5% 降速 + hot 客户人工闸门）
   *  5. 预算双层告警（月度池 80% + 单客户上限）
   * → { ok, selected, skipped, sent, alerts: [{alert, ...}] }
   */
  async function tagCampaign({ layer, value, text } = {}) {
    const alerts = [];
    if (!layer || !value) return { ok: false, reason: 'layer-and-value-required', alerts };

    // 1. 拉取该 tag 下的 LineMember openIds
    let openIds = [];
    if (store && store.db) {
      let tag = null;
      try { tag = store.db.prepare('SELECT * FROM Tag WHERE layer=? AND value=?').get(layer, String(value)); } catch (e) {}
      if (tag && tag.appliedTo) {
        try { openIds = JSON.parse(tag.appliedTo) || []; } catch (e) { openIds = []; }
      }
      if (!openIds.length) {
        // 回退：拉全部 LineMember（供演示；生产应走 tag 表）
        try {
          const all = store.db.prepare('SELECT openId FROM LineMember').all();
          openIds = all.map((r) => r.openId).filter(Boolean);
        } catch (e) {}
      }
    }
    if (!openIds.length) return { ok: false, reason: 'no-members', alerts };

    // 2. 静默 30 天移出
    const active = openIds.filter((o) => silentDaysOf(o) < cfg.silentDays);
    const skipped = openIds.length - active.length;
    if (skipped > 0) alerts.push({ alert: 'silent-removed', count: skipped });

    // 3. 敏感词
    const gate = sensitive(text);
    if (!gate.ok) {
      alerts.push({ alert: 'sensitive-blocked', words: gate.hit });
      return { ok: false, reason: 'sensitive', selected: active.length, skipped, sent: 0, alerts };
    }

    // 4. 预算双层告警（月度池 80% + 单客户上限）
    if (typeof opts.monthlyUsed === 'function' && typeof opts.monthlyBudget === 'number') {
      const used = opts.monthlyUsed();
      if (used >= opts.monthlyBudget * 0.8) {
        alerts.push({ alert: 'budget-80', used, budget: opts.monthlyBudget });
      }
    }
    if (degraded) alerts.push({ alert: 'fail-rate-degraded' });

    // 5. 群发（批处理 + 单用户限频 + 批间隔）
    let sent = 0;
    const res = await multicast(text, { to: active });
    if (res.ok) sent = active.length;
    else {
      // 部分失败时累计 sent
      for (const r of (res.results || [])) if (r.ok) sent += r.chunk.length;
    }

    return { ok: sent > 0 || active.length === 0, selected: active.length, skipped, sent, alerts, degraded };
  }

  function silentDaysOf(openId) {
    if (store && store.db) {
      try {
        const row = store.db.prepare('SELECT silentDays FROM LineMember WHERE openId=?').get(openId);
        if (row) return Number(row.silentDays) || 0;
      } catch (e) {}
    }
    return 0;
  }

  function sensitive(text) {
    return containsSensitive(text, cfg.sensitiveWords);
  }

  // ------------------------------------------------------ store helpers ----
  /**
   * upsertLineMember(openId, { displayName, region, bindPhone })
   * 写/更新 LineMember（对齐 schema.sql：openId/displayName/region/lineTag/bindPhone/silentDays/createdAt/updatedAt）
   */
  function upsertLineMember(openId, { displayName, region, bindPhone } = {}) {
    if (!store || !store.db) return;
    const now = nowIso();
    try {
      const existing = store.db.prepare('SELECT * FROM LineMember WHERE openId=?').get(openId);
      if (existing) {
        store.db.prepare(
          'UPDATE LineMember SET displayName=?, region=?, bindPhone=COALESCE(?, bindPhone), silentDays=0, updatedAt=? WHERE openId=?'
        ).run(
          displayName != null ? displayName : existing.displayName,
          region != null ? region : existing.region,
          bindPhone || null, now, openId
        );
      } else {
        store.db.prepare(
          'INSERT INTO LineMember (openId, displayName, region, lineTag, bindPhone, silentDays, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)'
        ).run(openId, displayName || '', region || '', null, bindPhone || null, 0, now, now);
      }
    } catch (e) { /* schema 漂移不阻断 */ }
  }

  /**
   * upsertLineBind(contactId, openId, joinKey, confidence)
   * 写/更新 LineBind（bindId=sha1(contactId|openId|joinKey)）
   * joinKey ∈ ('phone','openId','deviceId')；confidence：phone 0.95 / openId 0.6
   */
  function upsertLineBind(contactId, openId, joinKey, confidence) {
    if (!store || !store.db) return null;
    const bindId = crypto.createHash('sha1').update(contactId + '|' + openId + '|' + joinKey).digest('hex');
    const now = nowIso();
    try {
      store.db.prepare(
        'INSERT INTO LineBind (bindId, contactId, openId, joinKey, confidence, createdAt) VALUES (?,?,?,?,?,?) ' +
        'ON CONFLICT(bindId) DO UPDATE SET confidence=excluded.confidence, createdAt=excluded.createdAt'
      ).run(bindId, contactId, openId, joinKey, confidence, now);
      return store.db.prepare('SELECT * FROM LineBind WHERE bindId=?').get(bindId);
    } catch (e) { return null; }
  }

  /**
   * findByPhone(phone) → contactId | null
   * 按 phone 强锚点（ContactAnchor kind='strong'）反查已有 LineBind 绑定
   */
  function findByPhone(phone) {
    if (!store || !store.db || !phone) return null;
    try {
      const row = store.db.prepare(
        "SELECT ca.contactId FROM ContactAnchor ca WHERE ca.value=? AND ca.kind='strong' " +
        "AND ca.contactId IN (SELECT contactId FROM LineBind WHERE joinKey='phone') " +
        "LIMIT 1"
      ).get(phone);
      return row ? row.contactId : null;
    } catch (e) { return null; }
  }

  /**
   * findByOpenId(openId) → contactId | null
   * 查已有 LineBind（按 openId）
   */
  function findByOpenId(openId) {
    if (!store || !store.db || !openId) return null;
    try {
      const row = store.db.prepare(
        "SELECT contactId FROM LineBind WHERE openId=? ORDER BY confidence DESC LIMIT 1"
      ).get(openId);
      return row ? row.contactId : null;
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------ 统计 ------
  function stats() {
    return { sendCount, failCount, degraded, failRate: sendCount ? failCount / sendCount : 0 };
  }

  return {
    verifySignature,
    handleWebhook,
    onFollow,
    onUnfollow,
    onMessage,
    reply,
    push,
    multicast,
    addFollowers,
    getProfile,
    tagCampaign,
    upsertLineMember,
    upsertLineBind,
    findByPhone,
    findByOpenId,
    sensitive,
    silentDaysOf,
    stats,
    cfg,
  };
}

module.exports = { createLineOa, DEFAULTS, mockFetch };
