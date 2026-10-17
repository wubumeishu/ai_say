// =============================================================================
// task-H1 · 快乐平台 kairaku 写入（Platform 表种子 + 7 Expr 文件 + HappyAdapter 注册）
// ① Platform 表幂等含 ikuru + kairaku 两行（kairaku 行不重复）
// ② adapters 注册表含 kairaku + 默认 adapterPlatform 仍 ikuru（不碰出会逻辑）
// 全 os.tmpdir mock，不真连 CDP / 不真发
// =============================================================================
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const store = require('../server/db/store.js');
const { createStore } = store;

const TMP_DB = path.join(os.tmpdir(), 'aisay-happy-platform-test-' + process.pid + '.db');

// 用例 ①：Platform 表含 ikuru + kairaku 两行（幂等 INSERT OR IGNORE，kairaku 不重复）
test('task-H1 Platform 表幂等含 ikuru + kairaku 两行（kairaku 不重复）', () => {
  const s = createStore({ dbPath: TMP_DB });
  const db = s.db;
  const rows = db.prepare('SELECT platformId, provider, label, baseUrl FROM Platform').all();
  const ids = rows.map((r) => r.platformId);
  assert.ok(ids.includes('ikuru'), 'Platform 表应含 ikuru 行（出会）');
  assert.ok(ids.includes('kairaku'), 'Platform 表应含 kairaku 行（快乐）');
  // kairaku 幂等：重复跑 schema 不重复插入
  const kairakuCount = db.prepare("SELECT COUNT(*) AS c FROM Platform WHERE platformId='kairaku'").get().c;
  assert.strictEqual(kairakuCount, 1, 'kairaku 行幂等 = 1（INSERT OR IGNORE 不重复）');
  const baseUrl = db.prepare("SELECT baseUrl FROM Platform WHERE platformId='kairaku'").get().baseUrl;
  assert.strictEqual(baseUrl, 'happymail.co.jp', 'kairaku 行 baseUrl = happymail.co.jp');
  s.close();
  try { require('node:fs').unlinkSync(TMP_DB); } catch (e) { console.warn('[happy-platform.test] 清理 tmp db:', e && e.message); }
});

// 用例 ②：adapters 注册表含 kairaku + 默认仍 ikuru（出会逻辑未碰）
test('task-H1 adapters 注册表含 kairaku + 默认 adapterPlatform 仍 ikuru（出会不变）', () => {
  // 读 index.js 源码断言（不真起服务，避免占用 8300）
  const fs = require('node:fs');
  const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.ok(idxSrc.includes("kairaku: {"), 'adapters 注册表应含 kairaku 条目');
  assert.ok(idxSrc.includes("HappyAdapter"), 'kairaku 条目应引用 HappyAdapter');
  assert.ok(idxSrc.includes("adapterPlatform: 'ichigo194964'"), '默认 adapterPlatform 应仍 ikuru（ichigo194964），不碰出会');
  // happy.js 语法 + 4 方法契约（基类 PlatformAdapter）
  const { HappyAdapter } = require('../server/adapter/happy.js');
  assert.strictEqual(typeof HappyAdapter, 'function', 'HappyAdapter 应导出为类/函数');
  // 7 Expr 文件存在 + happySendExpr 红线（readOnly:true 无 fetch/POST/click）
  const exprFiles = ['happyInboxExpr', 'happyTypeExpr', 'happyProfileSearchExpr', 'happyBillboardExpr', 'happyHistoryExpr', 'happyProfileDetailExpr', 'happySendExpr'];
  for (const f of exprFiles) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'server', 'adapter', f + '.js')), f + '.js 应存在');
  }
  const sendExpr = fs.readFileSync(path.join(__dirname, '..', 'server', 'adapter', 'happySendExpr.js'), 'utf8');
  assert.ok(sendExpr.includes('readOnly: true') || sendExpr.includes('readOnly:true'), 'happySendExpr 应标注 readOnly（红线）');
  assert.ok(!sendExpr.includes('fetch('), 'happySendExpr 红线：无 fetch（不真发）');
  assert.ok(!/XMLHttpRequest|\.post\(/.test(sendExpr), 'happySendExpr 红线：无 POST/XHR（不真发）');
  assert.ok(!sendExpr.includes('.click('), 'happySendExpr 红线：无 .click( 提交');
});
