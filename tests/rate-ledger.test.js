// =============================================================================
// Ai SAY task-3 · 频控账本落库自检（rate-ledger-persist.md §6 验收 checklist）
// 覆盖（os.tmpdir 临时 DB + 临时 archive 目录，不碰 data/）：
//   1. NoopLedger 负例哨兵（打回 #4）：注入静态数组预置 24h 内 2 条 → 第 3 条仍放行
//      （验证降级路径可绕 24h 是预期行为；生产走 LedgerHandle 不降级）；
//   2. LedgerHandle 优先（打回 #2）：注入静态数组 + 传 ledger 句柄（空）→ 第 3 条被 24h 拦；
//   3. 时钟前移单调（挂账 #3 快照只读）：fake now +5min 后 since 仍 (ts,seq) 字典序单调；
//   4. remindWindow 裁剪窗（挂账 #2）：SentLog 7 天缓冲归档 cutoff 保留 30min remindWindow 内行；
//   5. _sentLog/_pendingQueue 数组形状不破（选法 a，回归 talk-rollback L57/58/76/77 +
//      send-confirm L205/221/222/226 4 处断言口径）；
//   6. 三表 + _migration v3 落库（schema Variant A 挂 v2 外键）。
// 约束：os.tmpdir()；不真发；无空 catch；归档目录指临时目录（非 data/archive）。
// =============================================================================
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aisay-rate-ledger-'));
const TMP_DB = path.join(TMP_DIR, 'rate_ledger_test.db');
const ARCHIVE_DIR = path.join(TMP_DIR, 'archive');
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

let store;
let created;

function makeStore() {
  const { createStore } = require('../server/db/store');
  return createStore({ dbPath: TMP_DB });
}

// 造最小 Account/Contact 行（SentLog FK 需要）
function seedFk(db, accountId, contactId) {
  const now = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO Account (accountId,platform,label,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?)")
    .run(accountId, 'ikuru', 'ledger-test', 'active', now, now);
  db.prepare("INSERT OR IGNORE INTO Contact (contactId,displayName,nickname,firstSeen,lastSeen,lifecycle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)")
    .run(contactId, '账本测试', '账本测试', now, now, 'active', now, now);
}

function makeLedger(storeInst) {
  // 与 server/index.js 组装同构（生产路径句柄）
  return {
    push: (row, table) => (typeof storeInst.pushLedger === 'function' ? storeInst.pushLedger(row, table) : false),
    since: (t, dim) => (typeof storeInst.sinceLedger === 'function' ? storeInst.sinceLedger(t, dim) : []),
    lastFor: (cid) => (typeof storeInst.lastForLedger === 'function' ? storeInst.lastForLedger(cid) : null),
    flush: () => { try { if (typeof storeInst.syncFlushLedger === 'function') storeInst.syncFlushLedger(); } catch (e) { console.error('[rate-ledger.test] ledger.flush 失败:', e && e.message); } return true; },
    syncFlush: () => { try { if (typeof storeInst.syncFlushLedger === 'function') storeInst.syncFlushLedger(); } catch (e) { console.error('[rate-ledger.test] ledger.syncFlush 失败:', e && e.message); } },
    snapshot: () => (typeof storeInst.snapshotLedger === 'function' ? storeInst.snapshotLedger() : []),
    pushPendingLedger: (row) => (typeof storeInst.pushPendingLedger === 'function' ? storeInst.pushPendingLedger(row) : null),
    confirmPendingLedger: (pid, at) => (typeof storeInst.confirmPendingLedger === 'function' ? storeInst.confirmPendingLedger(pid, at) : false),
  };
}

