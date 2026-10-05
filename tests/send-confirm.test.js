// =============================================================================
// Ai SAY task-37 自检：移除自动发送，所有客户消息必须老板确认（node --test）
// 断言：
//   1. triggerGuide 只生成不自动发（sent=false, pending=true），话术进待确认队列；
//   2. 调 /api/console/send-confirm 才真发（sent=true, confirmed=true, LeadEvent lineOffered=1）；
//   3. 未确认的话术进审计待确认队列（pendingQueue / /api/console/pending-queue）；
//   4. confirmSend 经合规闸门 + 频控（红线词拦截、额度耗尽拦截，不绕过）。
// 约束：mock 本地（store + talkEngine + 假 sendHook），不打真实 API。
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const { createStore } = require('../server/db/store.js');
const { createTalkEngine } = require('../server/acquisition/talkEngine.js');
const { mountConsoleRoutes } = require('../server/consoleRoutes.js');

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const DB = path.join(os.tmpdir(), 'aisay-send-confirm-' + process.pid + '.db');
const TEMPLATES_DIR = path.join(__dirname, '..', 'server', 'acquisition', 'templates');

function mkStore() {
  try { fs.unlinkSync(DB); } catch (e) {}
  return createStore({ dbPath: DB });
}

function makeContact(store, { displayName, nickname }) {
  const contactId = sha1('weak/fb/win1/' + (nickname || displayName) + '|' + displayName);
  const nowIso = new Date().toISOString();
  store.db.prepare(
    'INSERT OR REPLACE INTO Contact (contactId,displayName,nickname,mergedInto,firstSeen,lastSeen,lifecycle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(contactId, displayName, nickname || displayName, null, nowIso, nowIso, 'active', nowIso, nowIso);
  return contactId;
}

// 简易 mock app（收 express 风格 get/post + 原生 handler 查表）
function makeApp() {
  const app = {
    __routes: {},
    get(p, h) { app.__routes['GET ' + p] = h; },
    post(p, h) { app.__routes['POST ' + p] = h; },
  };
  return app;
}
function mockReq(method, url) {
  const m = url.indexOf('?');
  return { method, url, path: m >= 0 ? url.slice(0, m) : url, params: {} };
}
function mockRes() {
  const res = {
    _code: null, _body: '', _headers: {},
    writeHead(code, headers) { this._code = code; this._headers = headers || {}; },
    end(body) { this._body = body; this._done = true; },
    on() {},
  };
  return res;
}
async function callRoute(app, method, path, body) {
  // 路由 key 不带 query（register 时是 pathname）
  const cleanPath = path.indexOf('?') >= 0 ? path.slice(0, path.indexOf('?')) : path;
  const key = method + ' ' + cleanPath;
  const h = app.__routes[key];
  if (!h) throw new Error('route not registered: ' + key);
  const req = mockReq(method, path);
  if (body) req.__body = body; // wrap() 读 req.__body
  const res = mockRes();
  await h(req, res, body || {});
  return JSON.parse(res._body);
}

// ----------------------------------------------------------- 1. 只生成不自动发 --
test('send-confirm: triggerGuide 只生成不自动发（sent=false, pending=true, 进待确认队列）', () => {
  const store = mkStore();
  const c = makeContact(store, { displayName: '田中', nickname: 'タナカ' });
  let sendHookCalled = false;
  const talkEngine = createTalkEngine({
    store,
    lineId: 'aisay.official',
    templatesDir: TEMPLATES_DIR,
    sendHook: (payload) => { sendHookCalled = true; return { ok: true }; },
  });

  const out = talkEngine.triggerGuide({
    accountId: 'acc-sc',
    contactId: c,
    tier: 'warm',
    score: 55,
    category: 'ai_meeting',
    language: 'ja',
    platform: 'fb',
    accountPersona: { persona: 'サヤ' },
    customerProfile: { contactId: c, name: '田中', to: 'field:test' },
    governanceRules: { rules: [], denyByDefault: false },
    auto: true, // 旧语义传 auto=true 也强制不自动发（task-37）
  });

  assert.strictEqual(out.sent, false, 'triggerGuide 不再自动发送（sent=false）');
  assert.strictEqual(out.pending, true, '标记 pending（待老板确认）');
  assert.strictEqual(sendHookCalled, false, 'sendHook 未被调用（不自动发）');
  // LeadEvent 写 triggered 但 lineOffered=0（pending 状态）
  const dbLead = store.db.prepare("SELECT * FROM LeadEvent WHERE contactId=? AND action='triggered' ORDER BY createdAt DESC LIMIT 1").get(c);
  assert.ok(dbLead, 'LeadEvent triggered 已落库');
  assert.strictEqual(dbLead.lineOffered, 0, 'lineOffered=0（未确认发送）');
  // 待确认队列有 1 条
  const pending = talkEngine.getPendingQueue(50);
  assert.strictEqual(pending.length, 1, '待确认队列 1 条');
  assert.strictEqual(pending[0].contactId, c);
  assert.strictEqual(pending[0].confirmed, false, 'pending 未确认');
  assert.strictEqual(pending[0].gateBlocked, false, '合规通过（进待确认）');
});

// ----------------------------------------------------------- 2. send-confirm 真发 --
test('send-confirm: POST /api/console/send-confirm 才真发（confirmed=true, lineOffered=1）', async () => {
  const store = mkStore();
  const c = makeContact(store, { displayName: '铃木', nickname: 'スズキ' });
  let sentText = null;
  const talkEngine = createTalkEngine({
    store,
    lineId: 'aisay.official',
    templatesDir: TEMPLATES_DIR,
    sendHook: (payload) => { sentText = payload.text; return { ok: true }; },
  });
  // 先生成话术（进待确认）
  const gen = talkEngine.triggerGuide({
    accountId: 'acc-sc2', contactId: c, tier: 'warm', score: 55,
    category: 'ai_meeting', language: 'ja', platform: 'fb',
    accountPersona: { persona: 'サヤ' }, customerProfile: { contactId: c, name: '铃木', to: 'field:x' },
    governanceRules: { rules: [], denyByDefault: false }, auto: true,
  });
  assert.strictEqual(gen.sent, false, '生成阶段未发送');

  const app = makeApp();
  mountConsoleRoutes(app, { store, talkEngine });

  // 老板点「确认发送」
  const r = await callRoute(app, 'POST', '/api/console/send-confirm', { contactId: c, accountId: 'acc-sc2' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.sent, true, 'confirmSend 真发（sent=true）');
  assert.strictEqual(r.data.queueEntry.confirmed, true, '待确认条目标 confirmed=true');
  assert.ok(sentText, 'sendHook 被调用（真发送）');
  assert.strictEqual(r.data.queueEntry.text, sentText, '发送的 text 与待确认条目一致');
  // LeadEvent(lineOffered=1) 落库
  const dbLead = store.db.prepare("SELECT * FROM LeadEvent WHERE contactId=? AND lineOffered=1 ORDER BY createdAt DESC LIMIT 1").get(c);
  assert.ok(dbLead, '确认发送后 LeadEvent(lineOffered=1) 已落库');
});

// ----------------------------------------------------------- 3. 未确认进审计待确认队列 --
test('send-confirm: 未确认话术进审计待确认队列（GET /api/console/pending-queue + audit.pendingQueue）', async () => {
  const store = mkStore();
  const c1 = makeContact(store, { displayName: '佐藤', nickname: 'サトウ' });
  const c2 = makeContact(store, { displayName: '伊藤', nickname: 'イトウ' });
  const talkEngine = createTalkEngine({ store, lineId: 'aisay.official', templatesDir: TEMPLATES_DIR });

  // 生成 2 条待确认
  talkEngine.triggerGuide({ accountId: 'acc-sc3', contactId: c1, tier: 'warm', category: 'ai_meeting', language: 'ja', platform: 'fb', customerProfile: { contactId: c1, name: '佐藤' }, governanceRules: { rules: [], denyByDefault: false }, auto: true });
  talkEngine.triggerGuide({ accountId: 'acc-sc3', contactId: c2, tier: 'warm', category: 'ai_meeting', language: 'ja', platform: 'fb', customerProfile: { contactId: c2, name: '伊藤' }, governanceRules: { rules: [], denyByDefault: false }, auto: true });

  const app = makeApp();
  mountConsoleRoutes(app, { store, talkEngine });

  // GET pending-queue
  const rq = await callRoute(app, 'GET', '/api/console/pending-queue?limit=50');
  assert.strictEqual(rq.ok, true);
  assert.strictEqual(rq.data.length, 2, '待确认队列 2 条');
  assert.ok(rq.data.every((p) => p.confirmed === false), '均未确认');
  assert.ok(rq.data.some((p) => p.contactId === c1));
  assert.ok(rq.data.some((p) => p.contactId === c2));

  // 确认 c1（c2 保持未确认）
  await callRoute(app, 'POST', '/api/console/send-confirm', { contactId: c1, accountId: 'acc-sc3' });
  const rq2 = await callRoute(app, 'GET', '/api/console/pending-queue?contactId=' + c1);
  assert.strictEqual(rq2.data.length, 1);
  assert.strictEqual(rq2.data[0].confirmed, true, 'c1 已确认');
  const rq3 = await callRoute(app, 'GET', '/api/console/pending-queue?contactId=' + c2);
  assert.strictEqual(rq3.data.length, 1);
  assert.strictEqual(rq3.data[0].confirmed, false, 'c2 仍未确认（进审计待确认队列）');

  // 审计端点也带 pendingQueue
  const ra = await callRoute(app, 'GET', '/api/console/audit');
  assert.ok(ra.data.pendingQueue, 'audit 端点含 pendingQueue');
  assert.ok(ra.data.pendingQueue.some((p) => p.contactId === c2 && p.confirmed === false), 'audit 待确认队列含未确认的 c2');
});

// ----------------------------------------------------------- 4. 合规闸门 + 频控保留 --
test('send-confirm: 合规红线词拦截 confirmSend（不绕过闸门）', async () => {
  const store = mkStore();
  const c = makeContact(store, { displayName: '高橋', nickname: 'タカハシ' });
  const talkEngine = createTalkEngine({ store, lineId: 'aisay.official', templatesDir: TEMPLATES_DIR });

  const app = makeApp();
  mountConsoleRoutes(app, { store, talkEngine });

  // 红线规则：'gambling' 命中即拦
  const complianceRules = {
    rules: [{ ruleId: 'r-red', ruleType: 'compliance', scope: 'global', scopeKey: null,
      rule: JSON.stringify({ keywords: ['gambling', '暴力'] }), priority: 100, status: 'active' }],
    denyByDefault: false,
  };
  // 手动构造一条含红线的待确认话术（触发时合规拦截会进 gateBlocked，但 confirmSend 也可传入 text 强发——应被拦）
  talkEngine._pendingQueue.push({ accountId: 'acc-sc4', contactId: c, tier: 'warm', text: '今度ギャンブル（gambling）行きませんか？', talk: null, gateBlocked: false, ts: Date.now(), confirmed: false, confirmedAt: null, governanceRules: complianceRules });

  const r = await callRoute(app, 'POST', '/api/console/send-confirm', { contactId: c, accountId: 'acc-sc4', text: '今度ギャンブル（gambling）行きませんか？', governanceRules: complianceRules });
  assert.strictEqual(r.data.sent, false, '含红线词的话术 confirmSend 被合规闸门拦');
  assert.match(r.data.reason, /合规/, '拦截原因=合规');
});

test('send-confirm: 24h≤2 频控拦截 confirmSend（不绕过频控）', async () => {
  const store = mkStore();
  const c = makeContact(store, { displayName: '中村', nickname: 'ナカムラ' });
  const talkEngine = createTalkEngine({ store, lineId: 'aisay.official', templatesDir: TEMPLATES_DIR });

  const app = makeApp();
  mountConsoleRoutes(app, { store, talkEngine });

  // 先 2 次生成+确认（用尽 24h 额度=2）
  talkEngine._pendingQueue.push({ accountId: 'acc-sc5', contactId: c, tier: 'warm', text: '第1条', talk: null, gateBlocked: false, ts: Date.now(), confirmed: false, confirmedAt: null });
  talkEngine._pendingQueue.push({ accountId: 'acc-sc5', contactId: c, tier: 'warm', text: '第2条', talk: null, gateBlocked: false, ts: Date.now(), confirmed: false, confirmedAt: null });
  await callRoute(app, 'POST', '/api/console/send-confirm', { contactId: c, accountId: 'acc-sc5', text: '第1条' });
  await callRoute(app, 'POST', '/api/console/send-confirm', { contactId: c, accountId: 'acc-sc5', text: '第2条' });
  // 第 3 条（24h 已 2 条）应被频控拦
  talkEngine._pendingQueue.push({ accountId: 'acc-sc5', contactId: c, tier: 'warm', text: '第3条', talk: null, gateBlocked: false, ts: Date.now(), confirmed: false, confirmedAt: null });
  const r = await callRoute(app, 'POST', '/api/console/send-confirm', { contactId: c, accountId: 'acc-sc5', text: '第3条' });
  assert.strictEqual(r.data.sent, false, '第 3 条 confirmSend 被 24h≤2 频控拦');
  assert.match(r.data.reason, /频控|已生成/, '拦截原因=频控');
});

test('cleanup', () => { try { fs.unlinkSync(DB); } catch (e) {} });
