// =============================================================================
// Ai SAY M5 · 合规审计 + 封号演练视图 自检（node --test）
// 造数据：GovernanceRule（compliance 红线）+ LeadEvent（含 24h 内归档 ban 信号）
//         + talkEngine.getAuditSummary 拦截账本 + lineOa.stats() degraded
// 断言：GET /api/console/audit 返回 3 区块（complianceSummary / banDrillStatus /
//       recentAudit），拦截计数正确，封号演练 degraded 标志读取正确。
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
const DB = path.join(os.tmpdir(), 'aisay-audit-test-' + process.pid + '.db');

function mkStore() {
  try { fs.unlinkSync(DB); } catch (e) {}
  return createStore({ dbPath: DB });
}

function seedData(store) {
  const nowIso = new Date().toISOString();
  const dayAgo = new Date(Date.now() - 12 * 3600 * 1000).toISOString(); // 12h ago

  // 1) 合规红线规则（compliance + speechBoundary）
  store.db.prepare(
    "INSERT INTO GovernanceRule (ruleId,ruleType,scope,scopeKey,rule,priority,status,effectiveFrom,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,NULL,?,?)"
  ).run('gr-audit-1', 'compliance', 'global', null,
        JSON.stringify({ keywords: ['暴力', '金融商材', 'gambling'] }), 100, 'active', nowIso, nowIso);
  store.db.prepare(
    "INSERT INTO GovernanceRule (ruleId,ruleType,scope,scopeKey,rule,priority,status,effectiveFrom,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,NULL,?,?)"
  ).run('gr-audit-2', 'speechBoundary', 'platform', 'fb',
        JSON.stringify({ forbidden: ['spam'], maxLen: 500 }), 10, 'active', nowIso, nowIso);

  // 2) Contact（供 LeadEvent FK）
  const contactId = sha1('weak/fb/win1/審計|test');
  store.db.prepare(
    'INSERT OR REPLACE INTO Contact (contactId,displayName,nickname,mergedInto,firstSeen,lastSeen,lifecycle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(contactId, 'test', '審計', null, dayAgo, nowIso, 'active', dayAgo, nowIso);

  // 3) LeadEvent：1 条 24h 内归档带 ban 信号（封号演练标记）+ 1 条 triggered
  store.db.prepare(
    'INSERT OR IGNORE INTO LeadEvent (leadEventId,contactId,score,tier,signals,action,lineOffered,lineAdded,createdAt) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(sha1('lead-audit-ban'), contactId, 80, 'hot',
        JSON.stringify([{ signal: 'ban', detail: 'platform-limit' }, { signal: '停发', detail: '24h' }]),
        'archived', 0, 0, dayAgo);
  store.db.prepare(
    'INSERT OR IGNORE INTO LeadEvent (leadEventId,contactId,score,tier,signals,action,lineOffered,lineAdded,createdAt) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(sha1('lead-audit-trig'), contactId, 55, 'warm',
        JSON.stringify([{ signal: 'priceInquiry' }]),
        'triggered', 1, 0, nowIso);
  return { contactId, dayAgo };
}

// 简易 http 模拟：app 提供 get/post，路由直接 handler(req, res)
function makeApp() {
  const app = {
    get: (p, h) => { app.__routes = app.__routes || {}; app.__routes['GET ' + p] = h; },
    post: (p, h) => { app.__routes = app.__routes || {}; app.__routes['POST ' + p] = h; },
  };
  return app;
}
function mockReq(method, url, body) {
  const req = { method, url, __body: body || undefined };
  return req;
}
function mockRes() {
  const res = {
    _code: null, _body: '', _headers: {},
    writeHead(code, headers) { this._code = code; this._headers = headers || {}; },
    end(body) { this._body = body; this._done = true; },
    on() {}, // readBody 用；测试不读 body
  };
  return res;
}

test('audit-view: /api/console/audit 3 区块 + 拦截计数 + degraded 读取', async (t) => {
  const store = mkStore();
  const talkEngine = createTalkEngine({
    store,
    templatesDir: path.join(__dirname, '..', 'server', 'acquisition', 'templates'),
    lineId: 'aisay.official',
  });
  // 注入 mock lineOa（模拟 failRate>5% degraded）
  const mockLineOa = {
    stats: () => ({ sendCount: 100, failCount: 7, failRate: 0.07, degraded: true }),
  };

  const app = makeApp();
  mountConsoleRoutes(app, { store, talkEngine, dedup: null, adapters: null, lineOa: mockLineOa });

  const { contactId, dayAgo } = seedData(store);

  // 补 Contact（LeadEvent FK）
  store.db.prepare(
    'INSERT OR REPLACE INTO Contact (contactId,displayName,nickname,mergedInto,firstSeen,lastSeen,lifecycle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(contactId, 'test', '審計', null, dayAgo, new Date().toISOString(), 'active', dayAgo, new Date().toISOString());

  // 触发 1 次闸门拦截（blacklist 命中），让 getAuditSummary 账本有数据
  // 通过 triggerGuide 走合规闸门，构造命中黑名单的话术
  const blacklistRules = {
    rules: [
      { ruleId: 'gr-audit-1', ruleType: 'compliance', scope: 'global', scopeKey: null,
        rule: JSON.stringify({ keywords: ['aisay.official', 'gambling'] }), priority: 100, status: 'active' },
    ],
    denyByDefault: false,
  };
  // 强制 lineId 进话术 ⇒ 命中黑名单
  const blocked = talkEngine.triggerGuide({
    accountId: 'acc-audit', contactId, tier: 'warm', score: 55,
    category: 'ai_meeting', language: 'ja', platform: 'fb',
    accountPersona: { persona: 'サヤ' }, customerProfile: { contactId, name: 'test' },
    governanceRules: blacklistRules, auto: true,
  });
  assert.strictEqual(blocked.sent, false, '黑名单命中应拦截');
  // 再触发 1 次频控（24h 额度用尽）——前 2 条已发（额度=2），第 3 条触发频控拦截
  // 合规拦截计入 24h 生成额度（task-31 口径）：
  //   上一步 blocked（黑名单）已消耗 1 条生成额度 ⇒ 接下来第 1 条 clean send 是第 2 条生成（可发），
  //   第 2 条 clean send 是第 3 条生成（命中 24h≤2 频控拦截）。
  // 验证「合规拦截的也算额度、避免绕过」：rl3（第 3 条 clean send / 第 4 条生成）必被频控拦。
  // task-37 新语义：triggerGuide 不自动发，恒 {sent:false, pending:true}；真发走 confirmSend。
  // 通过判定改看 pending=true + 无 reason；拦截判定仍看 reason 前缀。
  const rl = talkEngine.triggerGuide({
    accountId: 'acc-audit', contactId, tier: 'warm', score: 55,
    category: 'ai_meeting', language: 'ja', platform: 'fb',
    accountPersona: { persona: 'サヤ' }, customerProfile: { contactId, name: 'test' },
    governanceRules: { rules: [], denyByDefault: false }, auto: true,
  }); // clean send #1（生成 #2）
  const rl2 = talkEngine.triggerGuide({
    accountId: 'acc-audit', contactId, tier: 'warm', score: 55,
    category: 'ai_meeting', language: 'ja', platform: 'fb',
    accountPersona: { persona: 'サヤ' }, customerProfile: { contactId, name: 'test' },
    governanceRules: { rules: [], denyByDefault: false }, auto: true,
  }); // clean send #2（生成 #3）→ 24h≤2 已用尽，频控拦截
  const rl3 = talkEngine.triggerGuide({
    accountId: 'acc-audit', contactId, tier: 'warm', score: 55,
    category: 'ai_meeting', language: 'ja', platform: 'fb',
    accountPersona: { persona: 'サヤ' }, customerProfile: { contactId, name: 'test' },
    governanceRules: { rules: [], denyByDefault: false }, auto: true,
  }); // clean send #3（生成 #4）→ 频控拦截
  assert.strictEqual(rl.sent, false, 'task-37：triggerGuide 恒 sent=false（不自动发）');
  assert.strictEqual(rl.pending, true, 'clean send #1（生成#2）24h 内生成成功，入待确认队列');
  assert.ok(rl.reason === '' || rl.reason === undefined, 'clean send #1 无拦截 reason');
  assert.strictEqual(rl2.sent, false, 'clean send #2 恒 sent=false（task-37 不自动发）');
  assert.match(rl2.reason, /频控/, 'rl2 拦截原因=频控（24h≤2 已用尽）');
  assert.strictEqual(rl3.sent, false, 'clean send #3 恒 sent=false（task-37 不自动发）');
  assert.match(rl3.reason, /频控/, 'rl3 拦截原因=频控');

  // 调路由
  const req = mockReq('GET', '/api/console/audit');
  const res = mockRes();
  await app.__routes['GET /api/console/audit'](req, res);
  assert.strictEqual(res._code, 200, 'audit 端点应 200');
  const data = JSON.parse(res._body).data;

  // 区块 1：complianceSummary
  await t.test('complianceSummary：合规红线集 + 拦截计数按 reason 分组', () => {
    assert.ok(data.complianceSummary, 'complianceSummary 存在');
    assert.strictEqual(data.complianceSummary.activeComplianceCount, 2, 'active 合规规则=2（compliance+speechBoundary）');
    assert.ok(data.complianceSummary.activeComplianceRules.length === 2);
    // 拦截计数：blacklist 1 次（黑名单）+ rateLimit 1 次（频控）
    const byReason = data.complianceSummary.byReason || {};
    assert.ok(byReason.blacklist >= 1, 'blacklist 拦截 ≥1（实际 ' + (byReason.blacklist || 0) + '）');
    assert.ok(byReason.rateLimit >= 1, 'rateLimit 拦截 ≥1（实际 ' + (byReason.rateLimit || 0) + '）');
    assert.ok(data.complianceSummary.blocked24h >= 2, '总拦截 ≥2');
  });

  // 区块 2：banDrillStatus（degraded 读取）
  await t.test('banDrillStatus：failRate/degraded 读取正确', () => {
    assert.ok(data.banDrillStatus, 'banDrillStatus 存在');
    assert.strictEqual(data.banDrillStatus.lineOaInjected, true, 'mock lineOa 已注入');
    assert.ok(data.banDrillStatus.failRate >= 0.05, 'failRate 应 ≥5%（mock 0.07）');
    assert.strictEqual(data.banDrillStatus.degraded, true, 'failRate>5% ⇒ degraded=true');
    assert.strictEqual(data.banDrillStatus.drillPassed, true, '封号演练通过（degraded 标记生效）');
    assert.strictEqual(data.banDrillStatus.sendCount, 100, 'sendCount 读取正确');
    assert.strictEqual(data.banDrillStatus.failCount, 7, 'failCount 读取正确');
    // 24h 内归档带 ban 信号的事件数（seedData 写了 1 条 archived ban）
    assert.strictEqual(data.banDrillStatus.banSignals24h, 1, '24h 归档 ban 信号=1');
  });

  // 区块 3：recentAudit
  await t.test('recentAudit：最近 20 条 LeadEvent', () => {
    assert.ok(Array.isArray(data.recentAudit), 'recentAudit 是数组');
    assert.ok(data.recentAudit.length >= 2, '至少 2 条（triggered+archived）');
    const archived = data.recentAudit.find((e) => e.action === 'archived');
    assert.ok(archived, '含 archived 事件');
    assert.ok(Array.isArray(archived.signals), 'signals 已 JSON 解析为数组');
    assert.ok(archived.signals.some((s) => s.signal === 'ban'), 'signals 含 ban');
  });
});

test('audit-view: talkEngine.getAuditSummary 独立断言', () => {
  const store = mkStore();
  const talkEngine = createTalkEngine({
    store,
    templatesDir: path.join(__dirname, '..', 'server', 'acquisition', 'templates'),
    lineId: 'test',
  });
  const contactId = sha1('weak/fb/win1/孤単|sum');
  // 灌 2 条 blacklist 拦截（lineId='test' 命中黑名单 keywords=['test']）
  const c = contactId;
  store.db.prepare(
    'INSERT OR REPLACE INTO Contact (contactId,displayName,nickname,mergedInto,firstSeen,lastSeen,lifecycle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(c, 'sum', '孤単', null, new Date().toISOString(), new Date().toISOString(), 'active', new Date().toISOString(), new Date().toISOString());
  const rules = { rules: [
    { ruleId: 'r1', ruleType: 'compliance', rule: JSON.stringify({ keywords: ['test'] }), priority: 100 }
  ], denyByDefault: false };
  talkEngine.triggerGuide({ accountId: 'a1', contactId: c, tier: 'warm', category: 'ai_meeting',
    language: 'ja', platform: 'fb', accountPersona: {}, customerProfile: { contactId: c, name: 'x' },
    governanceRules: rules, auto: true }); // 命中黑名单（lineId='test' ∈ 黑名单）
  talkEngine.triggerGuide({ accountId: 'a1', contactId: c, tier: 'warm', category: 'ai_meeting',
    language: 'ja', platform: 'fb', accountPersona: {}, customerProfile: { contactId: c, name: 'x' },
    governanceRules: rules, auto: true });
  const sum = talkEngine.getAuditSummary(50);
  assert.strictEqual(sum.totalSent, 0, 'totalSent=0（两条都被黑名单拦截）');
  assert.strictEqual(sum.totalBlocked, 2, 'totalBlocked=2（黑名单）');
  assert.strictEqual(sum.byReason.blacklist, 2, 'byReason.blacklist=2');
  assert.ok(Array.isArray(sum.recentGateBlocks), 'recentGateBlocks 数组');
  assert.ok(sum.abStats, 'abStats 存在');
});

test('cleanup', () => { try { fs.unlinkSync(DB); } catch (e) {} });
