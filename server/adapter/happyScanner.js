// =============================================================================
// 快乐平台（happymail.co.jp）实时抓取器（H4 工单 · 只读激活 18595 窗口）
// 复用出会 CDP 机制（bitbrowser.openLiveCdp + devtools.js DevToolsClient + devtoolsTargets），
//   不重造 CDP 通道；按页面状态 eval 7 个 happy*Expr.js（IIFE 字符串，CDP 页面内执行）。
//   Bug 1 修复：eval/navigate 走 DevToolsClient.evaluatePage（页面级 ws 直连 /json/list target.webSocketDebuggerUrl，
//   不依赖 Target.attachToTarget 会话路由——会话路由偶发 'Runtime.evaluate wasn't found'，页面级 ws 直连可靠）。
//   - 收件箱 message_list.php → eval happyInboxExpr → { contacts, unread }
//   - 客户详情 profile_detail.php?tid={memberID} → navigate + eval happyProfileDetailExpr
//   - 会话历史 message_detail.php?mailID={b64} → navigate + eval happyHistoryExpr
//   - 客源 3 路（type_list/profile_list/keijiban）→ navigate + eval 对应 sourceExprs
// 风控红线：只读 CDP + navigate(location.href) + eval 抽取；**绝不 eval 发送 Expr 触发发送 /
//   不点批量删/无视/全既读入口 / 不换 IP / 不动 18595 登录态**（happySendExpr 只保留测绘注释不执行）。
// 降级：窗口未开 / CDP 不可达 / 无 happymail target → { ok:false, reason }，不 500 不卡死（仿 liveScanner）。
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

// 7 个 happy*Expr.js（IIFE 字符串，CDP eval 用）
function loadExpr(name) {
  try {
    return fs.readFileSync(path.join(__dirname, name), 'utf8');
  } catch (e) {
    console.error('[happyScanner.loadExpr] 读取 ' + name + ' 失败:', e && e.message);
    return '';
  }
}

const EXPR_INBOX = loadExpr('happyInboxExpr.js');
const EXPR_HISTORY = loadExpr('happyHistoryExpr.js');
const EXPR_PROFILE_DETAIL = loadExpr('happyProfileDetailExpr.js');
const EXPR_PROFILE_SEARCH = loadExpr('happyProfileSearchExpr.js');
const EXPR_TYPE = loadExpr('happyTypeExpr.js');
const EXPR_BILLBOARD = loadExpr('happyBillboardExpr.js');
const EXPR_ASHIATO = loadExpr('happyAshiatoExpr.js');
const EXPR_LOAD_MORE = loadExpr('happyLoadMoreExpr.js');
// v5.2 新增：客户招募帖（只读情报维度：帖子列表 + 单帖正文/标签，均 .php 服务端渲染页）
const EXPR_BILLBOARD_LIST = loadExpr('happyBillboardListExpr.js');
const EXPR_BILLBOARD_DETAIL = loadExpr('happyBillboardDetailExpr.js');
// 红线：本 Scanner 不装载/不 eval 发送 Expr（只读不真发，happySend 仅测绘注释不执行）

// happymail 平台匹配 url
const HAPPY_MATCH = 'happymail.co.jp';

/**
 * 创建快乐抓取器。
 * @param {object} deps
 * @param {string}  deps.windowId      快乐窗口 windowId（1ccd4351...，seq 18595）
 * @param {BitBrowserClient} deps.bitbrowser  已指向 54346 的客户端（复用出会机制）
 * @param {object}  [deps.settings]    { apiBase }
 * @param {function} [deps.fetchTargets]  注入 fetchDevtoolsTargetList（测试 mock；缺省真实）
 * @returns {object} { scanInbox, scanCustomer, scanSource, openCdpSession, close }
 *   scanInbox(more)：more=true 先点收件箱自身「もっと見る」分页加载（合法只读，不导航/不批量删/不发送）再抓全部；
 *     more=false 抓当前已渲染的 5 位（页面 JS 填充一批）。风控边界：只点收件箱自身分页，不点批量删/无视/全既读/发送。
 */
