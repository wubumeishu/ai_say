// =============================================================================
// Ai SAY · 出会真发端点自检（node --test）
// 断言：
//   1. POST /api/console/send-live 参数缺失 → 400（不打 CDP）；
//   2. 客户不存在 → 404；
//   3. text > 500 → 400；
//   4. deepScrape 未注入 → 501；
//   5. 正常发送（mock deepScrape）→ 200 sent:true，且 toInbox=true 时调用 navigateInbox。
// 约束：mock 本地，不打真实 CDP / 不出会窗口。
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { mountConsoleRoutes } = require('../server/consoleRoutes.js');

function makeApp() {
  const app = {
    __routes: {},
    get(p, h) { app.__routes['GET ' + p] = h; },
    post(p, h) { app.__routes['POST ' + p] = h; },
  };
  return app;
}
function mockRes() {
  const res = {
    _code: null, _body: '',
    writeHead(code, headers) { this._code = code; },
    end(body) { this._body = body; this._done = true; },
    on() {},
  };
  return res;
}
async function callRoute(app, method, path, body) {
  const cleanPath = path.indexOf('?') >= 0 ? path.slice(0, path.indexOf('?')) : path;
  const h = app.__routes[method + ' ' + cleanPath];
  if (!h) throw new Error('route not registered: ' + method + ' ' + cleanPath);
  const req = { method, url: path, path: cleanPath, params: {}, __body: body || {} };
  const res = mockRes();
  await h(req, res, body || {});
  return { status: res._code, data: JSON.parse(res._body) };
}

// mock ichigoCache：一个客户存在 + 一个不存在
function makeIchigoCache() {
  const contacts = {
    'cafe': {
      contactId: 'cafe',
      name: 'たかさん',
      historyUrl: 'https://sp.194964.com/mail/inbox/show_history.html?q=cafe#anchor',
      lastMsgTime: '10/05 15:57',
      messages: [],
    },
  };
  const calls = { setMessages: [] };
  return {
    getContact: (id) => contacts[id] || null,
    getContacts: () => Object.values(contacts),
    setMessages: (id, messages, meta) => { calls.setMessages.push({ id, n: (messages||[]).length }); if (contacts[id]) contacts[id].messages = messages; },
    saveNow: () => {},
    __calls: calls,
  };
}

// mock deepScrape：记录调用
function makeDeepScrape() {
  const calls = { sendToContact: [], navigateInbox: [], fetchHistory: [], mailboxOnly: [] };
  return {
    sendToContact: (historyUrl, text, opts) => {
      calls.sendToContact.push({ historyUrl, text, opts });
      return Promise.resolve({ ok: true, step: 'sent', via: 'in-page-send', sentAt: new Date().toISOString() });
    },
    navigateInbox: () => {
      calls.navigateInbox.push(1);
      return Promise.resolve({ ok: true, url: 'https://sp.194964.com/mail/inbox/show_mailbox.html' });
    },
    fetchHistory: (historyUrl) => {
      calls.fetchHistory.push(historyUrl);
      return Promise.resolve({ ok: true, messages: [{ from: 'self', text: 'こんにちは、送信テストです。', time: '10/05 20:00' }], avatarUrl: '', avatarIsDefault: true });
    },
    mailboxOnly: (opts) => {
      calls.mailboxOnly.push(opts);
      return Promise.resolve({ ok: true, contacts: [] });
    },
    __calls: calls,
  };
}

test('send-live: 参数缺失 → 400', async () => {
  const app = makeApp();
  mountConsoleRoutes(app, { deepScrape: makeDeepScrape(), ichigoCache: makeIchigoCache() });
  const r = await callRoute(app, 'POST', '/api/console/send-live', {});
  assert.strictEqual(r.status, 400, '缺 contactId 应 400');
  const r2 = await callRoute(app, 'POST', '/api/console/send-live', { contactId: 'cafe' });
  assert.strictEqual(r2.status, 400, '缺 text 应 400');
});

test('send-live: 客户不存在 → 404', async () => {
  const app = makeApp();
  mountConsoleRoutes(app, { deepScrape: makeDeepScrape(), ichigoCache: makeIchigoCache() });
  const r = await callRoute(app, 'POST', '/api/console/send-live', { contactId: 'nope', text: 'こんにちは' });
  assert.strictEqual(r.status, 404, '未知客户应 404');
});

test('send-live: text>500 → 400', async () => {
  const app = makeApp();
  mountConsoleRoutes(app, { deepScrape: makeDeepScrape(), ichigoCache: makeIchigoCache() });
  const r = await callRoute(app, 'POST', '/api/console/send-live', { contactId: 'cafe', text: 'あ'.repeat(501) });
  assert.strictEqual(r.status, 400, '超 500 字应 400');
});

test('send-live: deepScrape 未注入 → 501', async () => {
  const app = makeApp();
  mountConsoleRoutes(app, { deepScrape: null, ichigoCache: makeIchigoCache() });
  const r = await callRoute(app, 'POST', '/api/console/send-live', { contactId: 'cafe', text: 'こんにちは' });
  assert.strictEqual(r.status, 501, 'deepScrape 缺省应 501');
});

test('send-live: 正常发送（mock）→ 200 sent:true + navigateInbox 被调用', async () => {
  const app = makeApp();
  const ds = makeDeepScrape();
  mountConsoleRoutes(app, { deepScrape: ds, ichigoCache: makeIchigoCache() });
  const r = await callRoute(app, 'POST', '/api/console/send-live', { contactId: 'cafe', text: 'こんにちは、送信テストです。' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.ok, true, '应 ok:true');
  assert.strictEqual(r.data.data.sent, true, '应 sent:true');
  assert.strictEqual(r.data.data.returnedToInbox, true, '默认 toInbox=true 应返回收件箱');
  assert.strictEqual(ds.__calls.sendToContact.length, 1, 'sendToContact 被调用 1 次');
  assert.strictEqual(ds.__calls.navigateInbox.length, 1, 'navigateInbox 被调用 1 次');
  assert.match(ds.__calls.sendToContact[0].historyUrl, /cafe/);
  // 发送成功后应强制重抓历史 + 刷新收件箱（让前端立即看到刚发出的消息）
  assert.strictEqual(r.data.data.messagesRefreshed, true, '发送成功后应重抓该客户历史');
  assert.strictEqual(ds.__calls.fetchHistory.length, 1, 'fetchHistory 被调用 1 次（重抓历史）');
  assert.strictEqual(ds.__calls.mailboxOnly.length, 1, 'mailboxOnly 被调用 1 次（刷新收件箱列表）');
});

test('send-live: toInbox=false 时不调用 navigateInbox', async () => {
  const app = makeApp();
  const ds = makeDeepScrape();
  mountConsoleRoutes(app, { deepScrape: ds, ichigoCache: makeIchigoCache() });
  await callRoute(app, 'POST', '/api/console/send-live', { contactId: 'cafe', text: 'こんにちは', toInbox: false });
  assert.strictEqual(ds.__calls.navigateInbox.length, 0, 'toInbox=false 不应切收件箱');
});
