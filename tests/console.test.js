// =============================================================================
// M5 控制台自检（node --test）
// 临时 http server + 临时 db，断言：
//   1. GET /console → 200 且 body 含 'console' 关键字
//   2. GET /api/console/customers → 200 且 data 是数组
//   3. GET /api/console/metrics   → 200 且 data 含 4 大指标字段
// =============================================================================
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

// 临时 db
const TMP_DB = path.join(__dirname, '..', 'data', 'console_test.db');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

let server = null;
let baseUrl = null;

function cleanupDb() {
  try { fs.unlinkSync(TMP_DB); } catch {}
}

// 直接构造一个最小 store（不依赖 index.js 里的生产 db），避免污染生产库
async function makeTempStoreAndApp() {
  const { createStore } = require('../server/db/store');
  const { createDedup } = require('../server/db/dedup');
  const { createTalkEngine } = require('../server/acquisition/talkEngine');
  const { mountConsoleRoutes } = require('../server/consoleRoutes');
  const { IchigoAdapter } = require('../server/adapter/ichigo194964');

  const store = createStore({ dbPath: TMP_DB });
  const dedup = createDedup({ store });
  const talkEngine = createTalkEngine({
    store,
    aiService: require('../server/aiService'),
    templatesDir: path.join(__dirname, '..', 'server', 'acquisition', 'templates'),
    sendHook: null,
    lineId: 'test-line',
  });
  const adapters = {
    ichigo194964: {
      name: 'ichigo194964',
      create: (cdp, targetId, opts = {}) =>
        new IchigoAdapter(Object.assign({ cdp, targetId, platform: 'ichigo194964' }, opts)),
    },
  };

  // 挂 console 路由
  const routes = [];
  const fakeApp = {
    get: (p, h) => { routes.push({ method: 'GET', pathname: p, handler: h }); },
    post: (p, h) => { routes.push({ method: 'POST', pathname: p, handler: h }); },
  };
  mountConsoleRoutes(fakeApp, { store, talkEngine, dedup, adapters });

  // 造一条测试数据
  const nowIso = new Date().toISOString();
  const contactId = sha1('console-test/contact-1');
  store.db.prepare(
    'INSERT OR IGNORE INTO Contact (contactId,displayName,nickname,mergedInto,firstSeen,lastSeen,lifecycle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(contactId, '测试客户', 'test-customer', null, nowIso, nowIso, 'new', nowIso, nowIso);
  store.db.prepare(
    'INSERT OR REPLACE INTO ContactProfile (contactId,age,region,height,occupation,language,intent,interests,historySummary,fields,confidence,source,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(contactId, '30', '东京', null, null, 'ja', 'serious', null, 'test', null, 0.5, 'profile_page', nowIso, nowIso);

  // 组装 app handler（静态 + 控制台路由 + 404）
  function matchRoute(req, res) {
    const pathname = String(req.url || '').split('?')[0];
    for (const r of routes) {
      if (r.method !== req.method) continue;
      if (r.pathname === pathname) {
        req.params = {};
        return r.handler(req, res);
      }
      const pm = pathname.match(/^\/api\/console\/(customers|accounts)\/([^\/?]+)(\/profile)?$/);
      if (pm && r.pathname === '/api/console/' + pm[1] + '/:id' + (pm[3] || '')) {
        req.params = { id: pm[2] };
        return r.handler(req, res);
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, msg: 'Not Found' }));
  }

  const app = (req, res, notFound) => {
    const pathname = String(req.url || '').split('?')[0];
    if (pathname.indexOf('/api/console') === 0) return matchRoute(req, res);
    if (req.method === 'GET' && (pathname === '/console' || pathname === '/console.html')) {
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'console.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (notFound) return notFound();
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, msg: 'Not Found' }));
  };

  server = http.createServer((req, res) => app(req, res, null));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  return { store, contactId };
}

test('M5 控制台自检', async (t) => {
  cleanupDb();
  const { contactId } = await makeTempStoreAndApp();

  async function get(pathname) {
    const res = await fetch(baseUrl + pathname);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, text };
  }

  // 1. GET /console → 200 且含 'console' 关键字
  await t.test('GET /console → 200 且含 console 关键字', async () => {
    const { status, text } = await get('/console');
    assert.strictEqual(status, 200, '/console 应返回 200');
    assert.ok(text.includes('console'), 'body 应含 console 关键字');
  });

  // 2. GET /api/console/customers → 200 且 data 是数组
  await t.test('GET /api/console/customers → data 是数组', async () => {
    const { status, body } = await get('/api/console/customers');
    assert.strictEqual(status, 200);
    assert.ok(body.ok === true, 'ok 应为 true');
    assert.ok(Array.isArray(body.data), 'data 应为数组');
  });

  // 3. GET /api/console/metrics → 200 且含 4 指标字段
  await t.test('GET /api/console/metrics → 含 4 指标', async () => {
    const { status, body } = await get('/api/console/metrics');
    assert.strictEqual(status, 200);
    assert.ok(body.ok === true);
    const d = body.data;
    assert.ok(d.autoHandling, '应含 autoHandling（自动处理覆盖率）');
    assert.ok(d.leadAcquisition, '应含 leadAcquisition（引流成功率）');
    assert.ok(d.lineConversion, '应含 lineConversion（LINE 转化率）');
    assert.ok(d.dedup, '应含 dedup（去重准确率）');
    assert.ok(typeof d.autoHandling.rate === 'number', 'autoHandling.rate 应为 number');
  });

  // 4. 额外：customers/:id 参数路由
  await t.test('GET /api/console/customers/:id → 200', async () => {
    const { status, body } = await get('/api/console/customers/' + contactId);
    assert.strictEqual(status, 200);
    assert.ok(body.ok === true);
    assert.strictEqual(body.data.contact.contactId, contactId);
  });

  // 5. 额外：likely-same 队列端点
  await t.test('GET /api/console/likely-same → 200 数组', async () => {
    const { status, body } = await get('/api/console/likely-same');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.data));
  });

  await new Promise((resolve) => server.close(resolve));
  cleanupDb();
});
