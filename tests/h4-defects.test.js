
// =============================================================================
// H4 缺陷 6 · 缓存(brief) + expand 循环 用例（os.tmpdir mock scanner，不真连 CDP）
// =============================================================================
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');


const path6 = require('path');
const os6 = require('os');

// 缓存层：happyCache inbox/customer/brief 读写（TTL + stale 降级）
test('H4 缺陷6 缓存层 happyCache：inbox/customer 读写 + brief 取有 messages 客户 + TTL 新鲜/stale', async () => {
  const { createHappyCache } = require('../server/adapter/happyCache');
  const { createStore } = require('../server/db/store.js');
  const tmp = path6.join(os6.tmpdir(), 'aisay-h46-cache-' + process.pid + '.json');
  const hc = createHappyCache({ filePath: tmp, inboxTtlMs: 5 * 60 * 1000 });
  // 空缓存
  assert.strictEqual(hc.getInbox({}), null, '空缓存 getInbox=null');
  // 写收件箱
  hc.upsertInbox({ contacts: [{ memberID: 'm1', name: 'A', mailID: 'x' }], unread: '2', windowId: 'w' });
  const gi = hc.getInbox({});
  assert.strictEqual(gi.cached, true, '新鲜窗口 getInbox.cached=true');
  assert.strictEqual(gi.contacts.length, 1, 'contacts 回写');
  // 写客户（含 messages）
  hc.upsertCustomer('m1', { fields: { age: '30' } }, [{ role: 'other', text: 'hi' }], 'mail-x');
  const gc = hc.getCustomer('m1', {});
  assert.strictEqual(gc.cached, true, '新鲜 getCustomer.cached=true');
  assert.strictEqual(gc.messages.length, 1, 'messages 回写');
  // brief：取最近 1 个 messages>0 的客户
  const brief = hc.getBrief();
  assert.strictEqual(brief.memberID, 'm1', 'brief 取到 m1（有 messages）');
  // stale 降级：先关 hc（触发 saveNow 落盘）再建 hc2（TTL 0 强制过期）→ getInbox({stale:true}) 仍回旧值
  hc.close();
  const hc2 = createHappyCache({ filePath: tmp, inboxTtlMs: 0 });
  const stale = hc2.getInbox({ stale: true });
  assert.ok(stale, 'stale=true 即使过期也回旧值（不回空）');
  assert.strictEqual(stale.contacts.length, 1, 'stale 降级 contacts 仍在');
  hc2.close();
  try { require('fs').unlinkSync(tmp); } catch (e) {}
});

// /brief 端点：从缓存取客户（无缓存+无 scanner → 501；有缓存 → 200）
test('H4 缺陷6 /happy/inbox/brief：有缓存取客户（200）+ 全空 empty:true', async () => {
  const { mountConsoleRoutes } = require('../server/consoleRoutes');
  const { createHappyCache } = require('../server/adapter/happyCache');
  const { createStore } = require('../server/db/store.js');
  const tmpDb = path6.join(os6.tmpdir(), 'aisay-h46-db-' + process.pid + '.db');
  const store = createStore({ dbPath: tmpDb });
  const tmpCache = path6.join(os6.tmpdir(), 'aisay-h46-c-' + process.pid + '.json');
  const hc = createHappyCache({ filePath: tmpCache });
  hc.upsertCustomer('m9', { fields: { name: 'z' } }, [{ role: 'self', text: 'yo' }], 'mail9');
  const fakeApp = { listeners: true, __consoleRoutes: [] };
  fakeApp.get = function (p, h) { this.__consoleRoutes.push({ method: 'GET', pathname: p, handler: h }); };
  fakeApp.post = function (p, h) { this.__consoleRoutes.push({ method: 'POST', pathname: p, handler: h }); };
  mountConsoleRoutes(fakeApp, { store, happyScanner: null, happyCache: hc, settings: {} });
  const r = fakeApp.__consoleRoutes.find((x) => x.pathname === '/api/console/happy/inbox/brief' && x.method === 'GET');
  assert.ok(r, '/brief 路由应注册');
  const cap = { status: 0, body: null };
  const res = { statusCode: 0, setHeader() {}, writeHead(code) { cap.status = code; }, end(p) { try { cap.body = JSON.parse(String(p || '')); } catch (e) { cap.body = null; } } };
  await r.handler({ url: '/api/console/happy/inbox/brief', method: 'GET', __body: {} }, res);
  assert.strictEqual(cap.status, 200, '/brief 有缓存应 200');
  assert.strictEqual(cap.body.ok, true, 'brief ok');
  assert.strictEqual(cap.body.empty, false, '有 messages 客户 empty=false');
  assert.strictEqual(cap.body.memberID, 'm9', 'brief 取到 m9');
  // 全空场景：新缓存（无 customers）→ empty:true
  const hcEmpty = createHappyCache({ filePath: path6.join(os6.tmpdir(), 'aisay-h46-empty-' + process.pid + '.json') });
  const fakeApp2 = { listeners: true, __consoleRoutes: [] };
  fakeApp2.get = function (p, h) { this.__consoleRoutes.push({ method: 'GET', pathname: p, handler: h }); };
  fakeApp2.post = function (p, h) { this.__consoleRoutes.push({ method: 'POST', pathname: p, handler: h }); };
  mountConsoleRoutes(fakeApp2, { store, happyScanner: null, happyCache: hcEmpty, settings: {} });
  const r2 = fakeApp2.__consoleRoutes.find((x) => x.pathname === '/api/console/happy/inbox/brief' && x.method === 'GET');
  const cap2 = { status: 0, body: null };
  const res2 = { statusCode: 0, setHeader() {}, writeHead(code) { cap2.status = code; }, end(p) { try { cap2.body = JSON.parse(String(p || '')); } catch (e) { cap2.body = null; } } };
  await r2.handler({ url: '/api/console/happy/inbox/brief', method: 'GET', __body: {} }, res2);
  assert.strictEqual(cap2.status, 200, '/brief 全空也应 200');
  assert.strictEqual(cap2.body.empty, true, '全空 empty:true');
  try { store.close(); } catch (e) {}
  hc.close(); hcEmpty.close();
  try { require('fs').unlinkSync(tmpDb); } catch (e) {}
});

