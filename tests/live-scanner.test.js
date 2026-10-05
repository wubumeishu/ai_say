// =============================================================================
// Ai SAY M5 核心改造①（task-36）· 实时扫描器自检（tests/live-scanner.test.js）
// 运行：node --test tests/live-scanner.test.js
// 断言：
//   1. /api/console/live 端点挂上后返回真实结构（mock bitbrowser + mock adapter）
//   2. 窗口没开（openLiveCdp 抛错）时端点返回 ok:false 不卡死、不 500
//   3. liveScanner.scanLive 连不上时 { ok:false, reason:'window-not-open' }
// 约束：不改出会 4 方法契约、不写 DOM 逻辑（走 mock adapter.scanMessages/scanProfile）
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createLiveScanner, pickChatTarget } = require('../server/adapter/liveScanner');

// ---- mock DevToolsClient：evaluate 返回可控制的 probe 结果 ----
function mockDevToolsClient({ probeResult, messagesResult, profileResult } = {}) {
  return {
    wsUrl: 'ws://mock/127.0.0.1:51086',
    connected: false,
    connect: async function () { this.connected = true; return this; },
    evaluate: async function (expr) {
      // 模拟：buildProbeJs → probeResult；buildMessageScanJs → messagesResult；buildProfileScanJs → profileResult
      if (expr && String(expr).indexOf('raws') !== -1 && String(expr).indexOf('TreeWalker') !== -1 && String(expr).indexOf('messageContainer') === -1 && probeResult !== undefined) {
        return { value: probeResult };
      }
      if (messagesResult !== undefined) return { value: messagesResult };
      if (profileResult !== undefined) return { value: profileResult };
      return { value: null };
    },
    attachTarget: async function () { return {}; },
    close: function () { this.closed = true; },
  };
}

// ---- mock adapter：4 方法返回可控结构（不改出会契约，仅用于 liveScanner 链路测试） ----
function mockCreateAdapter(platform, opts) {
  return {
    platform,
    cdp: opts && opts.cdp,
    targetId: opts && opts.targetId,
    locatorMissCount: 0,
    async scanMessages() {
      return {
        ok: true,
        source: 'mock-ichigo-message-scan',
        pageKey: 'inbox',
        conversationId: '',
        messages: [
          { index: 0, role: 'peer', original: 'こんにちは', translation: '你好', time: { text: '今日' }, kind: 'text', url: '' },
          { index: 1, role: 'mine', original: 'はい', translation: '是的', time: { text: '今日' }, kind: 'text', url: '' },
        ],
        rows: [
          { index: 0, avatar: '', nickname: 'ともね', gender: '女', age: '38', online: '在线', location: '戸田市', lastMessage: 'こんにちは', time: '今日 14:02', unread: '3', href: 'show_mailbox.html?id=99' },
        ],
        pagination: { hasNext: false },
        scannedAt: new Date().toISOString(),
      };
    },
    async scanProfile() {
      return {
        ok: true,
        source: 'mock-ichigo-profile-scan',
        pageKey: 'profile',
        url: 'https://sp.194964.com/sns/snsmypage/show_profile.html',
        accountPersona: { identity: { ニックネーム: 'ともね', 年齢: '38' }, account: {}, gaps: [], stats: [] },
        customerProfile: { identity: { ニックネーム: 'ともね' }, signals: {}, lastSeen: new Date().toISOString() },
        probe: [],
        miss: null,
        scannedAt: new Date().toISOString(),
      };
    },
    async navigate() { return { ok: true, via: 'url', to: '', url: '', pageKey: '' }; },
    async send() { return { ok: true, mock: true, sentAt: new Date().toISOString(), via: 'mock' }; },
  };
}

// ---- mock bitbrowser：openLiveCdp 可控制 成功/失败 ----
function mockBitbrowser({ shouldFail = false } = {}) {
  return {
    openLiveCdp: async function (windowId) {
      if (shouldFail) throw new Error('ECONNREFUSED 127.0.0.1:54346 窗口没开');
      const client = mockDevToolsClient({});
      await client.connect();
      return { client, ws: 'ws://127.0.0.1:51086/devtools', http: '127.0.0.1:51086', windowId: String(windowId) };
    },
  };
}

test('liveScanner.scanLive 连不上窗口 → { ok:false, reason:window-not-open } 不卡死', async () => {
  const scanner = createLiveScanner({
    bitbrowser: mockBitbrowser({ shouldFail: true }),
    adapterPlatform: 'ichigo194964',
    settings: { apiBase: 'http://127.0.0.1:54346', windowId: 'mock-window' },
    createAdapter: mockCreateAdapter,
  });
  const res = await scanner.scanLive();
  assert.strictEqual(res.ok, false, '窗口没开应 ok:false');
  assert.strictEqual(res.reason, 'window-not-open');
  assert.ok(typeof res.msg === 'string' && res.msg.length > 0, '应带 msg');
});

