'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createBreathEngine, irwinHall, DEFAULT_BEAT } = require('I:/deepseek/Ai SAY/server/acquisition/breathEngine');

// 建临时 db（os.tmpdir），含 004 列
function freshStore() {
  const dbPath = path.join(os.tmpdir(), 'aisay-breath-test-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE TaskQueue (taskId TEXT PRIMARY KEY, platform TEXT, accountId TEXT, type TEXT, payload TEXT,
      status TEXT, priority INTEGER, assignedAt TEXT, finishedAt TEXT, error TEXT,
      createdAt TEXT, updatedAt TEXT,
      breathRuleId TEXT NOT NULL DEFAULT 'default:warmup', nextWakeAt INTEGER NOT NULL DEFAULT 0,
      claimedAt INTEGER DEFAULT NULL, claimToken TEXT DEFAULT NULL, idempotencyKey TEXT DEFAULT NULL);
    CREATE TABLE GovernanceRule (ruleId TEXT PRIMARY KEY, ruleType TEXT, scope TEXT, scopeKey TEXT, rule TEXT,
      priority INTEGER, status TEXT, effectiveFrom TEXT, createdAt TEXT, updatedAt TEXT,
      scene TEXT NOT NULL DEFAULT 'default', accountGroup TEXT NOT NULL DEFAULT 'warmup',
      preFixedWaitMs INTEGER NOT NULL DEFAULT 3000, preRandomMinMs INTEGER NOT NULL DEFAULT 2000,
      preRandomMaxMs INTEGER NOT NULL DEFAULT 8000, postFixedWaitMs INTEGER NOT NULL DEFAULT 5000,
      postRandomMinMs INTEGER NOT NULL DEFAULT 3000, postRandomMaxMs INTEGER NOT NULL DEFAULT 10000);
    CREATE TABLE TaskResult (idempotencyKey TEXT PRIMARY KEY, taskId INTEGER NOT NULL, accountId TEXT NOT NULL,
      executedByNode TEXT NOT NULL, httpStatus INTEGER NOT NULL DEFAULT 200, tokenDrifted INTEGER NOT NULL DEFAULT 0,
      resultPayload TEXT NOT NULL DEFAULT '{}', executedAt INTEGER NOT NULL);
    CREATE TABLE AccountProfile (accountId TEXT PRIMARY KEY, platformId TEXT NOT NULL DEFAULT 'happymail',
      pool TEXT NOT NULL DEFAULT 'warmup', manualPoolLock INTEGER NOT NULL DEFAULT 0, bitWindowId TEXT,
      currentPersonaId TEXT, proxyChannel TEXT NOT NULL DEFAULT 'ipdeep_sticky',
      ipBindingJson TEXT NOT NULL DEFAULT '{}', registeredAt INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', updatedAt INTEGER NOT NULL);
  `);
  return { db, dbPath, store: { db, enqueueTask: undefined } };
}

test('irwinHall 三角分布落在 [min,max] 区间', () => {
  for (let i = 0; i < 200; i++) {
    const v = irwinHall(1000, 5000, 50);
    assert.ok(v >= 1000 && v <= 5000, 'out of range: ' + v);
  }
});

test('irwinHall 均值向中位聚拢（不贴边界）', () => {
  let sum = 0;
  const N = 400;
  for (let i = 0; i < N; i++) sum += irwinHall(0, 1000, 1);
  const avg = sum / N;
  assert.ok(avg > 350 && avg < 650, 'avg ' + avg + ' not near median 500');
});

test('tickOnce 调度到期的已绑定任务（抢单 CAS + 状态翻 done）', async () => {
  const env = freshStore();
  const db = env.db, dbPath = env.dbPath, store = env.store;
  store.enqueueTask = (input = {}) => {
    const type = input.type || 'scan';
    const taskId = input.taskId || ('t_' + Date.now() + Math.random().toString(36).slice(2, 6));
    db.prepare('INSERT OR REPLACE INTO TaskQueue (taskId,platform,accountId,type,payload,status,priority,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(taskId, input.platform || 'ichigo', input.accountId || null, type,
        input.payload ? JSON.stringify(input.payload) : null, 'pending', Number(input.priority) || 0, new Date().toISOString(), new Date().toISOString());
    return db.prepare('SELECT * FROM TaskQueue WHERE taskId = ?').get(taskId);
  };
  const eng = createBreathEngine(store, { tickMs: 500 });
  // 绑定账号 + 到期任务（nextWakeAt = now-1000 已到期）
  db.prepare("INSERT INTO AccountProfile (accountId, registeredAt, updatedAt) VALUES (?,?,?)").run('acct1', Date.now(), Date.now());
  store.enqueueTask({ accountId: 'acct1', type: 'like', platform: 'ichigo' });
  db.prepare("UPDATE TaskQueue SET nextWakeAt = ? WHERE accountId = 'acct1'").run(Date.now() - 1000);
  // 无 onTask（引擎只调度，无副作用）→ 直接跑节拍（默认 ~30s，但 tickOnce 会等——为快测缩短？默认值不可改）
  // 改为：用 seed 一条极短节拍规则再 tick
  db.prepare("INSERT INTO GovernanceRule (ruleId, ruleType, scope, scene, accountGroup, status, priority, createdAt, updatedAt, preFixedWaitMs, preRandomMinMs, preRandomMaxMs, postFixedWaitMs, postRandomMinMs, postRandomMaxMs) VALUES ('r1','breath','scene','like','warmup','active',50,?,? ,10,10,10,10,10,10)").run(new Date().toISOString(), new Date().toISOString());
  const stat = await eng.tickOnce();
  assert.ok(stat.dispatched >= 1, 'dispatched=' + stat.dispatched + ' stats=' + JSON.stringify(stat));
  const row = db.prepare("SELECT status FROM TaskQueue WHERE accountId='acct1'").get();
  assert.strictEqual(row.status, 'done');
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dbPath, { force: true }); } catch (_) {}
});

test('D2：连续 3 次 429 → 推 high_intent（type=exception）', async () => {
  const env = freshStore();
  const db = env.db, dbPath = env.dbPath, store = env.store;
  const eng = createBreathEngine(store, { tickMs: 500, httpFaultThreshold: 3 });
  db.prepare("INSERT INTO AccountProfile (accountId, registeredAt, updatedAt) VALUES (?,?,?)").run('acct2', Date.now() - 10 * 86400000, Date.now());
  // 3 条 429 结果（executedAt 在 updatedAt 之后）
  const base = Date.now() + 1000;
  ['429', '429', '429'].forEach((s, i) => {
    db.prepare('INSERT INTO TaskResult (idempotencyKey, taskId, accountId, executedByNode, httpStatus, executedAt) VALUES (?,?,?,?,?,?)')
      .run('k' + i, 1, 'acct2', 'node', Number(s), base + i);
  });
  const faults = eng._internal.countConsecutiveHttpFaults(db, 'acct2', Date.now());
  assert.strictEqual(faults, 3);
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dbPath, { force: true }); } catch (_) {}
});

test('D4：近 72h 无熔断 + manualPoolLock=0 → 晋升 veteran（去注册时长门槛，用户 2026-11-04 裁定）', () => {
  const env = freshStore();
  const db = env.db, dbPath = env.dbPath, store = env.store;
  const eng = createBreathEngine(store, { tickMs: 500 });
  // warm1：注册仅 1 天（旧 7d 门槛下不该晋升，新判据应晋升）+ 72h 无熔断 + 手动锁 0
  db.prepare("INSERT INTO AccountProfile (accountId, registeredAt, updatedAt, pool, manualPoolLock) VALUES ('warm1',?,? ,'warmup',0)").run(Date.now() - 86400000, Date.now());
  // warm2：手动锁=1 → 不晋升
  db.prepare("INSERT INTO AccountProfile (accountId, registeredAt, updatedAt, pool, manualPoolLock) VALUES ('warm2',? ,? ,'warmup',1)").run(Date.now() - 86400000, Date.now());
  // warm3：近 72h 有 403 熔断 → 不晋升
  db.prepare("INSERT INTO AccountProfile (accountId, registeredAt, updatedAt, pool, manualPoolLock) VALUES ('warm3',? ,? ,'warmup',0)").run(Date.now() - 86400000, Date.now());
  db.prepare('INSERT INTO TaskResult (idempotencyKey, taskId, accountId, executedByNode, httpStatus, executedAt) VALUES (?,?,?,?,?,?)')
    .run('k', 1, 'warm3', 'node', 403, Date.now() + 1000);
  const r = eng.promoteDueAccounts();
  assert.strictEqual(r.promoted, 1, '只晋升 warm1');
  assert.strictEqual(db.prepare("SELECT pool FROM AccountProfile WHERE accountId='warm1'").get().pool, 'veteran');
  assert.strictEqual(db.prepare("SELECT pool FROM AccountProfile WHERE accountId='warm2'").get().pool, 'warmup', '手动锁不晋升');
  assert.strictEqual(db.prepare("SELECT pool FROM AccountProfile WHERE accountId='warm3'").get().pool, 'warmup', '72h 有熔断不晋升');
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dbPath, { force: true }); } catch (_) {}
});
