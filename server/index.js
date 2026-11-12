// =============================================================================
// Ai SAY · 生产入口（M5 增强版）
// 职责：
//   1. 创建 M0 SQLite store（data/aisay.db，自动建表）
//   2. 创建 M1 leadScoring + M3 talkEngine（话术引擎；sendHook 由调用方注入，lineId 待 M4 替换）
//   3. 创建 M2 dedup（跨平台客户归并算法）
//   4. 注册 M2 平台适配器（出会 17098，运行时按窗口注入 cdp）
//   5. 一次性挂载 consoleRoutes（/api/console/*），增量叠加在现有 createApp() 之上
//   6. 静态文件服务：/ → public/index.html（旧多列布局保留），/console → console.html，
//      /console.css /console.js 同名静态资源
//
// 约束：不改 app.js 旧 /api/* 路由；不破坏 npm start / npm test / ws 依赖。
// =============================================================================
'use strict';
// =============================================================================
// 进程级兜底（task-6 crash-guard + task-10 A 项升级，对齐 devops GUARDIAN.md §4.3）：
//  钩子本体下沉到 if (isMain) 块内注册（devops 方案 A / code-reviewer B 项），
//  避免测试 require index.js 时顶层钩子意外挂进程。此处只放纯函数 + 判定函数，
//  钩子在 isMain 内直接引用 store（同块作用域，免顶层块级访问问题）。
//
//  - uncaughtException：写 data/crash.log（时间戳+pid+stack，§0.5）→ close SQLite → exit(1)。
//    【恒 fatal，无白名单概念；不 spawn/respawn】：拉起 100% 归 pm2（预审挂账 #2 防 double-restart）。
//  - unhandledRejection（task-10 A，GUARDIAN §4.3 双方向语义）：
//    配置入口 = env AI_SAY_REJECTION_GUARD（JSON 字符串：
//      { denyByDefault:bool, list:[{match:正则串, kind:str}] }）。
//    缺省 / 解析失败 = { denyByDefault:false, list:[] } ⇒ 全 log-only（= 起步保守态，
//    0 行为变化，不破 119 基线）。
//    双方向判定（_shouldFatalRejection）：
//      · denyByDefault=true  ⇒ 默认全 fatal，list=白名单（命中良性特征 ⇒ log-only 放行）；
//      · denyByDefault=false ⇒ 默认全 log-only，list=黑名单（命中危险特征 ⇒ 升级 fatal）。
//    仅 unhandledRejection 走判定；uncaughtException 恒 fatal。
// =============================================================================
const path0 = require('path');
const fs0 = require('fs');
function _crashLog(err, tag) {
  try {
    fs0.mkdirSync(path0.join(__dirname, '..', 'data'), { recursive: true });
    fs0.appendFileSync(path0.join(__dirname, '..', 'data', 'crash.log'),
      '[' + new Date().toISOString() + '] pid=' + process.pid + ' ' + String(tag || '') + ' ' + ((err && err.stack) || err) + '\n');
  } catch (e) { console.error('[crash-guard] 写 crash.log 失败:', e && e.message); }
}
// GUARDIAN §4.3：读 env AI_SAY_REJECTION_GUARD（JSON）；缺省/解析失败 = 起步保守态
//（denyByDefault=false, list=[] ⇒ 全 log-only，0 行为变化，安全起步）。
function _loadRejectionGuard() {
  const defaultGuard = { denyByDefault: false, list: [] };
  const raw = process.env.AI_SAY_REJECTION_GUARD;
  if (!raw) return defaultGuard;
  try {
    const parsed = JSON.parse(raw);
    const out = { denyByDefault: !!parsed.denyByDefault, list: [] };
    if (Array.isArray(parsed.list)) {
      parsed.list.forEach(function(item) {
        if (item && typeof item.match === 'string' && item.match) {
          out.list.push({ match: item.match, kind: String(item.kind || 'unknown') });
        }
      });
    }
    return out;
  } catch (e) {
    console.warn('[crash-guard] AI_SAY_REJECTION_GUARD 解析失败，回退起步保守态（全 log-only）:', e && e.message);
    return defaultGuard;
  }
}
// reason 是否命中 guard list（match 为正则串，kind 仅标注来源不参判定）
function _matchesGuardList(reason, list) {
  if (!list || !list.length) return false;
  const msg = String((reason && reason.message) || reason || '');
  return list.some(function(rule) {
    try { return new RegExp(rule.match).test(msg); } catch (e) { return false; }
  });
}
// 判定 unhandledRejection 是否应 fatal（exit 1）。denyByDefault 双方向（GUARDIAN §4.3）：
//   true  ⇒ 默认全 fatal，命中 list（白名单）⇒ 放行 log-only
//   false ⇒ 默认全 log-only，命中 list（黑名单）⇒ 升级 fatal（起步态 0 行为变化）
function _shouldFatalRejection(reason) {
  const guard = _loadRejectionGuard();
  const matched = _matchesGuardList(reason, guard.list);
  if (guard.denyByDefault) return !matched; // 默认 fatal；命中白名单 ⇒ 放行 log-only
  return matched;                            // 默认 log-only；命中黑名单 ⇒ 升级 fatal
}
// 兼容别名（旧单测可能引用 _isWhitelistedRejection；语义=是否 fatal，非字面白名单）
function _isWhitelistedRejection(reason) { return _shouldFatalRejection(reason); }


