// =============================================================================
// Ai SAY task-6 · crash-guard 自检（node --test）
// 覆盖：
//   1. store.close() 幂等（重复调用不抛）；
//   2. index.js uncaughtException 钩子语义（静态检查）：写 crash.log（_crashLog）、
//      close SQLite、exit(1) 排队、不 spawn（拉起归 pm2——预审挂账 #2）；
//   3. shutdown（SIGTERM/SIGINT）路径 store.close 先于 exit(0)（静态）。
// 动态行为（close 实调 + pm2 自动拉起端到端）由 devops-lead 的 pm2 环境验证承接；
// 本测试不在 node:test 进程内 process.emit（钩子会 unref exit(1) 杀测试进程，误伤）。
// 约束：os.tmpdir() 建临时 store；不碰真发；无空 catch。
// =============================================================================
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aisay-crashguard-'));

// --- 幂等 close：直接验 store 实现 ---
test('store.close 幂等（重复调用不抛，§3.2 task-6）', () => {
  const { createStore } = require('../server/db/store');
  const store = createStore({ dbPath: path.join(TMP_DIR, 'close-test.db') });
  assert.strictEqual(typeof store.close, 'function', 'store.close 应存在（task-6 新增）');
  assert.doesNotThrow(() => store.close(), '首次 close 不抛');
  assert.doesNotThrow(() => store.close(), '重复 close 幂等不抛');
});

// --- uncaughtException 钩子语义（静态检查源码，不 process.emit 防误伤测试进程）---
test('uncaughtException 钩子：crash.log + close + exit(1) 不 spawn（预审 #2，静态）', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const guardBlock = idx.slice(idx.indexOf("process.on('uncaughtException'"), idx.indexOf("process.on('unhandledRejection'"));
  assert.ok(guardBlock.length > 0, 'uncaughtException 钩子应存在');
  assert.match(guardBlock, /_crashLog/, '应调 _crashLog 写 data/crash.log（排障回溯 §0.5）');
  assert.match(guardBlock, /store\.close/, 'exit 前应 close SQLite（防 -wal 残留）');
  assert.match(guardBlock, /process\.exit\(1\)/, '应 exit(1)（拉起归 pm2）');
  assert.ok(!/child_process|spawn\(/.test(guardBlock), '钩子内不得 spawn（防 double-restart，预审 #2）');
  // _crashLog 辅助函数应存在且写 crash.log（时间戳+pid+stack）
  const crashLogFn = idx.slice(idx.indexOf('function _crashLog'), idx.indexOf('process.on'));
  assert.match(crashLogFn, /crash\.log/, '_crashLog 应写 crash.log');
  assert.match(crashLogFn, /pid=\$\{process\.pid\}|pid=/.test(crashLogFn) ? /pid/ : /pid/, '_crashLog 应含 pid（排障）');
  // task-10 A（GUARDIAN §4.3 双方向 + AI_SAY_REJECTION_GUARD JSON）：
  // unhandledRejection 走 _shouldFatalRejection 判定；起步态（env 缺省）全 log-only，命中黑名单才 exit(1)
  const rejBlock = idx.slice(idx.indexOf("process.on('unhandledRejection'"), idx.indexOf('process.on(\'SIGINT\''));
  assert.match(rejBlock, /_shouldFatalRejection/, 'unhandledRejection 应经 _shouldFatalRejection 判定（AI_SAY_REJECTION_GUARD 双方向）');
  assert.match(rejBlock, /process\.exit\(1\)/, '命中黑名单（fatal 判定）应 exit(1)（拉起归 pm2）');
  assert.match(rejBlock, /store\.close/, 'fatal 路径 exit 前应 close SQLite（防 -wal 残留）');
});

// --- task-10 A：unhandledRejection 双方向动态用例（require index.js 导出 _crashGuard；isMain=false 不挂钩子，安全）---
// 注：index.js 顶层会建 data/aisay.db（store），require 有副作用但仅建表幂等，不影响断言。
// GUARDIAN §4.3 双方向（lead 裁决 ① 起步态 = 全 log-only，0 行为变化）：
//   起步（env AI_SAY_REJECTION_GUARD 缺省）= { denyByDefault:false, list:[] } ⇒ 全 log-only（_shouldFatalRejection=false）；
//   配 denyByDefault:false + list=黑名单 ⇒ 命中危险特征 _shouldFatalRejection=true（升级 fatal）。
test('task-10 A：起步态（env 缺省）unhandledRejection 默认 log-only，0 行为变化', () => {
  const idxMod = require('../server/index');
  const guard = idxMod._crashGuard;
  assert.ok(guard && typeof guard._shouldFatalRejection === 'function', '_crashGuard._shouldFatalRejection 应导出（供测试）');
  // 清 env：缺省 = { denyByDefault:false, list:[] } ⇒ 全 log-only（任何 reject 都不 fatal）
  delete process.env.AI_SAY_REJECTION_GUARD;
  const reason = new Error('simulated-any-rejection');
  assert.strictEqual(guard._shouldFatalRejection(reason), false, '起步态 env 缺省 ⇒ log-only（0 行为变化，不 exit(1)）');
});

test('task-10 A：denyByDefault=false + 黑名单命中 ⇒ 升级 fatal；未命中 ⇒ log-only', () => {
  const idxMod = require('../server/index');
  const guard = idxMod._crashGuard;
  // 黑名单：命中 ECONNRESET / 正则特征的重 reject 升级 fatal；其余 log-only
  process.env.AI_SAY_REJECTION_GUARD = JSON.stringify({ denyByDefault: false, list: [{ match: 'ECONNRESET|db-corrupt', kind: 'net' }] });
  try {
    const dangerous = new Error('socket ECONNRESET on cdp channel');
    assert.strictEqual(guard._shouldFatalRejection(dangerous), true, '命中黑名单特征 ⇒ 升级 fatal（exit 1）');
    // 未命中黑名单特征的偶发 reject（CDP 偶发 timeout 等）仍 log-only
    const benign = new Error('cdp evaluate timeout after 20000ms');
    assert.strictEqual(guard._shouldFatalRejection(benign), false, '未命中黑名单 ⇒ log-only（不重启，起步安全）');
  } finally {
    delete process.env.AI_SAY_REJECTION_GUARD;
  }
});

// --- SIGTERM/SIGINT shutdown：store.close 在 exit(0) 前调用（时序对齐 pm2 kill_timeout）---
test('shutdown：SIGTERM/SIGINT 路径 store.close 先于 exit(0)（静态）', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const shutdownIdx = idx.indexOf('function shutdown()');
  assert.ok(shutdownIdx > 0, 'shutdown 函数应存在（task-36）');
  const shutdownBlock = idx.slice(shutdownIdx, idx.indexOf('// 导出供测试/组装使用'));
  assert.match(shutdownBlock, /store\.close/, 'shutdown 应调 store.close（task-6）');
  assert.match(shutdownBlock, /process\.exit\(0\)/, '1500ms 兜底 exit(0) 保留（task-36）');
});

test('cleanup', () => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { console.warn('[crash-guard] cleanup:', e.message); } });
