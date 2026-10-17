// =============================================================================
// Ai SAY M5 task-28 · 指标看板增强自检（node --test）
// 造 3 账号 × 2 客户 = 6 客户 + 各层 LeadEvent/LineMember/LineBind，断言：
//   1. funnel 各层 count（会话→评分→hot→引流→留LINE→绑定）；
//   2. byAccount 按 accountId 分组（客户/会话/hot）；
//   3. dataFreshness.lastUpdated 在范围内（刚写入 ⇒ 非 stale）。
// =============================================================================
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// 卫生项（task-11 G / AGENTS §3.10）：测试 db 一律放 os.tmpdir()，不在 data/ 留文件，
// 消除全量连跑时 Windows safeUnlink 清理后旧 db 残留 → LeadEvent 同 pk 撞 UNIQUE 约束的 3 红。
const TMP_DB = path.join(os.tmpdir(), 'aisay-metrics-funnel-test-' + process.pid + '.db');
function cleanup() { try { fs.unlinkSync(TMP_DB); } catch (_) {} }

let store, talkEngine, dedup, fakeApp, db;
const OPS = [
  { accountId: 'ops-acc1', plat: 'ichigo', win: 'w1', label: 'ichigo-ops1' },
  { accountId: 'ops-acc2', plat: 'fb', win: 'w2', label: 'fb-ops2' },
  { accountId: 'ops-acc3', plat: 'whatsapp', win: 'w3', label: 'wa-ops3' },
];

