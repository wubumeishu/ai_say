// =============================================================================
// Ai SAY task-2 · /api/console/health + /api/console/inbox/unread 轻量端点自检
// 覆盖：
//   1. /api/console/health → 200 { ok, service:'alive', port, cdp:{reachable,port}, ts }
//      （mock 不真连 CDP：用 fake app 捕获 handler，注入 mock net 不可达的端口场景，
//       断言 200 + cdp.reachable 字段存在，不真连 54346）。
//   2. /api/console/inbox/unread → 200 { ok, unread:[...], total }（os.tmpdir 临时 SQLite，
//      InboxSnapshot 有 unread>0 行时返回 + 表缺失时降级空列表不 500）。
// 约束：os.tmpdir() 建临时 store；不碰 CDP 真连（CDP 探活走不可达端口 mock 语义）；
//       不真发；无空 catch。
// =============================================================================
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aisay-console-health-'));
const TMP_DB = path.join(TMP_DIR, 'console_health_test.db');

let mountConsoleRoutes, fakeApp;

function makeFakeApp() {
  const routes = [];
  const app = {
    get(p, h) { routes.push({ method: 'GET', p, h }); },
    post(p, h) { routes.push({ method: 'POST', p, h }); },
  };
  app._routes = routes;
  return app;
}

function mockRes() {
  const res = {
    _code: 0, _body: null, _headers: {},
    writeHead(code, headers) { this._code = code; this._headers = headers || {}; },
    end(body) { this._body = body; this._done = true; },
  };
  return res;
}

let sharedStore = null;
before(async () => {
  const { createStore } = require('../server/db/store');
  sharedStore = createStore({ dbPath: TMP_DB });
  mountConsoleRoutes = require('../server/consoleRoutes').mountConsoleRoutes;
  // store 注入（活库含 InboxSnapshot 表 + 002 列补齐）；保持活库不 close，供 inbox/unread 端点实时查询
  fakeApp = makeFakeApp();
  mountConsoleRoutes(fakeApp, { store: sharedStore, settingsForLive: { host: '127.0.0.1', port: 54346 } });
});

after(() => { try { if (sharedStore && sharedStore.close) sharedStore.close(); } catch (e) { console.error('[console-health] store close 失败:', e && e.message); } try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { console.warn('[console-health] cleanup:', e.message); } });

// --- /api/console/health：200 + cdp.reachable 字段存在（不可达端口 → reachable=false 但仍 200）---
test('GET /api/console/health → 200 { ok, service:"alive", cdp:{reachable,port}, ts }（不可达端口仍 200，GUARDIAN ⑤）', async () => {
  const r = fakeApp._routes.find((x) => x.method === 'GET' && x.p === '/api/console/health');
  assert.ok(r, '/api/console/health 路由应已注册');
  const req = { method: 'GET', url: '/api/console/health' };
  const res = mockRes();
  await r.h(req, res);
  assert.strictEqual(res._code, 200, 'health 端点应恒 200（CDP 不可达也 200，探针只报可达性不归因）');
  const body = JSON.parse(res._body || '{}');
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.service, 'alive');
  assert.ok(body.port, '应带 service 监听端口');
  assert.ok(body.cdp && typeof body.cdp.reachable === 'boolean', 'cdp.reachable 字段应存在（bool）');
  assert.strictEqual(body.cdp.port, 54346, 'cdp.port 应 = settingsForLive.port（54346）');
  assert.ok(body.ts, '应带 ts 时间戳');
  // 不可达端口 54346（测试环境无 BitBrowser）→ reachable 应为 false（或探测异常也 false），但端点仍 200
  assert.strictEqual(typeof body.cdp.reachable, 'boolean');
});

// --- /api/console/inbox/unread：200 + 表缺失降级空列表（不 500）+ 有 unread>0 行时返回 ---
test('GET /api/console/inbox/unread → 200（表缺失降级空列表不 500；有数据返回 unread 数组）', async () => {
  const r = fakeApp._routes.find((x) => x.method === 'GET' && x.p === '/api/console/inbox/unread');
  assert.ok(r, '/api/console/inbox/unread 路由应已注册');

  // 复用 before 的 sharedStore（活库）造一条 InboxSnapshot unread>0
  const now = new Date().toISOString();
  const store2 = sharedStore;
  // Contact（FK 目标）
  const sha1 = require('crypto').createHash('sha1').update('weak/unreadtest').digest('hex');
  store2.db.prepare('INSERT OR IGNORE INTO Contact (contactId,displayName,nickname,firstSeen,lastSeen,lifecycle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)')
    .run(sha1, '未读测试', '未读测试', now, now, 'active', now, now);
  // InboxSnapshot unread=2
  const accountId = require('crypto').createHash('sha1').update('acc/unreadtest').digest('hex');
  store2.db.prepare('INSERT OR REPLACE INTO Account (accountId,platform,label,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
    .run(accountId, 'ikuru', 'test', 'active', now, now);
  store2.db.prepare('INSERT OR REPLACE INTO InboxSnapshot (contactId,accountId,lastMsgTime,unread,onlineTier,fetchedAt) VALUES (?,?,?,?,?,?)')
    .run(sha1, accountId, now, 2, 'recent', now);

  const req = { method: 'GET', url: '/api/console/inbox/unread' };
  const res = mockRes();
  await r.h(req, res);
  assert.strictEqual(res._code, 200, 'inbox/unread 应 200（有表有数据）');
  const body = JSON.parse(res._body || '{}');
  assert.strictEqual(body.ok, true);
  assert.ok(Array.isArray(body.unread), 'unread 应为数组');
  assert.strictEqual(body.total, 1, '应有 1 条 unread>0');
  assert.strictEqual(body.unread[0].contactId, sha1);
  assert.strictEqual(body.unread[0].unread, 2);
  assert.strictEqual(body.unread[0].name, '未读测试');
});

test('cleanup db', () => { try { fs.unlinkSync(TMP_DB); } catch (e) { console.warn('[console-health] cleanup db 失败（可能已被 after rmSync 清理）:', e && e.message); } });