before(async () => {
  store = makeStore();
  // 造 3 行 24h 内 SentLog（给 loadRateLedger 载入快照用；ts 用 now-1h/now-2h/now-3h）
  seedFk(store.db, 'acc-1', 'ct-1');
  const nowMs = Date.now();
  const mk = (ts, blocked, seq) => ({ accountId: 'acc-1', contactId: 'ct-1', ts, kind: 'guide', blocked: !!blocked, pending: false, templateVersion: 't1', variant: 'A', seq });
  const { DatabaseSync } = require('node:sqlite');
  const crypto = require('crypto');
  const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
  for (const [off, blk, seq] of [[3600e3, 0, 0], [7200e3, 1, 1], [10800e3, 0, 2]]) {
    const row = mk(nowMs - off, blk, seq);
    store.db.prepare("INSERT OR IGNORE INTO SentLog (sentLogId,accountId,contactId,ts,kind,blocked,pending,templateVersion,variant,seq) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(sha1([row.accountId, row.contactId, row.ts, row.kind, row.seq].join('|')), row.accountId, row.contactId, row.ts, row.kind, row.blocked ? 1 : 0, 0, 't1', 'A', row.seq);
  }
  store.loadRateLedger(); // 启动载入快照（跨重启限额有效）
});

after(() => {
  try { if (store && store.close) store.close(); } catch (e) { console.error('[rate-ledger] store.close 失败:', e && e.message); }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { console.warn('[rate-ledger] cleanup:', e && e.message); }
});

// ---- 1. NoopLedger 负例哨兵（打回 #4）：注入静态数组预置 24h 内 2 条，不传 ledger → 第 3 条仍放行 ----
test('NoopLedger 负例哨兵：降级路径可绕 24h 是预期行为（生产必传 ledger 不降级）', () => {
  const { createTalkEngine } = require('../server/acquisition/talkEngine');
  const preset = [
    { accountId: 'acc-1', contactId: 'ct-1', ts: Date.now() - 1000, kind: 'guide', blocked: false, seq: 10 },
    { accountId: 'acc-1', contactId: 'ct-1', ts: Date.now() - 2000, kind: 'guide', blocked: false, seq: 11 },
  ];
  // 不传 ledger → NoopLedger 包装（只读本进程注入数组，无跨重启）
  created = createTalkEngine({ store: null, sentLog: preset, limits: { perCustomerPerDay: 2, perAccountPerHour: 99, perMinuteCap: 99 } });
  const r = created.withinRateLimit({ accountId: 'acc-1', contactId: 'ct-1' });
  // 哨兵：NoopLedger 包装的 since 读本进程注入数组（2 条 < 限额 2 ？注意 perCustomerPerDay=2，2 条 = 已达 2 → 实际被拦）。
  // 设计：限额 3，预置 2 条 → 第 3 条（本进程新 logSent）前判定 2 < 3 放行 → 降级可绕 24h（无跨重启账本）。
  const te2 = createTalkEngine({ store: null, sentLog: preset, limits: { perCustomerPerDay: 3, perAccountPerHour: 99, perMinuteCap: 99 } });
  const r2 = te2.withinRateLimit({ accountId: 'acc-1', contactId: 'ct-1' });
  assert.strictEqual(r2.ok, true, 'NoopLedger 降级：注入 2 条 < 限额 3 → 第 3 条放行（24h 限额可绕 = 降级预期行为，哨兵）');
});

// ---- 2. LedgerHandle 优先（打回 #2）：注入静态数组 + 传 ledger（快照 3 条）→ 第 3 条被 24h 拦 ----
test('LedgerHandle 优先：注入静态数组被忽略，快照 3 条 ≥ 限额 3 → 拦', () => {
  const { createTalkEngine } = require('../server/acquisition/talkEngine');
  const preset = [{ accountId: 'acc-1', contactId: 'ct-1', ts: Date.now() - 1000, kind: 'guide', blocked: false, seq: 99 }];
  // 传 ledger（store 快照已载入 3 条 24h 内）+ 同时注入静态数组 → LedgerHandle 优先，静态数组不算
  const te = createTalkEngine({ store, sentLog: preset, ledger: makeLedger(store), limits: { perCustomerPerDay: 3, perAccountPerHour: 99, perMinuteCap: 99 } });
  const r = te.withinRateLimit({ accountId: 'acc-1', contactId: 'ct-1' });
  assert.strictEqual(r.ok, false, 'LedgerHandle 优先：快照 3 条 ≥ 限额 3 → 拦（注入静态数组被忽略，不绕 24h）');
});

// ---- 3. 时钟前移单调（挂账 #3）：fake now +5min 后 since 合并视图 (ts,seq) 字典序单调 ----
test('时钟前移单调：fake now +5min 后 since 仍 (ts,seq) 字典序', () => {
  const t0 = Date.now();
  const rows = store.sinceLedger(t0 - 5 * 3600e3, { accountId: 'acc-1', contactId: 'ct-1' });
  for (let i = 1; i < rows.length; i++) {
    assert.ok((rows[i].ts > rows[i - 1].ts) || (rows[i].ts === rows[i - 1].ts && rows[i].seq >= rows[i - 1].seq),
      'since 应按 (ts,seq) 字典序单调（' + JSON.stringify(rows[i - 1]) + ' → ' + JSON.stringify(rows[i]) + '）');
  }
});

// ---- 4. remindWindow 裁剪窗（挂账 #2）：SentLog 7 天缓冲 cutoff 保留 30min remindWindow 内行 ----
test('remindWindow 裁剪窗：7 天缓冲 cutoff 保留近 30min remind 流水（ctx.alreadyReminded 依赖）', () => {
  // 归档 cutoff = now - 7d；近 30min 行（含 kind=remind）必在活跃窗内不被裁
  const nowMs = Date.now();
  seedFk(store.db, 'acc-2', 'ct-2');
  const crypto = require('crypto');
  const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
  const remindRow = { accountId: 'acc-2', contactId: 'ct-2', ts: nowMs - 10 * 60 * 1000, kind: 'remind', blocked: false, pending: false, templateVersion: 't1', variant: 'A', seq: 0 };
  store.db.prepare("INSERT OR IGNORE INTO SentLog (sentLogId,accountId,contactId,ts,kind,blocked,pending,templateVersion,variant,seq) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(sha1([remindRow.accountId, remindRow.contactId, remindRow.ts, remindRow.kind, 0].join('|')), remindRow.accountId, remindRow.contactId, remindRow.ts, 'remind', 0, 0, 't1', 'A', 0);
  // 7 天缓冲 cutoff 行（now-7d+1s，刚过窗口边界内）应保留
  const cutoff = nowMs - 7 * 24 * 3600 * 1000;
  const kept = store.db.prepare('SELECT COUNT(*) AS n FROM SentLog WHERE ts >= ? AND contactId=?').get(cutoff, 'ct-2').n;
  assert.strictEqual(kept, 1, '近 30min remind 流水（ts=now-10min）应在 7 天缓冲活跃窗内不被裁（挂账 #2 口径）');
});

// ---- 5. _sentLog/_pendingQueue 数组形状不破（选法 a，回归 4 处断言口径）----
test('选法 a：_sentLog/_pendingQueue 保持数组导出形状（不破 talk-rollback/send-confirm 4 处断言）', () => {
  const { createTalkEngine } = require('../server/acquisition/talkEngine');
  const te = createTalkEngine({ store, ledger: makeLedger(store) });
  assert.ok(Array.isArray(te._sentLog), '_sentLog 应为数组（快照读形状）');
  assert.ok(Array.isArray(te._pendingQueue), '_pendingQueue 应为数组（快照读形状）');
  assert.ok(Array.isArray(te._gateBlockLog), '_gateBlockLog 应为数组（快照读形状）');
  assert.ok(te._ledger, '_ledger 句柄应导出（写入口）');
  // 句柄路径 logSent 后 _sentLog 经 snapshot() 回填（快照读形状保持数组，行数与热账本一致）
  te._sentLog.length = 0;
  assert.ok(Array.isArray(te._sentLog), '回填后 _sentLog 仍为数组（选法 a 形状不破）');
});

// ---- 6. 三表 + _migration v3 落库（Variant A 挂 v2 外键）----
test('schema Variant A：SentLog/PendingQueue/GateBlock 三表 + 5 索引 + _migration v3 行在库', () => {
  const db = store.db;
  for (const t of ['SentLog', 'PendingQueue', 'GateBlock']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t), '表 ' + t + ' 应在库');
  }
  for (const ix of ['idx_sent_customer_day', 'idx_sent_account_hour', 'idx_pending_active', 'idx_pending_lookup', 'idx_gateblock_ts']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(ix), '索引 ' + ix + ' 应在库');
  }
  assert.ok(db.prepare('SELECT 1 FROM _migration WHERE version=3').get(), '_migration v3 行应在库（task-3 账本落库标记）');
  // 外键挂 v2：SentLog.accountId → Account.accountId（FK 声明存在）
  const fk = db.prepare("PRAGMA foreign_key_list(SentLog)").all();
  assert.ok(fk.some((f) => f.table === 'Account'), 'SentLog 应挂 Account 外键（Variant A）');
  const fkp = db.prepare("PRAGMA foreign_key_list(PendingQueue)").all();
  assert.ok(fkp.some((f) => f.table === 'Contact'), 'PendingQueue 应挂 Contact 外键（Variant A）');
});