// /happy/inbox 缓存命中：scanner 返回 ok 后回写缓存，再查 cached:true（mock 不真连）
test('H4 缺陷6 /happy/inbox 缓存优先：mock scanner ok → 回写缓存（cached 可复用）', async () => {
  const { mountConsoleRoutes } = require('../server/consoleRoutes');
  const { createHappyCache } = require('../server/adapter/happyCache');
  const { createStore } = require('../server/db/store.js');
  const tmpDb = path6.join(os6.tmpdir(), 'aisay-h46-db2-' + process.pid + '.db');
  const store = createStore({ dbPath: tmpDb });
  const tmpCache = path6.join(os6.tmpdir(), 'aisay-h46-c2-' + process.pid + '.json');
  const hc = createHappyCache({ filePath: tmpCache });
  let scannerCalls = 0;
  const mockScanner = {
    _inboxCache: null,
    scanInbox: async (more, opts) => { scannerCalls++; return { ok: true, windowId: 'w', contacts: [{ memberID: 'm1', name: 'A' }], unread: '0', more: !!more, fetchedAt: new Date().toISOString() }; },
    scanCustomer: async () => ({ ok: true }),
  };
  const fakeApp = { listeners: true, __consoleRoutes: [] };
  fakeApp.get = function (p, h) { this.__consoleRoutes.push({ method: 'GET', pathname: p, handler: h }); };
  fakeApp.post = function (p, h) { this.__consoleRoutes.push({ method: 'POST', pathname: p, handler: h }); };
  mountConsoleRoutes(fakeApp, { store, happyScanner: mockScanner, happyCache: hc, settings: {} });
  const r = fakeApp.__consoleRoutes.find((x) => x.pathname === '/api/console/happy/inbox' && x.method === 'GET');
  assert.ok(r, '/happy/inbox 路由');
  const cap = { status: 0, body: null };
  const res = { statusCode: 0, setHeader() {}, writeHead(code) { cap.status = code; }, end(p) { try { cap.body = JSON.parse(String(p || '')); } catch (e) { cap.body = null; } } };
  await r.handler({ url: '/api/console/happy/inbox?force=1', method: 'GET', __body: {} }, res);
  assert.strictEqual(cap.status, 200, '首次应 200');
  assert.strictEqual(cap.body.contacts.length, 1, 'contacts 映射');
  // scanner 真连过 1 次；回写缓存后 getInbox 有数据
  const cached = hc.getInbox({});
  assert.strictEqual(cached.contacts.length, 1, '成功后回写缓存（cached 可复用，下次 5min 内不真连）');
  assert.strictEqual(scannerCalls, 1, '本次 force=1 真连 1 次');
  try { store.close(); } catch (e) {}
  hc.close();
  try { require('fs').unlinkSync(tmpDb); } catch (e) {}
});
