// =============================================================================
// Ai SAY M5 · 实时抓出会页面（liveScanner.js）
// 依据：task-36。链路：BitBrowserClient.openLiveCdp(windowId) → DevToolsClient
//       → fetchDevtoolsTargetList(http) 找出会页面 target → adapter.scanMessages/scanProfile
//       → 返回真实 客户列表 + 消息流 + 画像。
// 约束：不改出会 4 方法契约、不写 DOM 逻辑（全走 adapter.scanMessages/scanProfile）；
//       窗口没开 / 连接失败时返回 { ok:false, reason }，不卡死。
// =============================================================================
'use strict';

const { BitBrowserClient } = require('../bitbrowser');
const { fetchDevtoolsTargetList, pickProfileTarget, isLocalHost } = require('../devtoolsTargets');

// 选出会「聊天/消息」页 target：优先非本地 + 含 inbox/message/show_mailbox 的 page target
function pickChatTarget(targets, patterns) {
  const list = Array.isArray(targets) ? targets : [];
  const pages = list.filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) return null;
  const remote = pages.filter((t) => !isLocalHost(t.url));
  const pool = remote.length ? remote : pages;
  const pats = Array.isArray(patterns) && patterns.length ? patterns
    : ['inbox', 'show_mailbox', 'message', 'messages', 'chat', 'conversation'];
  const match = pool.find((t) => {
    const u = String(t.url || '').toLowerCase();
    return pats.some((p) => u.indexOf(String(p).toLowerCase()) !== -1);
  });
  if (match) return match;
  const nonConsole = pool.find((t) => String(t.url || '').indexOf('console.bitbrowser.net') === -1);
  return nonConsole || pool[0] || null;
}

/**
 * 创建实时扫描器。
 * @param {object} deps
 * @param {BitBrowserClient} deps.bitbrowser  已指向 17098 端口（54346）的客户端
 * @param {string}  deps.adapterPlatform      平台 id（'ichigo194964'），经 createAdapter 构建
 * @param {function} [deps.createAdapter]      注入 createAdapter（默认 require('../adapter').createAdapter）
 * @param {object}  [deps.settings]            { apiBase, windowId }，缺省从 settings.json 读
 * @returns {object} { scanLive, close }
 */
function createLiveScanner(deps = {}) {
  let closed = false;
  let lastClient = null;

  const settings = deps.settings || {};
  const windowId = deps.windowId || settings.windowId || null;
  const apiBase = settings.apiBase || 'http://127.0.0.1:54346';

  const bit = deps.bitbrowser || new BitBrowserClient(apiBase);
  const createAdapter = deps.createAdapter || require('../adapter/platformAdapter').createAdapter;
  // 允许注入 fetchDevtoolsTargetList（测试用 mock；缺省用真实的）
  const fetchTargets = deps.fetchTargets || fetchDevtoolsTargetList;

  /**
   * 抓一次出会页面真实数据。
   * @returns {Promise<{ok:boolean, reason?:string, window?:object, accounts?:Array, contacts?:Array, messages?:Array, profile?:object}>}
   */
  async function scanLive() {
    if (closed) return { ok: false, reason: 'scanner-closed' };
    if (!windowId) return { ok: false, reason: 'no-window-configured' };
    let live;
    try {
      live = await bit.openLiveCdp(windowId);
    } catch (err) {
      return { ok: false, reason: 'window-not-open', msg: String(err && err.message || err) };
    }
    const client = live.client;
    lastClient = client;
    const result = {
      ok: true,
      source: 'live-cdp-ichigo',
      window: {
        windowId,
        ws: live.ws,
        http: live.http,
      },
      accounts: [],
      contacts: [],
      messages: [],
      profile: null,
      targetUrl: '',
      scannedAt: new Date().toISOString(),
    };
    try {
      // 1) 找出会聊天页 target
      const targets = await fetchTargets(live.http || live.ws);
      const chat = pickChatTarget(targets, deps.chatPatterns);
      if (!chat) {
        result.ok = false;
        result.reason = 'no-chat-target';
        result.targets = (Array.isArray(targets) ? targets : []).map((t) => ({ type: t.type, url: t.url, id: t.id }));
        return result;
      }
      result.targetUrl = String(chat.url || '');
      try { await client.attachTarget(chat.id, true); } catch (_) { /* attach 失败仍继续（eval 可无 targetId） */ }

      // 2) 构建出会适配器（注入 DevToolsClient + 聊天 target）
      const adapter = createAdapter(String(deps.adapterPlatform || 'ichigo194964'), {
        cdp: client,
        targetId: chat.id,
        emit: () => {}, // 控制台实时端点不重复告警（locator-misses 端点另有事件源）
      });

      // 3) 抓聊天页消息流（基类 scanMessages：inbox 行 / 聊天页气泡）
      let msgScan = null;
      try { msgScan = await adapter.scanMessages(deps.conversationId || ''); } catch (_) { msgScan = null; }
      if (msgScan && Array.isArray(msgScan.messages)) {
        result.messages = msgScan.messages;
        result.peer = msgScan.peer || null;
      } else if (msgScan && Array.isArray(msgScan.rows)) {
        result.contacts = msgScan.rows;
      }

      // 4) 抓账号画像（基类 scanProfile：accountPersona / customerProfile）
      let profScan = null;
      try { profScan = await adapter.scanProfile(); } catch (_) { profScan = null; }
      if (profScan) {
        result.profile = {
          accountPersona: profScan.accountPersona || null,
          customerProfile: profScan.customerProfile || null,
          pageKey: profScan.pageKey || '',
          url: profScan.url || '',
        };
        if (profScan.accountPersona && profScan.accountPersona.identity && Object.keys(profScan.accountPersona.identity).length) {
          result.accounts.push(profScan.accountPersona);
        }
      }

      // 5) 定位失败告警（基类已 onLocatorMiss；这里把累计计数回传，供 M5 健康面板）
      result.locatorMissCount = adapter.locatorMissCount || 0;

      return result;
    } catch (err) {
      result.ok = false;
      result.reason = 'scan-failed';
      result.msg = String(err && err.message || err);
      return result;
    } finally {
      // 控制台实时端点用完即断（避免占用窗口 CDP）；若调用方要长连接可传 keepAlive:true
      if (!deps.keepAlive) {
        try { client.close(); } catch (_) { /* ignore */ }
        lastClient = null;
      }
    }
  }

  function close() {
    closed = true;
    if (lastClient) { try { lastClient.close(); } catch (_) {} lastClient = null; }
  }

  /**
   * 开一个 CDP 会话（只开窗口拿 client + targets，不跑扫描逻辑），供深度抓取器复用。
   * @returns {Promise<{client, targets, ws, http, close}>}
   */
  async function openCdpSession() {
    if (closed) throw new Error('scanner-closed');
    if (!windowId) throw new Error('no-window-configured');
    let live;
    try {
      live = await bit.openLiveCdp(windowId);
    } catch (err) {
      const e = new Error(err && err.message || String(err));
      e.reason = 'window-not-open';
      throw e;
    }
    const client = live.client;
    lastClient = client;
    let targets = [];
    try { targets = (await fetchTargets(live.http || live.ws)) || []; } catch (_) { targets = []; }
    return {
      client,
      targets,
      ws: live.ws,
      http: live.http,
      close: () => { try { client.close(); } catch (_) {} lastClient = null; }
    };
  }

  return { scanLive, openCdpSession, close, get windowId() { return windowId; } };
}

module.exports = { createLiveScanner, pickChatTarget };