test('liveScanner.scanLive 成功 → 返回真实结构（contacts/messages/profile/accounts/window）', async () => {
  const scanner = createLiveScanner({
    bitbrowser: mockBitbrowser({ shouldFail: false }),
    adapterPlatform: 'ichigo194964',
    settings: { apiBase: 'http://127.0.0.1:54346', windowId: 'mock-window' },
    createAdapter: mockCreateAdapter,
    fetchTargets: async function () { return [
      { type: 'page', url: 'https://sp.194964.com/mail/inbox/show_mailbox.html', id: 't-chat', webSocketDebuggerUrl: 'ws://1' },
    ]; },
  });
  const res = await scanner.scanLive();
  assert.strictEqual(res.ok, true, '连上应 ok:true');
  assert.ok(res.window, '应带 window 信息');
  assert.strictEqual(res.window.windowId, 'mock-window');
  assert.ok(Array.isArray(res.messages) && res.messages.length === 2, '应带 2 条消息');
  assert.strictEqual(res.messages[0].original, 'こんにちは');
  assert.strictEqual(res.messages[0].translation, '你好');
  assert.ok(res.profile, '应带 profile');
  assert.ok(res.profile.accountPersona && Object.keys(res.profile.accountPersona.identity).length > 0, 'accountPersona.identity 应非空');
  assert.ok(Array.isArray(res.accounts) && res.accounts.length === 1, 'accounts 应 1 条');
  assert.ok(res.contacts, 'contacts 应存在（rows）');
});

test('pickChatTarget 选出会聊天页 target（inbox/非本地优先）', () => {
  const targets = [
    { type: 'browser', url: '', id: 'b1' },
    { type: 'page', url: 'https://console.bitbrowser.net/', id: 'p1', webSocketDebuggerUrl: 'ws://1' },
    { type: 'page', url: 'https://sp.194964.com/mail/inbox/show_mailbox.html', id: 'p2', webSocketDebuggerUrl: 'ws://2' },
  ];
  const picked = pickChatTarget(targets, []);
  assert.strictEqual(picked.id, 'p2', '应选出会 inbox 页');
});

// ---- /api/console/live 端点集成（mountConsoleRoutes + mock liveScanner） ----
test('/api/console/live 端点：liveScanner 注入时返回真实结构', async () => {
  const { mountConsoleRoutes } = require('../server/consoleRoutes');
  const routes = [];
  const consoleApp = { get: (p, h) => routes.push({ method: 'GET', pathname: p, handler: h }), post: (p, h) => routes.push({ method: 'POST', pathname: p, handler: h }) };
  const mockLiveScanner = {
    scanLive: async function () {
      return { ok: true, window: { windowId: 'mock' }, contacts: [{ nickname: 'ともね' }], messages: [{ original: 'hi' }], profile: { accountPersona: { identity: { a: 'b' } } }, scannedAt: new Date().toISOString() };
    },
  };
  mountConsoleRoutes(consoleApp, { liveScanner: mockLiveScanner });
  const route = routes.find((r) => r.pathname === '/api/console/live');
  assert.ok(route, '/api/console/live 路由应已挂载');
// 模拟 http res
  const res = { code: null, body: null, writeHead: function (c) { this.code = c; }, end: function (d) { this.body = d; } };
  await route.handler({ method: 'GET', url: '/api/console/live' }, res);
  assert.strictEqual(res.code, 200, 'live 端点应 200');
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.window.windowId, 'mock');
});

test('/api/console/live 端点：liveScanner 未注入时 501（不卡死不 500）', async () => {
  const { mountConsoleRoutes } = require('../server/consoleRoutes');
  const routes = [];
  const consoleApp = { get: (p, h) => routes.push({ method: 'GET', pathname: p, handler: h }), post: (p, h) => routes.push({ method: 'POST', pathname: p, handler: h }) };
  mountConsoleRoutes(consoleApp, {}); // 无 liveScanner
  const route = routes.find((r) => r.pathname === '/api/console/live');
  assert.ok(route, '路由应仍挂载（缺省依赖）');
  const res = { code: null, body: null, writeHead: function (c) { this.code = c; }, end: function (d) { this.body = d; } };
  await route.handler({ method: 'GET', url: '/api/console/live' }, res);
  assert.strictEqual(res.code, 501, 'liveScanner 未注入应 501');
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.ok, false);
});

test('/api/console/live 端点：liveScanner.scanLive 抛错 → 200 { ok:false }（不 500 不卡死）', async () => {
  const { mountConsoleRoutes } = require('../server/consoleRoutes');
  const routes = [];
  const consoleApp = { get: (p, h) => routes.push({ method: 'GET', pathname: p, handler: h }), post: (p, h) => routes.push({ method: 'POST', pathname: p, handler: h }) };
  const failingScanner = { scanLive: async function () { throw new Error('CDP 断连'); } };
  mountConsoleRoutes(consoleApp, { liveScanner: failingScanner });
  const route = routes.find((r) => r.pathname === '/api/console/live');
  const res = { code: null, body: null, writeHead: function (c) { this.code = c; }, end: function (d) { this.body = d; } };
  await route.handler({ method: 'GET', url: '/api/console/live' }, res);
  assert.strictEqual(res.code, 200, 'scanLive 抛错应 200（软失败）');
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.ok, false);
  assert.strictEqual(parsed.reason, 'scan-exception');
});