const http = require('http');
const path = require('path');
const fs   = require('fs');

const { createApp, loadConfig } = require('./app');

// --- M0: SQLite store（自动建表，幂等） ---
const { createStore } = require('./db/store');
const dbPath = path.join(__dirname, '..', 'data', 'aisay.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const store = createStore({ dbPath });

// 模块3 · BBS 1h 冷却规则落库（幂等：已存在不重复插；活库无 GovernanceRule 表时由 migrate 先建表）
try {
  const cdRes = store.ensureBbsCooldownRule({ ruleId: 'bbs-post-cooldown', cooldownMinutes: 60, platform: 'ichigo', accountId: process.env.AISAY_ACCOUNT_ID });
  if (cdRes.created) console.log('[bbs-cooldown] 冷却规则已落库:', cdRes.ruleId, '(' + cdRes.status + ')');
  else console.log('[bbs-cooldown] 冷却规则已存在:', cdRes.ruleId, '(status=' + cdRes.status + ')');
} catch (e) {
  console.warn('[bbs-cooldown] 落库失败（表未建？跑 migrate）:', e.message);
}

// v5.3 · 默认跟进 SOP 种子（"3 天加ライン"软推进规则；幂等：同 scope+stage+actionKind 不重复插）
try {
  const DEFAULT_SOPS = [
    { scope: 'global', stage: 1, afterDays: 3, actionKind: 'nudge', templateKey: 'line', note: '3 天没回 → 软推进ライン（LINE 一律写 ライン，不直说品牌）', active: 1 },
    { scope: 'global', stage: 1, afterDays: 2, actionKind: 'care', templateKey: 'care', note: '2 天没回 → 先关心（男性付费语境，不硬逼）', active: 1 },
    { scope: 'global', stage: 2, afterDays: 3, actionKind: 'understand', templateKey: 'line', note: '推过ライン 3 天没回应 → 理解退路（给台阶不掉价）', active: 1 },
    { scope: 'global', stage: 1, afterDays: 1, actionKind: 'meet', templateKey: 'meet', note: 'stage=1 推进线下（可选，热客户才触发）', active: 0 },
  ];
  let created = 0;
  for (const s of DEFAULT_SOPS) {
    // 幂等：同 scope+stage+actionKind 已存在则跳过
    const exists = store.db.prepare('SELECT 1 FROM FollowupSop WHERE scope = ? AND stage = ? AND actionKind = ? AND (accountId IS NULL OR accountId = ?) LIMIT 1')
      .get(s.scope, s.stage, s.actionKind, s.accountId || null);
    if (!exists) { store.upsertFollowupSop(s); created++; }
  }
  console.log('[followup-sop] 默认 SOP 种子：新增 ' + created + ' 条 / 共 ' + store.listFollowupSops().length + ' 条');
} catch (e) {
  console.warn('[followup-sop] 种子落库失败（表未建？跑 migrate）:', e.message);
}

// --- M1: 意向评分 ---
const { createLeadScoring } = require('./db/leadScoring');
const leadScoring = createLeadScoring({ store });

// --- M3: 话术引擎 ---
const { createTalkEngine } = require('./acquisition/talkEngine');
const talkEngine = createTalkEngine({
  store,
  leadScoring,
  aiService: require('./aiService'),
  templatesDir: path.join(__dirname, 'acquisition', 'templates'),
  sendHook: null,   // 平台侧发送走 adapter.send 契约；M5 阶段留 null，运行时注入
  lineId: 'pending', // M4 替换为实际 LINE OA lineId
  ledger: {          // task-3 · 频控账本句柄（生产路径必传，跨重启限额有效；NoopLedger 负例哨兵测试应红在此）
    push: (row, table) => (typeof store.pushLedger === 'function' ? store.pushLedger(row, table) : false),
    since: (t, dim) => (typeof store.sinceLedger === 'function' ? store.sinceLedger(t, dim) : []),
    lastFor: (cid) => (typeof store.lastForLedger === 'function' ? store.lastForLedger(cid) : null),
    flush: () => { try { if (typeof store.syncFlushLedger === 'function') store.syncFlushLedger(); } catch (e) { console.error('[index.js] ledger.flush 失败:', e && e.message); } return true; },
    syncFlush: () => { try { if (typeof store.syncFlushLedger === 'function') store.syncFlushLedger(); } catch (e) { console.error('[index.js] ledger.syncFlush 失败:', e && e.message); } },
    snapshot: () => (typeof store.snapshotLedger === 'function' ? store.snapshotLedger() : []),
    pushPendingLedger: (row) => (typeof store.pushPendingLedger === 'function' ? store.pushPendingLedger(row) : null),
    confirmPendingLedger: (pid, at) => (typeof store.confirmPendingLedger === 'function' ? store.confirmPendingLedger(pid, at) : false),
  },
});
// task-3 · 启动载入 24h/7 天热账本快照（跨重启限额有效；失败回 false → talkEngine 仍可用但 24h 限额本进程内有效）
try { if (typeof store.loadRateLedger === 'function') store.loadRateLedger(); } catch (e) { console.error('[index.js] store.loadRateLedger 启动载入失败（24h 限额降级本进程内有效）:', e && e.message); }

// --- M1 补强：推荐回复生成器（人设+画像+规则 驱动的 LLM 个性化；降级 talkEngine 模板）---
const { createRecommender } = require('./db/recommender');
const aiService = require('./aiService');
const recommender = createRecommender({ store, aiService, leadScoring, talkEngine });

// --- M2: 客户归并 ---
const { createDedup } = require('./db/dedup');
const dedup = createDedup({ store });

// --- M2: 平台适配器（出会 17098）---
// PlatformAdapter 构造需要 DevToolsClient（opts.cdp 缺省会 throw），
// 所以这里只注册工厂；窗口接入时（/api/monitor 或 sessionPool）再 create(cdp, targetId)。
const { IchigoAdapter } = require('./adapter/ichigo194964');
// task-H1 · 快乐平台 kairaku Adapter（happymail.co.jp，测绘图 v4 坐实；只注册不激活，默认仍 ikuru）
const { HappyAdapter } = require('./adapter/happy');
const adapters = {
  ichigo194964: {
    name: 'ichigo194964',
    create: (cdp, targetId, opts = {}) =>
      new IchigoAdapter(Object.assign({ cdp, targetId, platform: 'ichigo194964' }, opts)),
  },
  kairaku: {
    name: 'kairaku',
    create: (cdp, targetId, opts = {}) =>
      new HappyAdapter(Object.assign({ cdp, targetId, platform: 'kairaku' }, opts)),
  },
};

// --- M5 核心改造①（task-36）：实时抓出会窗口（BitBrowser CDP） ---
// settings.json 已有 windowId + apiBase（BitBrowser 54346）；createLiveScanner 读 settings 后构建。
// 控制台 /api/console/live 端点实时连活 17098 窗口抓出会页面，取代静态 DB 快照卡片。
const { createLiveScanner } = require('./adapter/liveScanner');
const { createProxyPool } = require('./adapter/proxyPool');
const { createAssistant } = require('./adapter/assistant');
const settingsForLive = loadConfig(); // settings.json（line 108 mountConsoleRoutes 也要用）
let liveScanner = null;
try {
  liveScanner = createLiveScanner({
    settings: {
      apiBase: settingsForLive.apiBase,
      windowId: (settingsForLive.platformGroups && settingsForLive.platformGroups[0] && settingsForLive.platformGroups[0].windows && settingsForLive.platformGroups[0].windows[0]) || settingsForLive.windowId,
    },
    adapterPlatform: 'ichigo194964',
    // 2026-11-02 用户决策：窗口手动控制模式 — 点 17098/收件箱轮询 不再自动 /browser/open 启动窗口；
    // 窗口只能由「控制台右侧 开/关 按钮（POST /api/console/window/open）」或 后续任务编排 启动。
    autoOpenWindow: settingsForLive.autoOpenWindow === true, // 默认 false（手动控制）；settings.json 可显式开 true 恢复旧行为
  });
} catch (e) {
  // liveScanner 构建失败不阻断服务启动；/api/console/live 返回 501
  console.warn('[liveScanner] 构建失败，控制台 /api/console/live 将返回 501:', e && e.message);
  liveScanner = null;
}

// --- H4 · 快乐平台（happymail.co.jp / 18595 窗口）只读实时抓取（复用出会 BitBrowser CDP 机制） ---
// 独立 liveScanner：出会组=17098（ichigo194964），快乐组=18595（kairaku）；两条链路不混用。
const { createHappyScanner } = require('./adapter/happyScanner');
// H4 缺陷 6 · A 持久化：快乐缓存层（data/happy-cache.json，独立键不混出会 console-cache）
const { createHappyCache } = require('./adapter/happyCache');
let happyScanner = null;
let happyCache = null;
try { happyCache = createHappyCache({}); } catch (e) { console.warn('[happyCache] 构建失败，/api/console/happy/* 走纯 CDP 无缓存:', e && e.message); happyCache = null; }
try {
  const kairakuGroup = (settingsForLive.platformGroups || []).find((g) => g.id === 'kairaku-happymail');
  happyScanner = createHappyScanner({
    settings: { apiBase: settingsForLive.apiBase },
    windowId: (kairakuGroup && kairakuGroup.windows && kairakuGroup.windows[0]) || '1ccd4351a6fe4482bc8378a78c53398e',
    // 2026-11-02 手动窗口控制：点 18595 / 快乐抓取 不再自动 /browser/open 启动窗口
    autoOpenWindow: settingsForLive.autoOpenWindow === true,
  });
} catch (e) {
  // happyScanner 构建失败不阻断服务启动；/api/console/happy/* 返回 501 降级
  console.warn('[happyScanner] 构建失败，控制台 /api/console/happy/* 将返回 501:', e && e.message);
  happyScanner = null;
}


// --- 挂载 console 路由（一次性） ---
// --- v5.3 · 批2：未读轮询器（非秒回，30s 一轮，发现新未读 → 待跟进，不自动发消息 §0.1） ---
const { createUnreadPoller } = require('./adapter/unreadPoller');
// --- T3 任务编排：呼吸引擎（breathEngine，AGENTS.md §二/§六待办 T3）---
// 默认不自动 start（引擎只调度节拍，副作用由 SOP 执行器驱动；启动入口走 /tasks/breath 路由，避免无人确认时跑）。
const { createBreathEngine } = require('./acquisition/breathEngine');
const { createSopExecutor } = require('./acquisition/sopExecutor');
// breathEngine 实例（注入 store；默认不 start，由 /tasks/breath/start 路由控制启停）
let deepScrape = null;
try {
  const { createIchigoDeepScrape } = require('./adapter/ichigoDeepScrape');
  if (liveScanner && typeof liveScanner.openCdpSession === 'function') {
    deepScrape = createIchigoDeepScrape({
      openCdpSession: () => liveScanner.openCdpSession(),
      rootDir: require('path').join(__dirname, '..'),
    });
  }
} catch (e) {
  // deepScrape 构建失败不阻断服务启动；/api/console/live/deep 返回 501
  console.warn('[deepScrape] 构建失败，控制台 /api/console/live/deep 降级 501:', e && e.message);
  deepScrape = null;
}

// 切出会窗口到收件箱的轻量 helper（供 consoleRoutes 发送后调用；deepScrape 缺省时返回 501）
function navigateToInbox() {
  if (!deepScrape || typeof deepScrape.navigateInbox !== 'function') {
    return Promise.resolve({ ok: false, reason: 'deepScrape-not-ready' });
  }
  return deepScrape.navigateInbox();
}

// 控制台偏好（账号覆盖 + 常用语）
// --- IPDeep 代理池 v1（池数据 data/proxy-pool.json + 密码 data/proxy-secrets.json；两者在 .gitignore）---
let proxyPool = null;
try {
  proxyPool = createProxyPool({ rootDir: require('path').join(__dirname, '..') });
  console.log('[proxyPool] 就绪: 池数据 ' + require('path').join(__dirname, '..', 'data', 'proxy-pool.json') + '（首次 ensurePool 时从当前窗口代理生成）');
} catch (e) {
  console.warn('[proxyPool] 构建失败:', e && e.message);
  proxyPool = null;
}
let breathEngine = null;
try {
  // onTask SOP 执行器：引擎到点唤醒 → 开窗 + 场景动作（只读自动跑，强副作用只出待确认）
  const sopExecutor = createSopExecutor(store, {
    deepScrape: (typeof deepScrape !== 'undefined' ? deepScrape : null),
    happyScanner: (typeof happyScanner !== 'undefined' ? happyScanner : null),
    // 开窗 / 回收件箱 deps（出会 liveScanner 开窗 / deepScrape.navigateInbox；快乐 happyScanner）
    openCdp: async function (accountId) {
      // 出会窗口：liveScanner 探测（未开降级，不自动 /browser/open——窗口手动控制模式）
      if (typeof liveScanner !== 'undefined' && liveScanner && liveScanner.probeCdp) {
        const p = await liveScanner.probeCdp(accountId).catch(function (e) { return { ok: false, reason: e && e.reason || e.message }; });
        return p || { ok: false, reason: 'probe-unavailable' };
      }
      return { ok: false, reason: 'no-opener' };
    },
    happyOpenCdp: async function (accountId) {
      if (typeof happyScanner !== 'undefined' && happyScanner && happyScanner.openLiveCdpSafe) {
        return happyScanner.openLiveCdpSafe(accountId).catch(function (e) { return { ok: false, reason: e && e.reason || e.message }; });
      }
      return { ok: false, reason: 'no-happy-opener' };
    },
    navigateInbox: async function (accountId) {
      if (typeof deepScrape !== 'undefined' && deepScrape && deepScrape.navigateInbox) {
        return deepScrape.navigateInbox(accountId).catch(function () { return { ok: true }; });
      }
      return { ok: true };
    },
    log: function (m) { console.log(m); },
    logWarn: function (m) { console.warn(m); }
  });
  breathEngine = createBreathEngine(store, {
    tickMs: 500, MAX_DISPATCH_PER_TICK: 4,
    // 把 SOP 执行器作为引擎的业务副作用钩子（引擎本身仍只调度节拍）
    onTask: sopExecutor.onTask
  });
  // 供路由组查询待确认动作 / 人工确认
  global.__sopExecutor = sopExecutor;
  // D4：每日 00:05 JST 晋升守护（warmup→veteran；setInterval 模拟，跨日自动滚）
  (function scheduleD4() {
    const target = new Date();
    target.setHours(0, 5, 0, 0); // 当天 00:05（本地时区，生产可改 JST）
    if (target.getTime() < Date.now()) target.setDate(target.getDate() + 1);
    const t = setTimeout(function() {
      try { breathEngine.promoteDueAccounts(); console.log('[breathEngine] D4 每日 00:05 晋升守护跑完'); }
      catch (e) { console.error('[breathEngine] D4 晋升异常:', e && e.message); }
      scheduleD4();
    }, target.getTime() - Date.now());
    t.unref && t.unref();
  })();
} catch (e) {
  console.error('[breathEngine] 实例化失败:', e && e.message);
  breathEngine = null;
}
const unreadPoller = createUnreadPoller({
  intervalMs: Number(process.env.POLL_INTERVAL_MS) || 30000,
  platforms: [
    { label: 'ichigo', getScanner: () => liveScanner },
    { label: 'kairaku', getScanner: () => happyScanner },
  ],
});
// v5.3 · 批2+批3 组合：发现新未读 → 自动"备料"（查资料/历史/招募帖，不发消息；非秒回）
async function autoPrepareCustomer(evt) {
  const isHappy = evt.platform === 'kairaku';
  const scanner = isHappy ? happyScanner : liveScanner;
  if (!scanner || typeof scanner.scanCustomer !== 'function') return;
  try {
    const r = await scanner.scanCustomer(evt.memberKey, '');
    if (r && r.ok && isHappy && happyCache) {
      happyCache.upsertCustomer(evt.memberKey, r.profile, r.messages, r.mailID, r.recruitPosts);
      console.log('[auto-prepare] ' + (evt.memberName || evt.memberKey) + ' 资料/历史/招募帖已备料（缓存 5min，非秒回，不发消息）');
    }
  } catch (e) { /* CDP 不可达降级，下一轮再试 */ }
}
unreadPoller.onUnread((evt) => {
  console.log('[unread-poller] 新未读 ' + evt.platform + ' ' + (evt.memberName || evt.memberKey) + '（+' + (evt.delta || 1) + '）→ 自动备料（查资料/历史/招募帖；不自动发消息 §0.1）');
  autoPrepareCustomer(evt).catch((e) => console.warn('[unread-poller] 自动备料失败（不阻断）:', e && e.message));
});
try { unreadPoller.start(); console.log('[unread-poller] 启动（间隔 ' + unreadPoller.snapshot().intervalMs + 'ms）'); }
catch (e) { console.warn('[unread-poller] 启动失败（不阻断）:', e && e.message); }

const { mountConsoleRoutes } = require('./consoleRoutes');
const consoleRoutes = []; // { method, pathname, handler }
const consoleApp = {
  get: (p, h) => { consoleRoutes.push({ method: 'GET', pathname: p, handler: h }); },
  post: (p, h) => { consoleRoutes.push({ method: 'POST', pathname: p, handler: h }); },
  delete: (p, h) => { consoleRoutes.push({ method: 'DELETE', pathname: p, handler: h }); },
};
// M5 核心改造②：17098 深度抓取器（收件箱 2 页 18 客户 + 资料页 12 字段 + 兴趣 icon 反查）




let consolePrefs = null;
let accountInfo = null;
try {
  const { createConsolePrefs } = require('./adapter/consolePrefs');
  const { createAccountInfo } = require('./adapter/accountInfo');
  consolePrefs = createConsolePrefs({});
  accountInfo = createAccountInfo({});
  console.log('[consolePrefs] 就绪: 常用语 ' + consolePrefs.listPhrases().length + ' 条');

} catch (e) {
  console.warn('[consolePrefs] 构建失败:', e && e.message);
  consolePrefs = null; accountInfo = null;
}

// 翻译缓存（内容寻址，持久化）
let translationCache = null;
try {
  const { createTranslationCache } = require('./adapter/translationCache');
  translationCache = createTranslationCache({});
  console.log('[translationCache] 就绪:', JSON.stringify(translationCache.stats()));
  // 预热：预置常用语的译文直接写进缓存，首次打开页面也秒出（不调模型）
  try {
    const { presetTranslations } = require('./adapter/consolePrefs');
    if (presetTranslations) {
      let n = 0;
      presetTranslations().forEach(function(t) {
        if (!translationCache.get(t.text, t.from, t.to, true)) {
          translationCache.set(t.text, t.from, t.to, { translated: t.translated, source: 'model', model: 'preset' });
          n++;
        }
      });
      if (n) { translationCache.saveNow(); console.log('[translationCache] 预热预置译文 ' + n + ' 条'); }
      else console.log('[translationCache] 预置译文已存在，跳过预热');
    }
  } catch (e) { console.warn('[translationCache] 预热失败:', e && e.message); }
} catch (e) {
  console.warn('[translationCache] 构建失败:', e && e.message);
  translationCache = null;
}

// 模型配置存储（多模型 + 当前选中）
let modelStore = null;
try {
  const { createModelStore } = require('./adapter/modelStore');
  modelStore = createModelStore({ settingsPath: require('path').join(__dirname, '..', 'settings.json') });
  const _ml = modelStore.list();


  console.log('[modelStore] 就绪: ' + _ml.models.length + ' 个模型, 当前=' + (_ml.activeId || '无'));
} catch (e) {
  console.warn('[modelStore] 构建失败:', e && e.message);
  modelStore = null;
}

// M5 核心改造③：控制台数据缓存（收件箱快照 / 会话历史 / 资料卡 三层）
let ichigoCache = null;
try {
  const { createIchigoCache } = require('./adapter/ichigoCache');
  ichigoCache = createIchigoCache({});
  console.log('[ichigoCache] 就绪:', JSON.stringify(ichigoCache.stats()));
} catch (e) {
  console.warn('[ichigoCache] 构建失败，缓存层降级:', e && e.message);
  ichigoCache = null;
}

// task-36：Ai SAY 助手面板 B v1（单轮 + 工具调用，强副作用只出卡片）
let assistant = null;
try {
  assistant = createAssistant({ modelStore: modelStore, aiService: aiService, ichigoCache: ichigoCache });
  console.log('[assistant] 就绪：Ai SAY 助手面板 B v1（/api/console/assistant）');
} catch (e) {
  console.warn('[assistant] 构建失败:', e && e.message);
  assistant = null;
}

  // settingsForLive：进程内 settings（模型切换时同步）— 已在文件头部声明

  // Mount console read-only routes on the main app (task-19 起挂 /api/console/*)
  mountConsoleRoutes(consoleApp, { breathEngine, store, talkEngine, dedup, adapters, recommender, liveScanner, happyScanner, happyCache, deepScrape, ichigoCache, modelStore, translationCache, consolePrefs, accountInfo, proxyPool, assistant, unreadPoller, settings: settingsForLive, settingsForLive: settingsForLive });


  function matchConsoleRoute(req, res) {
    const pathname = String(req.url || '').split('?')[0];
    if (pathname.indexOf('/api/console') !== 0) return false;

    for (const route of consoleRoutes) {
      if (route.method !== req.method) continue;

      // 精确匹配
      if (route.pathname === pathname) {
        req.params = {};
        req.__body = undefined;
        return route.handler(req, res);
      }
      // 参数段匹配（通用 :param）：注册路径里的 :xxx 转成正则段，捕获任意子路径（:id/delete、:id/done、:id/finish…）
      if (route.pathname.indexOf('/:') !== -1) {
        const segs = route.pathname.split('/');
        const paramNames = [];
        const rx = segs.map(function (s) {
          if (s.charAt(0) === ':') { paramNames.push(s.slice(1)); return '([^/]+)'; }
          return s.replace(/[/+^$.*?{}|()[\\]]/g, function (ch) { return '\\' + ch; });
        });
        const mm = pathname.match(new RegExp('^' + rx.join('/') + '$'));
        if (mm) {
          req.params = {};
          for (let pi = 0; pi < paramNames.length; pi++) req.params[paramNames[pi]] = mm[pi + 1];
          req.__body = undefined;
          return route.handler(req, res);
        }
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, msg: 'Not Found: ' + pathname }));
    return true;
  }

  // --- 组装最终 app handler（静态文件 + 控制台路由 + 原有 app） ---
  const baseApp = createApp({ apiBase: loadConfig().apiBase || process.env.BIT_BROWSER_API_URL || 'http://127.0.0.1:54345' });

  function serveStatic(res, file, type) {
    try {
      const content = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
      // 维护修 · 静态响应缓存头（用户排障根因：无 Cache-Control → 浏览器启发式 disk cache 极顽固，前端改动后页面跑旧缓存）
      // no-cache = 每次跟服务端 revalidate（带 If-Modified-Since/ETag 协商），绝不用旧 disk cache；不用 no-store（每次全量拉 HTML 太重，no-cache 够用且省带宽）
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(content);
      return true;
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ success: false, msg: 'static not found: ' + file }));
      return true;
    }
  }

  const app = (req, res, notFound) => {
    const pathname = String(req.url || '').split('?')[0];

    // /api/console/*（含 :id 参数段；GET + POST）优先走控制台路由
    if (pathname.indexOf('/api/console') === 0) {
      return matchConsoleRoute(req, res);
    }

    // 静态文件（仅 GET）
    if (req.method === 'GET') {
      // 第一刀起 · 前端 ES6 模块静态资源（/ichigo-assets/*.js，ESM 需正确 MIME）
      if (pathname.indexOf('/ichigo-assets/') === 0) {
        return serveStatic(res, 'ichigo-assets' + pathname.slice('/ichigo-assets'.length), 'text/javascript; charset=utf-8');
      }
      switch (pathname) {
        case '/ichigo-cardflow':
        case '/ichigo-cardflow.html':
          return serveStatic(res, 'ichigo-cardflow.html', 'text/html; charset=utf-8');
case '/ichigo-console':
        case '/ichigo-console.html':
          return serveStatic(res, 'ichigo-console.html', 'text/html; charset=utf-8');
        case '/console':
        case '/console.html':
          return serveStatic(res, 'console.html', 'text/html; charset=utf-8');
        case '/console.css':
          return serveStatic(res, 'console.css', 'text/css; charset=utf-8');
        case '/console.js':
          return serveStatic(res, 'console.js', 'text/javascript; charset=utf-8');
        case '/card-deck':
        case '/card-deck.html':
          return serveStatic(res, 'card-deck.html', 'text/html; charset=utf-8');
        case '/card-deck.js':
          return serveStatic(res, 'card-deck.js', 'text/javascript; charset=utf-8');
        default:
          break;
      }
    }

    // 其余（含 / 与旧 /api/*）走原有 app handler
    baseApp(req, res, notFound);
  };

  // --- 启动（仅生产直接 node 运行时；测试通过 module.exports 拿 app 自建临时 server） ---
  const isMain = require.main === module;
  if (isMain) {
    const host = process.env.HOST || '127.0.0.1';
    const port = Number(process.env.PORT || 8300);
    const server = http.createServer((req, res) => {
      app(req, res, () => {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, msg: 'Not Found' }));
      });
    });
    server.listen(port, host, () => {
      console.log('Ai SAY 控制台:   http://' + host + ':' + port + '/');
      console.log('卡片式控制台:   http://' + host + ':' + port + '/console');
      console.log('比特浏览器 API: ' + (loadConfig().apiBase || process.env.BIT_BROWSER_API_URL || 'http://127.0.0.1:54345'));
      console.log('SQLite DB:      ' + dbPath);
    });
    // task-10 B：crash-guard 钩子下沉到 isMain（测试 require 不挂）
    process.on('uncaughtException', function(err) {
      console.error('[uncaughtException] crash-guard：记录后 close+exit(1)，拉起归 pm2：', (err && err.stack) || err);
      _crashLog(err, 'uncaughtException');
      try { if (typeof store.close === 'function') store.close(); } catch (e) { console.error('[crash-guard] store.close 失败:', e && e.message); }
      setTimeout(function() { process.exit(1); }, 200).unref();
    });
    // task-10 A：unhandledRejection 双方向判定（GUARDIAN §4.3）；起步态（env AI_SAY_REJECTION_GUARD 缺省）全 log-only，0 行为变化
    process.on('unhandledRejection', function(reason) {
      if (_shouldFatalRejection(reason)) {
        console.error('[unhandledRejection] crash-guard fatal（GUARDIAN §4.3 判定）：记录后 close+exit(1)，拉起归 pm2：', (reason && reason.stack) || reason);
        _crashLog(reason, 'unhandledRejection');
        try { if (typeof store.close === 'function') store.close(); } catch (e) { console.error('[crash-guard] store.close 失败:', e && e.message); }
        setTimeout(function() { process.exit(1); }, 200).unref();
      } else {
        console.warn('[unhandledRejection] GUARDIAN §4.3 判定为 log-only（起步保守态 / denyByDefault=true 命中白名单），不退出:', (reason && reason.stack) || reason);
      }
    });
    process.on('SIGINT', shutdown);
    // task-36：SIGTERM（stop-console.bat / 进程管理）也要优雅退出
    process.on('SIGTERM', shutdown);
    function shutdown() {
      console.log('[shutdown] 收到退出信号，关闭 server + SQLite（task-6：close 时序对齐 pm2 kill_timeout ≥ 2000ms）…');
      try { server.close(); } catch (e) { console.error('[shutdown] server.close 失败:', e && e.message); }
      // task-6：SIGTERM/SIGINT 前显式关 SQLite（防 -wal 残留；幂等，uncaughtException 路径已关则 no-op）
      try { if (typeof store.close === 'function') store.close(); } catch (e) { console.error('[shutdown] store.close 失败:', e && e.message); }
      setTimeout(function() { process.exit(0); }, 1500).unref();
    }
  }

  // 导出供测试/组装使用
  module.exports = {
    app,
    store,
    _crashGuard: { _isWhitelistedRejection, _shouldFatalRejection, _loadRejectionGuard, _matchesGuardList, _crashLog },
    talkEngine,
    recommender,
    dedup,
    adapters,
    dbPath,
    navigateToInbox,
    assistant,
    _createServer: () => {
      const host = process.env.HOST || '127.0.0.1';
      const port = Number(process.env.PORT || 0);
      const server = http.createServer((req, res) => {
        app(req, res, () => {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, msg: 'Not Found' }));
        });
      });
      return server;
    },
  };