before(async () => {
  cleanup();
  const { createStore } = require('../server/db/store');
  const { createDedup } = require('../server/db/dedup');
  const { createTalkEngine } = require('../server/acquisition/talkEngine');
  const { mountConsoleRoutes } = require('../server/consoleRoutes');

  store = createStore({ dbPath: TMP_DB });
  db = store.db;
  dedup = createDedup({ store });
  talkEngine = createTalkEngine({ store, sendHook: null, lineId: 'test-line' });

  fakeApp = { _routes: [], get(p, h) { this._routes.push({ method: 'GET', p, h }); }, post(p, h) { this._routes.push({ method: 'POST', p, h }); } };
  mountConsoleRoutes(fakeApp, { store, talkEngine, dedup, adapters: null });

  const nowIso = new Date().toISOString();
  for (const o of OPS) {
    db.prepare(
      "INSERT OR REPLACE INTO Account (accountId, platform, label, status, legacyKey, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)"
    ).run(o.accountId, o.plat, o.label, 'active', o.plat + '/' + o.win + '/' + o.label, nowIso, nowIso);
  }

  const contactIds = {};
  const plan = [
    { ops: OPS[0], contacts: ['a1', 'a2'] },
    { ops: OPS[1], contacts: ['b1', 'b2'] },
    { ops: OPS[2], contacts: ['c1', 'c2'] },
  ];
  for (const g of plan) {
    for (const ck of g.contacts) {
      const c = store.upsertContact({ windowId: g.ops.win, platform: g.ops.plat, contactKey: ck, contact: { name: '客户' + ck } });
      contactIds[ck] = c.contactId;
      const convId = sha1(g.ops.accountId + '|' + c.contactId + '|platform_dm');
      db.prepare(
        "INSERT OR REPLACE INTO Conversation (conversationId, accountId, contactId, channel, status, lastActiveAt, legacyKey, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)"
      ).run(convId, g.ops.accountId, c.contactId, 'platform_dm', 'open', nowIso, g.ops.plat + '/' + g.ops.win + '/' + ck, nowIso, nowIso);
    }
  }

  const tiers = { a1: 'hot', a2: 'warm', b1: 'hot', b2: 'warm', c1: 'cold', c2: 'cold' };
  for (const [ck, tier] of Object.entries(tiers)) {
    db.prepare('INSERT INTO LeadEvent (leadEventId, contactId, score, tier, signals, action, lineOffered, lineAdded, createdAt) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(ck + '-lead', contactIds[ck], 80, tier, '[]', 'triggered', 0, 0, nowIso);
  }
  db.prepare('UPDATE LeadEvent SET lineOffered = 1 WHERE contactId = ?').run(contactIds.a1);
  db.prepare('UPDATE LeadEvent SET lineOffered = 1 WHERE contactId = ?').run(contactIds.b1);
  db.prepare('UPDATE LeadEvent SET lineAdded = 1 WHERE contactId = ?').run(contactIds.a1);

  db.prepare('INSERT INTO LineMember (openId, displayName, region, silentDays, createdAt, updatedAt) VALUES (?,?,?,?,?,?)')
    .run('open-a1', '客户 a1', '', 0, nowIso, nowIso);
  db.prepare('INSERT INTO LineBind (bindId, contactId, openId, joinKey, confidence, createdAt) VALUES (?,?,?,?,?,?)')
    .run(contactIds.a1 + '-bind', contactIds.a1, 'open-a1', 'phone', 0.9, nowIso);
});
after(() => cleanup());

function getMetrics() {
  const r = fakeApp._routes.find((x) => x.method === 'GET' && x.p === '/api/console/metrics');
  assert.ok(r, 'metrics 路由应注册');
  return new Promise((resolve) => {
    const req = { method: 'GET', url: '/api/console/metrics', params: {} };
    const res = { _code: 0, _body: null, writeHead(c) { this._code = c; }, end(b) { this._body = b; } };
    r.h(req, res).then(() => resolve(JSON.parse(res._body || '{}')));
  });
}

test('funnel 各层 count 正确', async () => {
  const out = await getMetrics();
  assert.strictEqual(out.ok, true);
  const f = out.data.funnel;
  assert.strictEqual(f.length, 6, '漏斗应有 6 层');
  const expected = [6, 6, 2, 2, 1, 1];
  expected.forEach((exp, i) => {
    assert.strictEqual(f[i].count, exp, '漏斗第 ' + (i + 1) + ' 层（' + f[i].layer + '）count=' + f[i].count + ' 应为 ' + exp);
  });
  assert.strictEqual(f[0].rate, 100, '第 1 层 rate=100');
});

test('byAccount 按 accountId 分组（每账号 2 客户 + 2 会话 + hot 数）', async () => {
  const out = await getMetrics();
  const ba = out.data.byAccount;
  assert.ok(Array.isArray(ba) && ba.length >= 3, 'byAccount 应有 ≥3 组');
  const byLabel = {};
  ba.forEach((g) => { byLabel[g.label] = g; });
  for (const o of OPS) {
    assert.ok(byLabel[o.label], '应有账号 ' + o.label);
    assert.strictEqual(byLabel[o.label].contactCount, 2, o.label + ' 客户数=2');
    assert.strictEqual(byLabel[o.label].conversationCount, 2, o.label + ' 会话数=2');
  }
  assert.strictEqual(byLabel['ichigo-ops1'].hotCount, 1, 'acc1 hot=1（a1）');
  assert.strictEqual(byLabel['fb-ops2'].hotCount, 1, 'acc2 hot=1（b1）');
  assert.strictEqual(byLabel['wa-ops3'].hotCount, 0, 'acc3 hot=0（c1,c2 cold）');
});

test('dataFreshness 各表 lastUpdated 在范围内（刚写入 ⇒ 非 stale）', async () => {
  const out = await getMetrics();
  const df = out.data.dataFreshness;
  assert.ok(Array.isArray(df) && df.length >= 4, 'dataFreshness 应含 ≥4 个核心表');
  const byTable = {};
  df.forEach((t) => { byTable[t.table] = t; });
  for (const t of ['Contact', 'Conversation', 'LeadEvent']) {
    assert.ok(byTable[t], '应有 ' + t + ' 表');
    assert.ok(byTable[t].count > 0, t + ' 行数应 >0');
    assert.ok(byTable[t].lastUpdated, t + ' lastUpdated 应存在');
    assert.strictEqual(byTable[t].stale, false, t + ' 刚写入不应 stale');
  }
});
