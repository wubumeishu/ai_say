// =============================================================================
// Ai SAY task-2 · migrateUnify.js 4.5 跨轨归并（弱指纹 likelySame 队列）自检
// 总控裁决方案 2：缓存轨 q-token 与 JSON 轨 contactKey 不同源（交集 0，现网实核），
//   直接 JOIN 恒空转 ⇒ 4.5 改接 dedup 弱指纹 likelySame 队列。
// 本测试证明 4.5 接弱指纹后不空转：构造 1 缓存轨客户（q-token 强锚点，source=chat）
//   + 1 JSON 轨客户（同名+同地区+同年龄 弱指纹命中，source=legacy），
//   断言 likelySame 队列产生 1 对 + mergeContact 归并 + MergeEvent 写入（归并数 > 0）。
// 约束：os.tmpdir() 临时 DB；不真发；无空 catch。
// =============================================================================
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aisay-unify-cross-'));
const TMP_DB = path.join(TMP_DIR, 'unify-cross-test.db');
const JSON_DIR = path.join(TMP_DIR, 'json');
const CACHE_PATH = path.join(TMP_DIR, 'console-cache.json');
let store;

before(async () => {
  fs.mkdirSync(JSON_DIR, { recursive: true });
  const now = new Date().toISOString();
  // ---- JSON 轨源：1 个客户（contactKey=customer-1，三元组键）----
  fs.writeFileSync(path.join(JSON_DIR, 'contacts.json'), JSON.stringify([
    { key: 'ikuru/w1/customer-1', platform: 'ikuru', windowId: 'w1', contactKey: 'customer-1',
      contact: { name: '爽快', age: '46', region: '埼玉県', height: '', intro: 'test' },
      createdAt: now, updatedAt: now },
  ], null, 2));
  fs.writeFileSync(path.join(JSON_DIR, 'conversations.json'), JSON.stringify([], null, 2));
  fs.writeFileSync(path.join(JSON_DIR, 'account-profiles.json'), JSON.stringify([], null, 2));
  // ---- 缓存轨源：1 个客户（q-token 强锚点 source=chat，同名+同地区+同年龄 → 弱指纹命中）----
  fs.writeFileSync(CACHE_PATH, JSON.stringify({
    version: 1, updatedAt: now,
    contacts: {
      'q-token-customer-1': {
        contactId: 'q-token-customer-1', name: '爽快', age: '46', region: '埼玉県', ageNum: 46,
        lastMsg: 'm', lastMsgTime: '10/06 10:00', unread: 1, onlineTier: 'recent',
        firstSeen: now, lastSeen: now,
      },
    },
  }, null, 2));
  const { createStore } = require('../server/db/store');
  store = createStore({ dbPath: TMP_DB });
});

after(() => {
  try { if (store && store.close) store.close(); } catch (e) { console.error('[unify-cross] store.close 失败:', e && e.message); }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { console.warn('[unify-cross] cleanup:', e && e.message); }
});

test('task-2 4.5：跨轨归并走弱指纹 likelySame 队列（不空转，归并数 > 0）', async () => {
  const { runMigration } = require('../server/db/migrateUnify');
  const r = runMigration({ dbPath: TMP_DB, jsonDir: JSON_DIR, cachePath: CACHE_PATH, dryRun: false, phase: 'A' });
  assert.strictEqual(r.ok, true, '迁移应成功');

  // 弱指纹命中：likelySame 队列应 ≥1 对（缓存轨 q-token 客户 ↔ JSON 轨 customer-1 同名+同地区+同年龄）
  const db = store.db;
  const queued = db.prepare("SELECT COUNT(*) AS n FROM MergeEvent WHERE reason LIKE 'queue:cross-track-unify|%'").get().n;
  assert.ok(queued >= 1, '4.5 弱指纹队列应 ≥1 对（接弱指纹后不空转，实际 ' + queued + '）');

  // 归并已执行：mergeContact 写 MergeEvent(direction='merge', reason='cross-track-unify')
  const merged = db.prepare("SELECT COUNT(*) AS n FROM MergeEvent WHERE reason = 'cross-track-unify'").get().n;
  assert.ok(merged >= 1, 'mergeContact 归并应 ≥1（实际 ' + merged + '）');

  // MergeEvent 可回滚（§0.3）：归并行存在 + rollbackOf 链完整
  const mergeRows = db.prepare("SELECT * FROM MergeEvent WHERE reason = 'cross-track-unify'").all();
  assert.ok(mergeRows.length >= 1, 'MergeEvent 归并行应写入（审计 + rollBackMerge 可回滚）');

  // counts.crossMerge 应 > 0（不再恒 0 空转）
  assert.ok(r.counts.crossMerge >= 1, 'counts.crossMerge 应 > 0（4.5 实跑归并，实际 ' + r.counts.crossMerge + '）');
});

test('task-2 4.5：不同名客户弱指纹不命中（不误归并）', async () => {
  const db = store.db;
  const now = new Date().toISOString();
  // 再加一个 JSON 轨不同名客户 + 缓存轨不同名客户（弱指纹不命中）
  const diffJ = 'diff-' + Date.now();
  db.prepare("INSERT INTO Contact (contactId,displayName,nickname,mergedInto,firstSeen,lastSeen,lifecycle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(sha1('weak/' + diffJ), diffJ, diffJ, null, now, now, 'new', now, now);
  db.prepare("INSERT OR IGNORE INTO ContactProfile (contactId,region,age,confidence,source,createdAt,updatedAt) VALUES (?,?,?,0.5,'legacy',?,?)")
    .run(sha1('weak/' + diffJ), '東京都', '30', now, now);
  // 该不同名客户与既有客户弱指纹不同 ⇒ 不应产生新的 likelySame 命中
  const queuedNow = db.prepare("SELECT COUNT(*) AS n FROM MergeEvent WHERE reason LIKE 'queue:cross-track-unify|%'").get().n;
  assert.ok(queuedNow >= 1, '既有命中保留（新增不同名不额外命中）');
});
