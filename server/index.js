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
// 进程级兜底：CDP / WebSocket 偶发异常不得带崩整个控制台服务
// =============================================================================
process.on('uncaughtException', function(err) {
  console.error('[uncaughtException] 已兜底，服务继续:', (err && err.stack) || err);
});
process.on('unhandledRejection', function(reason) {
  console.error('[unhandledRejection] 已兜底，服务继续:', (reason && reason.stack) || reason);
});


const http = require('http');
const path = require('path');
const fs   = require('fs');

const { createApp, loadConfig } = require('./app');

// --- M0: SQLite store（自动建表，幂等） ---
const { createStore } = require('./db/store');
const dbPath = path.join(__dirname, '..', 'data', 'aisay.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const store = createStore({ dbPath });

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
  lineId: 'pending' // M4 替换为实际 LINE OA lineId
});

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
const adapters = {
  ichigo194964: {
    name: 'ichigo194964',
    create: (cdp, targetId, opts = {}) =>
      new IchigoAdapter(Object.assign({ cdp, targetId, platform: 'ichigo194964' }, opts)),
  },
};

// --- M5 核心改造①（task-36）：实时抓出会窗口（BitBrowser CDP） ---
// settings.json 已有 windowId + apiBase（BitBrowser 54346）；createLiveScanner 读 settings 后构建。
// 控制台 /api/console/live 端点实时连活 17098 窗口抓出会页面，取代静态 DB 快照卡片。
const { createLiveScanner } = require('./adapter/liveScanner');
const { createProxyPool } = require('./adapter/proxyPool');
const settingsForLive = loadConfig(); // settings.json（line 108 mountConsoleRoutes 也要用）
let liveScanner = null;
try {
  liveScanner = createLiveScanner({
    settings: {
      apiBase: settingsForLive.apiBase,
      windowId: (settingsForLive.platformGroups && settingsForLive.platformGroups[0] && settingsForLive.platformGroups[0].windows && settingsForLive.platformGroups[0].windows[0]) || settingsForLive.windowId,
    },
    adapterPlatform: 'ichigo194964',
  });
} catch (e) {
  // liveScanner 构建失败不阻断服务启动；/api/console/live 返回 501
  console.warn('[liveScanner] 构建失败，控制台 /api/console/live 将返回 501:', e && e.message);
  liveScanner = null;
}

// --- 挂载 console 路由（一次性） ---
const { mountConsoleRoutes } = require('./consoleRoutes');
const consoleRoutes = []; // { method, pathname, handler }
const consoleApp = {
  get: (p, h) => { consoleRoutes.push({ method: 'GET', pathname: p, handler: h }); },
  post: (p, h) => { consoleRoutes.push({ method: 'POST', pathname: p, handler: h }); },
};
// M5 核心改造②：17098 深度抓取器（收件箱 2 页 18 客户 + 资料页 12 字段 + 兴趣 icon 反查）
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

// Mount console read-only routes on the main app (task-19 起挂 /api/console/*)
mountConsoleRoutes(consoleApp, { store, talkEngine, dedup, adapters, recommender, liveScanner, deepScrape, ichigoCache, modelStore, translationCache, consolePrefs, accountInfo, proxyPool, settings: settingsForLive, settingsForLive: settingsForLive });


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
    // 参数段匹配：/api/console/customers/:id、/api/console/accounts/:id、
    //            /api/console/customers/:id/profile
    const pm = pathname.match(/^\/api\/console\/(customers|accounts)\/([^\/?]+)(\/profile)?$/);
    if (pm) {
      const kind = pm[1];
      const id   = pm[2];
      const tail = pm[3] || '';
      if (route.pathname === '/api/console/' + kind + '/:id' + tail) {
        req.params = { id };
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
    res.writeHead(200, { 'Content-Type': type });
    res.end(content);
    return true;
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
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
    switch (pathname) {
      case '/ichigo-console':
      case '/ichigo-console.html':
        return serveStatic(res, 'ichigo-console.html', 'text/html; charset=utf-8');
      case '/console':
      case '/console.html':
        return serveStatic(res, 'console.html', 'text/html; charset=utf-8');
      case '/console.css':
        return serveStatic(res, 'console.css', 'text/css; charset=utf-8');
      case '/console.js':
        return serveStatic(res, 'console.js', 'application/javascript; charset=utf-8');
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
  process.on('SIGINT', () => {
    server.close(() => process.exit(0));
  });
}

// 导出供测试/组装使用
module.exports = {
  app,
  store,
  talkEngine,
  recommender,
  dedup,
  adapters,
  dbPath,
  navigateToInbox,
  _createServer: () => {
    const host = process.env.HOST || '127.0.0.1';
    const port = Number(process.env.PORT || 0); // 测试传 0 随机端口
    const server = http.createServer((req, res) => {
      app(req, res, () => {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, msg: 'Not Found' }));
      });
    });
    return server;
  },
};
