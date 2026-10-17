// =============================================================================
// task-H4 · 快乐平台激活抓取（18595 只读端点 + 前端接真数据）
// ① /api/console/happy/inbox 路由存在 + happyScanner mock 数据映射（contacts 字段 name/memberID/mailID 对齐 happyInboxExpr 输出）
// ② happyScanner 未注入 → 501 降级（不 500 不卡死）+ /customer 路由存在 + 缺 id → 400
// 纯路由调用（不 spawn server，mock res 捕获 json），不真连 18595 / 不真发 / os.tmpdir
// =============================================================================
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

function mountRoutes(deps) {
  const { mountConsoleRoutes } = require('../server/consoleRoutes');
  // 伪 app：带 listeners 标记（register 走 native http 退化路径 → app.__consoleRoutes 收集）+ get/post 方法（express 路径兼容）
  const fakeApp = { listeners: true, __consoleRoutes: [] };
  fakeApp.get = function(p, h) { if (!this.__consoleRoutes) this.__consoleRoutes = []; this.__consoleRoutes.push({ method: 'GET', pathname: p, handler: h }); };
  fakeApp.post = function(p, h) { if (!this.__consoleRoutes) this.__consoleRoutes = []; this.__consoleRoutes.push({ method: 'POST', pathname: p, handler: h }); };
  mountConsoleRoutes(fakeApp, deps);
  return { app: fakeApp, routes: fakeApp.__consoleRoutes || [] };
}

async function callRoute(app, pathname, query) {
  const routes = (app && app.__consoleRoutes) || [];
  const r = routes.find((x) => x.pathname === pathname && x.method === 'GET');
  if (!r) return { status: 404, body: { ok: false, reason: 'route-not-found' } };
  const captured = { status: 0, body: null };
  const res = {
    statusCode: 0,
    setHeader() {},
    writeHead(code) { captured.status = code; },
    end(payload) {
      const txt = payload ? String(payload) : '';
      try { captured.body = txt ? JSON.parse(txt) : null; } catch (e) { captured.body = null; }
    },
  };
  const req = { url: pathname + (query ? '?' + query : ''), method: 'GET', __body: {} };
  await r.handler(req, res);
  return { status: captured.status, body: captured.body };
}

function openTmpStore(suffix) {
  const { createStore } = require('../server/db/store.js');
  const TMP_DB = path.join(os.tmpdir(), 'aisay-h4-' + suffix + '-' + process.pid + '.db');
  const store = createStore({ dbPath: TMP_DB });
  return { store, TMP_DB };
}

function cleanup(res2) {
  try { res2.store.close(); } catch (e) {}
  try { require('fs').unlinkSync(res2.TMP_DB); } catch (e) {}
}

// 用例 ①：happy/inbox 路由存在 + 数据映射（contacts 字段 name/memberID/mailID 对齐 happyInboxExpr）
test('task-H4 /api/console/happy/inbox 路由存在 + 数据映射（contacts name/memberID/mailID 对齐）', async () => {
  const mockContacts = [
    { name: 'アルアル', yearMarket: '28歳 東京', lastMessage: 'こんにちは', lastTime: '10/13', memberID: 'm1', mailID: 'b64mail1', raw: 'x' },
    { name: 'ボブ', yearMarket: '30歳 大阪', lastMessage: 'やあ', lastTime: '10/12', memberID: 'm2', mailID: 'b64mail2', raw: 'y' },
  ];
  const mockScanner = {
    _inboxCache: null,
    scanInbox: async () => ({ ok: true, source: 'mock', windowId: '1ccd4351', contacts: mockContacts, unread: '12', fetchedAt: new Date().toISOString() }),
    scanCustomer: async (id) => ({ ok: true, windowId: '1ccd4351', memberID: id, contact: { tid: id }, profile: { fields: {} }, messages: [] }),
  };
  const env1 = openTmpStore('t1');
  try {
    const m = mountRoutes({ store: env1.store, happyScanner: mockScanner, settings: {} });
    const r1 = m.routes.find((x) => x.pathname === '/api/console/happy/inbox' && x.method === 'GET');
    assert.ok(r1, '/api/console/happy/inbox 路由应注册');
    const res = await callRoute(m.app, '/api/console/happy/inbox', 'force=1');
    assert.strictEqual(res.status, 200, 'happy/inbox 应 200（mock 数据）');
    assert.strictEqual(res.body.ok, true, '应 ok:true');
    assert.strictEqual(res.body.windowId, '1ccd4351', 'windowId 应回显 18595 窗口');
    assert.strictEqual(res.body.unread, '12', 'unread 应映射');
    assert.strictEqual(res.body.contacts.length, 2, 'contacts 应 2 条');
    assert.strictEqual(res.body.contacts[0].name, 'アルアル', 'contacts[0].name 对齐 happyInboxExpr');
    assert.strictEqual(res.body.contacts[0].memberID, 'm1', 'contacts[0].memberID 对齐');
    assert.strictEqual(res.body.contacts[0].mailID, 'b64mail1', 'contacts[0].mailID 对齐');
    assert.strictEqual(res.body.contacts[1].yearMarket, '30歳 大阪', 'contacts[1].yearMarket 对齐');
  } finally {
    cleanup(env1);
  }
});

// 用例 ②：happyScanner 未注入 → 501 降级（不 500）+ /customer 路由存在 + 缺 id → 400
test('task-H4 happyScanner 未注入 → 501 降级（不 500）+ /customer 路由存在 + 缺 id → 400', async () => {
  const env0 = openTmpStore('t0');
  try {
    const m0 = mountRoutes({ store: env0.store, happyScanner: null, settings: {} });
    const r1 = m0.routes.find((x) => x.pathname === '/api/console/happy/inbox' && x.method === 'GET');
    const r2 = m0.routes.find((x) => x.pathname === '/api/console/happy/inbox/customer' && x.method === 'GET');
    assert.ok(r1, '/api/console/happy/inbox 路由应注册');
    assert.ok(r2, '/api/console/happy/inbox/customer 路由应注册');
    const res1 = await callRoute(m0.app, '/api/console/happy/inbox', 'force=1');
    assert.strictEqual(res1.status, 501, 'happyScanner 未注入 inbox 应 501 降级（不 500）');
    assert.strictEqual(res1.body.ok, false, '未注入 ok:false');
    assert.strictEqual(res1.body.reason, 'happyScanner-not-injected', 'reason 应标识未注入');
    const res2 = await callRoute(m0.app, '/api/console/happy/inbox/customer', 'id=m1');
    assert.strictEqual(res2.status, 501, '/customer 未注入应 501');
    assert.strictEqual(res2.body.reason, 'happyScanner-not-injected', '/customer 未注入 reason');
  } finally {
    cleanup(env0);
  }
  // 缺 id → 400（注入 scanner 后）
  const mockScanner = {
    _inboxCache: null,
    scanInbox: async () => ({ ok: true, windowId: 'w', contacts: [], unread: '' }),
    scanCustomer: async (id) => ({ ok: true, memberID: id }),
  };
  const env3 = openTmpStore('t3');
  try {
    const m2 = mountRoutes({ store: env3.store, happyScanner: mockScanner, settings: {} });
    const res3 = await callRoute(m2.app, '/api/console/happy/inbox/customer', '');
    assert.strictEqual(res3.status, 400, '缺 id 应 400');
    assert.strictEqual(res3.body.reason, 'missing-memberID', '缺 id reason');
  } finally {
    cleanup(env3);
  }
});
