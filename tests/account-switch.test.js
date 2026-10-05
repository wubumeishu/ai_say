// =============================================================================
// Ai SAY M5 task-25 · 多账号切换自检（node --test）
// 断言：切换账号后 /api/console/customers?accountId= 过滤正确，且 accounts 端点含 active 标记
// =============================================================================
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(__dirname, '..', 'data', 'account_switch_test.db');

const { safeUnlink, onExitUnlink } = require('../.test-setup.js');
onExitUnlink([TMP_DB]);
function cleanup() {
  safeUnlink(TMP_DB);
}

let store, talkEngine, dedup, routes, fakeApp;

async function makeDeps() {
  const { createStore } = require('../server/db/store');
  const { createDedup } = require('../server/db/dedup');
  const { createTalkEngine } = require('../server/acquisition/talkEngine');
  const { mountConsoleRoutes } = require('../server/consoleRoutes');

  store = createStore({ dbPath: TMP_DB });
  dedup = createDedup({ store });
  talkEngine = createTalkEngine({ store, sendHook: null, lineId: 'test-line' });

  fakeApp = { _routes: [], get(p, h) { this._routes.push({ method: 'GET', p, h }); }, post(p, h) { this._routes.push({ method: 'POST', p, h }); } };
  mountConsoleRoutes(fakeApp, { store, talkEngine, dedup, adapters: null });
}

async function invoke(method, pathname, params = {}) {
  const r = fakeApp._routes.find((x) => x.method === method && x.p === pathname);
  assert.ok(r, 'route registered: ' + method + ' ' + pathname);
  // 构造最小 req/res
  const req = { method, url: '/' + pathname.split('/')[1] + '?' + new URLSearchParams(params).toString(), params: {} };
  // 解析 :id
  const parts = pathname.split('/');
  const reqParts = ('/' + req.url.split('?')[0]).split('/');
  reqParts.forEach((part, i) => { if (parts[i] && parts[i].startsWith(':')) req.params[parts[i].slice(1)] = part; });
  const res = { _code: 0, _body: null, writeHead(c, _h) { this._code = c; }, end(b) { this._body = b; } };
  await r.h(req, res);
  return { code: res._code, body: JSON.parse(res._body || '{}') };
}

before(async () => { cleanup(); await makeDeps(); });
after(() => cleanup());

test('accounts 端点返回账号列表（含 active 标记）', async () => {
  // 造 2 个账号（不同平台）
  store.upsertAccountProfile({ windowId: 'w1', platform: 'ichigo', accountLabel: '账号A' });
  store.upsertAccountProfile({ windowId: 'w2', platform: 'fb', accountLabel: '账号B' });
  const r = await invoke('GET', '/api/console/accounts');
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.ok, true);
  assert.ok(Array.isArray(r.body.data) && r.body.data.length >= 2);
  // active 标记：status='active' ⇒ active=true
  const acc = r.body.data[0];
  assert.strictEqual(typeof acc.active, 'boolean');
  assert.strictEqual(acc.active, true);
  assert.strictEqual(acc.windowCount, 1);
});

test('customers?accountId= 只返回该账号会话的客户', async () => {
  // upsertConversation 会把 Account 归一化为 sha1('acc/<platform>/<windowId>/<label>')，
  // 其中 label = contactKey（legacy.label）。所以会话挂在「以 contactKey 为 label 的账号」下。
  // 用 upsertAccountProfile 预建同一三元组的账号，保证 Conversation.accountId 可命中。
  store.upsertAccountProfile({ windowId: 'w1', platform: 'ichigo', accountLabel: 'cust-A' });
  store.upsertAccountProfile({ windowId: 'w2', platform: 'fb', accountLabel: 'cust-B' });
  const ca = store.upsertContact({ windowId: 'w1', platform: 'ichigo', contactKey: 'cust-A', contact: { name: '客户甲' } });
  const cb = store.upsertContact({ windowId: 'w2', platform: 'fb', contactKey: 'cust-B', contact: { name: '客户乙' } });
  store.upsertConversation({ windowId: 'w1', platform: 'ichigo', contactKey: 'cust-A', contactName: 'cust-A', contact: { name: '客户甲' }, messages: [{ role: 'other', original: 'hi', index: 0 }] });
  store.upsertConversation({ windowId: 'w2', platform: 'fb', contactKey: 'cust-B', contactName: 'cust-B', contact: { name: '客户乙' }, messages: [{ role: 'other', original: 'hello', index: 0 }] });

  // 会话所属账号由 upsertConversation 归一化 = sha1('acc/<platform>/<windowId>/<contactKey>')
  // 可能已有「账号A/B」账号（来自上一个测试），必须按 label 精确匹配 cust-A / cust-B
  const accA = store.listAccountProfiles({ windowId: 'w1', platform: 'ichigo' })
    .find((a) => a.label === 'cust-A').accountId;
  const accB = store.listAccountProfiles({ windowId: 'w2', platform: 'fb' })
    .find((a) => a.label === 'cust-B').accountId;
  assert.ok(accA, '应找到 cust-A 账号');
  assert.ok(accB, '应找到 cust-B 账号');

  // 全部账号
  const all = await invoke('GET', '/api/console/customers');
  assert.strictEqual(all.code, 200);
  assert.ok(all.body.data.length >= 2, '全部账号应有 ≥2 个客户');

  // 仅账号A
  const onlyA = await invoke('GET', '/api/console/customers', { accountId: accA });
  assert.strictEqual(onlyA.code, 200);
  const idsA = onlyA.body.data.map((c) => c.contactId);
  assert.ok(idsA.includes(ca.contactId), '账号A 的客户甲应在列表中');
  assert.ok(!idsA.includes(cb.contactId), '账号B 的客户乙不应出现在账号A 过滤中');

  // 仅账号B
  const onlyB = await invoke('GET', '/api/console/customers', { accountId: accB });
  const idsB = onlyB.body.data.map((c) => c.contactId);
  assert.ok(idsB.includes(cb.contactId));
  assert.ok(!idsB.includes(ca.contactId));
});