function createHappyScanner(deps = {}) {
  let closed = false;
  let lastClient = null;

  // 2026-11-02 手动窗口控制：autoOpenWindow=false 时 openLiveCdp 前先只读探测；未开 → 不自动启动（上层 catch 降级）
  const autoOpenWindow = deps.autoOpenWindow !== undefined ? deps.autoOpenWindow : true;
  async function openLiveCdpSafe() {
    if (autoOpenWindow === false) {
      // 只读探测：/browser/list 翻页找窗口 status（BitBrowserClient.call 已解包 .data，取 resp.list；
      // 服务端每页上限 100，18595 实测第 3 页 → 单页 100 条找不到，必须翻页）
      var found = null;
      try {
        for (var pg = 0; pg < 10; pg++) {
          const r2 = await bit.listBrowsers({ page: pg, pageSize: 100 });
          const list2 = Array.isArray(r2.list) ? r2.list : (r2 && r2.data && Array.isArray(r2.data.list) ? r2.data.list : []);
          const total2 = Number((r2.totalNum !== undefined ? r2.totalNum : (r2.data && r2.data.totalNum))) || 0;
          found = list2.find(function(w) { return w && String(w.id || w.uuid || w.seq) === String(windowId); });
          if (found) break;
          if (list2.length < 100 || (total2 && (pg + 1) * 100 >= total2)) break;
        }
      } catch (_) { found = null; }
      if (!found || Number(found.status) !== 1) {
        const e = new Error('window-closed (auto-open disabled)');
        e.reason = 'window-closed'; e.autoOpenDisabled = true;
        throw e;
      }
    }
    return bit.openLiveCdp(windowId, { queue: true });
  }

  const windowId = deps.windowId || null;
  const apiBase = (deps.settings && deps.settings.apiBase) || 'http://127.0.0.1:54346';
  const bit = deps.bitbrowser || new (require('../bitbrowser').BitBrowserClient)(apiBase);
  const fetchTargets = deps.fetchTargets || require('../devtoolsTargets').fetchDevtoolsTargetList;

  // 找 happymail page target（url 含 happymail.co.jp）
  async function findHappyTarget(targets) {
    const list = Array.isArray(targets) ? targets : [];
    const pages = list.filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl);
    const hit = pages.find((t) => String(t.url || '').indexOf(HAPPY_MATCH) !== -1);
    if (hit) return hit;
    // 无精确 happymail url 时回退：非本地 host 的 page（仍只读，不导航到会外）
    return null;
  }

  // CDP eval（只读抽取；失败不抛，返 { ok:false }）
  // Bug 1 修复：走 evaluatePage（页面级 ws 直连，不依赖 attach 会话路由）；
  //   返回值 devtools.evaluate 返回 { value, targetInfo } 包装——res.value 取真值（两种兼容）。
  async function evalExpr(client, targetId, expr, params, pageWsUrl) {
    if (!expr) return { ok: false, reason: 'expr-missing' };
    let code = expr;
    if (params && params.memberID) code = code.replace(/__MEMBER_ID__/g, String(params.memberID));
    if (params && params.mailID) code = code.replace(/__MAIL_ID__/g, String(params.mailID));
    try {
      // 页面级 ws 直连（evaluatePage）；pageWsUrl 缺时 evaluatePage 内部回退会话路由 evaluate
      const res = await client.evaluatePage(code, targetId, pageWsUrl);
      // devtools evaluate 返回 { value, targetInfo } 或原始值——两种都兼容
      let data = res && res.value !== undefined ? res.value : res;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (_) { data = { raw: data }; }
      }
      return { ok: true, data: data || {} };
    } catch (err) {
      return { ok: false, reason: 'eval-failed', msg: String(err && err.message || err) };
    }
  }

  // CDP 导航（location.href .php 逐页，只读；快乐=.php 服务端渲染）
  // Bug 1 修复：走 evaluatePage（页面级 ws 直连）
  async function navigate(client, targetId, urlPath, pageWsUrl) {
    try {
      const code = "(function(){ location.href = " + JSON.stringify(urlPath) + "; return { ok:true, url:" + JSON.stringify(urlPath) + " }; })()";
      await client.evaluatePage(code, targetId, pageWsUrl);
      // 快乐客源页数据是 JS 动态填的（API+渲染需 ~6-10s）：CDP 侧同步轮询等待数据就绪（最多 20s）。
      // 判据：页面出现目标客源卡片特征 class（.type_list_outer/.profile_list_big_item/.ds_billboard_item/.ashi_list_item 等）。
      const probeExpr = "!!(document.body && document.body.querySelector('.type_list_outer, .profile_list_big_item, .ds_billboard_item, .ds_ashiato_item, .ashi_list_item, .ds_like_list_item'))";
      let dataReady = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        try {
          const pr = await client.evaluatePage(probeExpr, targetId, pageWsUrl);
          let pv = pr && pr.value !== undefined ? pr.value : pr;
          if (pv === true || pv === 'true') { dataReady = true; break; }
        } catch (pe) {
          // 导航中 evaluate 常报 "navigated or closed / context destroyed"——属正常，继续轮询
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      if (!dataReady) await new Promise((r) => setTimeout(r, 1500)); // 仍未就绪也补 1.5s，避免刚跳页就读
      return { ok: true, dataReady: dataReady };
    } catch (err) {
      return { ok: false, reason: 'navigate-failed', msg: String(err && err.message || err) };
    }
  }

  /**
   * 只读窗口状态探测：用 /browser/list（只读，不启动窗口）判断快乐窗口是否已打开。
   * 供 unreadPoller（autoOpenWindow=false）用：探测不可达 → 跳过该轮，不主动 /browser/open 开窗。
   * @returns {Promise<{ok:boolean, reason?:string, window?:object}>} ok=true 表示窗口 running。
   */
  var _probeCache = {}; // { windowId: { at, result } }
var _PROBE_TTL = 60 * 1000;
async function _probeCdpRaw() {
    if (closed) return { ok: false, reason: 'scanner-closed' };
    if (!windowId) return { ok: false, reason: 'no-happy-window-configured' };
    try {
      // /browser/list 是只读列表查询，绝不启动窗口
      // BitBrowserClient.call 已解包 .data：resp 本身即 {page,pageSize,totalNum,list}（resp.data.list 恒 undefined）
      // 18595 窗口实测在第 3 页 → 按需翻页扫描（最多 10 页）
      var found = null;
      for (var pg = 0; pg < 10; pg++) {
        const r2 = pg === 0 ? await bit.listBrowsers({ page: 0, pageSize: 100 }) : await bit.listBrowsers({ page: pg, pageSize: 100 });
        const list2 = Array.isArray(r2.list) ? r2.list : (r2 && r2.data && Array.isArray(r2.data.list) ? r2.data.list : []);
        const total2 = Number((r2.totalNum !== undefined ? r2.totalNum : (r2.data && r2.data.totalNum))) || 0;
        found = list2.find(function(w) { return w && String(w.id || w.uuid || w.seq) === String(windowId); });
        if (found) break;
        if (list2.length < 100 || (total2 && (pg + 1) * 100 >= total2)) break;
      }
      if (found) {
        return { ok: true, window: { id: windowId, opened: true, status: found.status } };
      }
      return { ok: false, reason: 'window-closed', window: { id: windowId, opened: false } };
    } catch (e) {
      return { ok: false, reason: 'probe-failed', msg: String((e && e.message) || e) };
    }
  }

  async function probeCdp() {
    var cached = _probeCache[windowId];
    if (cached && Date.now() - cached.at < _PROBE_TTL) return cached.result;
    var result = await _probeCdpRaw();
    _probeCache[windowId] = { at: Date.now(), result: result };
    return result;
  }

  /**
   * 抓收件箱（message_list.php）：eval happyInboxExpr → { contacts, unread }。
   * @returns {Promise<{ok:boolean, reason?:string, windowId, contacts?:Array, unread?, fetchedAt}>}
   */
  async   function scanInbox(more, opts) {
    opts = opts || {};
    if (closed) return { ok: false, reason: 'scanner-closed' };
    if (!windowId) return { ok: false, reason: 'no-happy-window-configured' };
    let live;
    try {
      live = await bit.openLiveCdpSafe();
    } catch (err) {
      return { ok: false, reason: 'window-not-open', msg: String(err && err.message || err), windowId };
    }
    const client = live.client;
    lastClient = client;
    const result = { ok: true, source: 'live-cdp-happy', windowId, contacts: [], unread: '', more: !!more, fetchedAt: new Date().toISOString() };
    try {
      const targets = await fetchTargets(live.http || live.ws);
      const happy = await findHappyTarget(targets);
      if (!happy) {
        // 窗口开着但无 happymail page target（可能在首页/非收件箱）→ 501 语义降级（不 500）
        result.ok = false;
        result.reason = 'no-happy-target';
        result.targets = (Array.isArray(targets) ? targets : []).map((t) => ({ type: t.type, url: t.url }));
        return result;
      }
      result.targetUrl = String(happy.url || '');
      const pWs = happy.webSocketDebuggerUrl || '';
      // H4 缺陷6 · 收件箱抓取前确保 happy 页在 message_list.php（若停在 message_detail 会话页/退会页会抓 0 客户）。
      //   只读导航 location.href=message_list.php，不发送/不批量/不换 IP/不动登录态。
      const curPath = (String(happy.url || '').match(/\/sp\/app\/html\/[a-z_]+\.php/) || [''])[0] || '';
      if (curPath.indexOf('message_list') === -1) {
        await navigate(client, happy.id, '/sp/app/html/message_list.php', pWs);
      }
      // H4 缺陷② · more=true 时先点收件箱自身「もっと見る」（以前のメッセージを見る）分页加载（合法只读 XHR，不导航/不批量删/不发送），等 DOM 更新再抓全部
      // H4 缺陷 6 · C 自动加载更多：expand=true 时循环点「もっと見る」直到（无按钮 / contacts 数不再增长 / 达 30 位上限）。
      //   只读：仅点收件箱自身分页按钮（happyLoadMoreExpr 文案校验「もっと見る」防误点），0 批量删/0 无视/0 全既读/0 发送/0 换 IP/0 动登录态。
      if (more) {
        const loadExpr = EXPR_LOAD_MORE;
        if (loadExpr) {
          const MAX_CONTACTS = 30;     // 全量上限（防无限加载；实测收件箱约 5-30 位）
          const MAX_CLICKS = 10;       // 点按钮次数上限（每点约 +5，30 位约需 6 次，留裕量）
          let lastCount = -1;
          let clicks = 0;
          // 先抓一批基线
          await new Promise((res) => setTimeout(res, 500));
          do {
            // 点一次「もっと見る」（happyLoadMoreExpr 内文案校验「もっと見る」防误点；无按钮则 clicked:false 停止）
            const lm = await evalExpr(client, happy.id, loadExpr, {}, pWs);
            const lmData = lm && lm.data ? lm.data : lm;
            const clicked = lmData && lmData.clicked === true;
            if (!clicked) break; // 无「もっと見る」按钮 = 已全量
            clicks += 1;
            // 等页面分页 XHR 渲染（.php 服务端 + JS 填充）
            await new Promise((res) => setTimeout(res, 2200));
            // 重抓当前 DOM 客户数（判断是否仍在增长）
            const probe = await evalExpr(client, happy.id, "(function(){ return document.querySelectorAll('.ds_message_list_mini').length; })()", {}, pWs);
            const curCount = probe && probe.data ? probe.data : (probe !== undefined ? probe : 0);
            if (curCount >= MAX_CONTACTS) { lastCount = curCount; break; } // 达上限
            if (curCount === lastCount) break; // 不再增长 = 已全量
            lastCount = curCount;
          } while (clicks < MAX_CLICKS);
          result.expanded = { clicks: clicks, maxContacts: MAX_CONTACTS };
        }
      }
      const r = await evalExpr(client, happy.id, EXPR_INBOX, {}, pWs); // Bug 1 页面级 ws
      if (r.ok) {
        result.contacts = Array.isArray(r.data.contacts) ? r.data.contacts : [];
        result.unread = r.data.unread || '';
        result.unreadAddition = r.data.unreadAddition || '';
      } else {
        result.ok = false;
        result.reason = r.reason || 'inbox-eval-failed';
      }
      return result;
    } catch (err) {
      result.ok = false;
      result.reason = 'scan-failed';
      result.msg = String(err && err.message || err);
      return result;
    } finally {
      try { client.close(); } catch (_) { /* ignore */ }
      lastClient = null;
    }
  }

  /**
   * 抓客户详情 + 会话历史（memberID）：navigate profile_detail.php?tid= → eval happyProfileDetailExpr；
   * 再 navigate message_detail?mailID= → eval happyHistoryExpr（若 mailID 传参）。
   * @param {string} memberID
   * @param {string} [mailID]
   * @returns {Promise<{ok, reason?, windowId, contact?, profile?, messages?, fetchedAt}>}
   */
  async function scanCustomer(memberID, mailID) {
    if (closed) return { ok: false, reason: 'scanner-closed' };
    if (!windowId) return { ok: false, reason: 'no-happy-window-configured' };
    if (!memberID) return { ok: false, reason: 'missing-memberID' };
    let live;
    try { live = await bit.openLiveCdpSafe(); }
    catch (err) { return { ok: false, reason: 'window-not-open', msg: String(err && err.message || err), windowId }; }
    const client = live.client;
    lastClient = client;
    const result = { ok: true, source: 'live-cdp-happy', windowId, memberID, contact: null, profile: null, recruitPosts: [], messages: [], fetchedAt: new Date().toISOString() };
    try {
      const targets = await fetchTargets(live.http || live.ws);
      const happy = await findHappyTarget(targets);
      if (!happy) { result.ok = false; result.reason = 'no-happy-target'; return result; }
      // 1) 客户详情：navigate profile_detail.php?tid={memberID}（Bug 1 页面级 ws）
      const pWs = happy.webSocketDebuggerUrl || '';
      // memberID 是数字（profile_detail tid），编码安全；保留 encodeURIComponent
      const nav1 = await navigate(client, happy.id, '/sp/app/html/profile_detail.php?tid=' + encodeURIComponent(memberID), pWs);
      if (nav1.ok) {
        const p = await evalExpr(client, happy.id, EXPR_PROFILE_DETAIL, { memberID }, pWs);
        if (p.ok) {
          result.contact = { tid: p.data.tid, name: (p.data.fields && p.data.fields.name) || '' };
          result.profile = p.data;
        }
      }
      // 1.5) 客户招募帖（v5.2 新增情报维度）：navigate profile_billboard.php?tid={memberID} → eval 帖子列表
      const nav1b = await navigate(client, happy.id, '/sp/app/html/profile_billboard.php?tid=' + encodeURIComponent(memberID), pWs);
      if (nav1b.ok) {
        const bl = await evalExpr(client, happy.id, EXPR_BILLBOARD_LIST, { memberID }, pWs);
        if (bl.ok) {
          result.recruitPosts = Array.isArray(bl.data.items) ? bl.data.items : [];
        }
      }
      // 回到客户详情页（后续会话历史导航不依赖，保持状态干净）
      await navigate(client, happy.id, '/sp/app/html/profile_detail.php?tid=' + encodeURIComponent(memberID), pWs);
      // 2) 会话历史：navigate message_detail.php?mailID={mailID}（若传 mailID）
      if (mailID) {
        // mailID 是 base64（含 +/=），encodeURIComponent 会二次编码成 %2B/%3D 致会话页空白；
        // 直接原样拼进 location.href（浏览器保留 +/= 原始形态，平台按原始 mailID 解析）
    const nav2 = await navigate(client, happy.id, '/sp/app/html/message_detail.php?a=a&mailID=' + mailID, pWs);
        if (nav2.ok) {
          const h = await evalExpr(client, happy.id, EXPR_HISTORY, { mailID }, pWs);
          if (h.ok) result.messages = Array.isArray(h.data.messages) ? h.data.messages : [];
        }
      }
      return result;
    } catch (err) {
      result.ok = false; result.reason = 'scan-failed'; result.msg = String(err && err.message || err);
      return result;
    } finally {
      try { client.close(); } catch (_) { /* ignore */ }
      lastClient = null;
    }
  }

  /**
   * 抓客源 3 路（type_list/profile_list/keijiban）：navigate + eval 对应 sourceExprs。
   * @param {'type'|'profile'|'billboard'} kind
   */
  async function scanSource(kind) {
    if (closed) return { ok: false, reason: 'scanner-closed' };
    if (!windowId) return { ok: false, reason: 'no-happy-window-configured' };
    const routes = { type: '/sp/app/html/type_list.php', profile: '/sp/app/html/profile_list.php', billboard: '/sp/app/html/keijiban.php', ashiato: '/sp/app/html/ashiato.php' };
    const exprs = { type: EXPR_TYPE, profile: EXPR_PROFILE_SEARCH, billboard: EXPR_BILLBOARD, ashiato: EXPR_ASHIATO };
    const url = routes[kind]; const expr = exprs[kind];
    if (!url || !expr) return { ok: false, reason: 'unknown-source-kind', kind: String(kind || '') };
    let live;
    try { live = await openLiveCdpSafe(); }
    catch (err) { return { ok: false, reason: err && err.reason || 'window-not-open', msg: String(err && err.message || err) }; }
    const client = live.client;
    lastClient = client;
    const result = { ok: true, source: kind, windowId, fetchedAt: new Date().toISOString() };
    try {
      const targets = await fetchTargets(live.http || live.ws);
      const happy = await findHappyTarget(targets);
      if (!happy) { result.ok = false; result.reason = 'no-happy-target'; return result; }
      const sWs = happy.webSocketDebuggerUrl || '';
      const nav = await navigate(client, happy.id, url, sWs);
      if (nav.ok) {
        const r = await evalExpr(client, happy.id, expr, {}, sWs);
        if (r.ok) Object.assign(result, { data: r.data, ok: true });
        else { result.ok = false; result.reason = r.reason; }
      } else { result.ok = false; result.reason = 'navigate-failed'; }
      return result;
    } catch (err) {
      result.ok = false; result.reason = 'scan-failed'; result.msg = String(err && err.message || err);
      return result;
    } finally {
      try { client.close(); } catch (_) { /* ignore */ }
      lastClient = null;
    }
  }

  function close() {
    closed = true;
    if (lastClient) { try { lastClient.close(); } catch (_) { /* ignore */ } lastClient = null; }
  }

  return { scanInbox, scanCustomer, scanSource, probeCdp, close, get windowId() { return windowId; } };
}

module.exports = { createHappyScanner, EXPR_INBOX, EXPR_HISTORY, EXPR_PROFILE_DETAIL, EXPR_PROFILE_SEARCH, EXPR_TYPE, EXPR_BILLBOARD, EXPR_ASHIATO, HAPPY_MATCH };
