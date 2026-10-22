// =============================================================================
// Ai SAY M5 · 卡片式统一控制台 · 最小后端路由（consoleRoutes.js）
// 依据：docs/plan/04-roadmap.md §2（ui 角色）+ §1 M5；task-19
//
// 导出：mountConsoleRoutes(app, { store, talkEngine, dedup, adapters })
//   - 只读统一后台 API（store / talkEngine / dedup / adapters），不写后端业务逻辑；
//   - 挂载在现有 server/app.js 创建的应用上，不改现有 app.js；
//   - 路由清单（task-19 指定）：
//       GET  /api/console/customers            客户卡片列表（画像 + 人设 + 会话 + 推荐回复）
//       GET  /api/console/customers/:id        单个客户卡片详情（对话流 + 推荐回复 + 引流事件）
//       GET  /api/console/accounts/:id         账号资料页（Account + AccountPersona）
//       GET  /api/console/customers/:id/profile  客户资料页（ContactProfile + anchors）
//       GET  /api/console/metrics              四大核心指标（自动处理/引流/LINE 转化/去重），按日聚合
//       GET  /api/console/rules                展示 GovernanceRule（store.getEffectiveRules）
//       POST /api/console/rules/rollback       话术一键回滚（调 talkEngine.rollbackTemplate / auditLog）
//       GET  /api/console/locator-misses       M2 adapter 定位失败告警（adapters.onLocatorMiss 事件）
//       GET  /api/console/likely-same          likelySame 待确认队列（dedup.scanLikelySame）
//
// 约束（ui 角色边界）：
//   - 不直接写 DOM、不抓页面（那是 adapter）；不实现评分/话术生成（engine/acquisition）；
//   - 指标只读 SQLite 聚合，延迟 ≤1min（前端轮询间隔由 console.js 控制，默认 30s~60s）；
//   - 定位失败 30s 内推送：locator-misses 端点读内存事件队列，前端 30s 轮询 + 命中新事件即上屏。
// =============================================================================
'use strict';

const http = require('http');
const net = require('net'); // task-2：/api/console/health 轻量端点探 CDP 54346 TCP 可达（不调平台 network/health、不做风控归因，GUARDIAN ⑤ 防重启风暴）

/**
 * 在现有 Express/原生 http app 上注册 /api/console/* 路由。
 * 参数对象各成员可缺省（缺省时对应端点返回 501 + 说明），方便渐进集成。
 * @param {object} app  现有 server 应用（提供 .use / .get / .post，或为 http.Server 则退化为原生 handler）
 * @param {object} deps { store, talkEngine, dedup, adapters, aiService, recommender }
 *   - store:       M0 createStore()（含 getEffectiveRules / listContacts / db）
 *   - talkEngine:  M3 createTalkEngine()（buildTalks / triggerGuide / auditLog / rollbackTemplate）
 *   - dedup:       M2 createDedup()（scanLikelySame / rollBackMerge）
 *   - adapters:    M2 平台适配器集合（onLocatorMiss 事件源；可为 { on: (ev, cb)=>... } 或数组）
 *   - recommender: M1 补强 createRecommender()（人设+画像+规则驱动的推荐回复；缺省回退裸 talkEngine）
 */
function mountConsoleRoutes(app, deps = {}) {
  const store = deps.store || null;
  const ichigoCache = deps.ichigoCache || null;
  const modelStore = deps.modelStore || null;
  const translationCache = deps.translationCache || null;
  const consolePrefs = deps.consolePrefs || null;
  const accountInfo = deps.accountInfo || null;
  const talkEngine = deps.talkEngine || null;
  const dedup = deps.dedup || null;
  const adapters = deps.adapters || null;
  const recommender = deps.recommender || null;
  const liveScanner = deps.liveScanner || null;
  const happyScanner = deps.happyScanner || null; // H4 · 快乐平台只读抓取
  const happyCache = deps.happyCache || null; // H4 缺陷6 · A 持久化（data/happy-cache.json）
  const deepScrape = deps.deepScrape || null;
  const settingsForLive = deps.settingsForLive || deps.settings || null;
  const proxyPool = deps.proxyPool || null;
  const assistant = deps.assistant || null;
  // 兼容老缓存：interestIcons 若为裸字符串数组 → 富化成 {icon,label,unknown}
  function enrichContact(c) {
    if (!c || !c.profile) return c;
    var ic = c.profile.interestIcons;
    if (Array.isArray(ic) && ic.length && typeof ic[0] !== 'object') {
      if (deepScrape && typeof deepScrape.enrichInterests === 'function') {
        c.profile.interestIcons = deepScrape.enrichInterests(ic);
      }
    } else if (Array.isArray(ic)) {
      ic.forEach(function(x) { if (x && typeof x === 'object' && x.label == null && !x.unknown) x.unknown = true; });
    }
    // 顺带保证 c.interests 存在且带 label
    if (!Array.isArray(c.interests) || !c.interests.length) {
      if (Array.isArray(c.profile.interestIcons)) c.interests = c.profile.interestIcons;
    } else {
      c.interests = c.interests.map(function(x) {
        if (x && typeof x === 'object') return x;
        return { icon: String(x), label: null, unknown: true };
      });
    }
    return c;
  }


  const db = store && store.db ? store.db : null;

  // ---------------------------------------------------------------- locator-misses
  // 内存事件队列：adapters.onLocatorMiss 推入；端点返回最近 N 条 + 未读计数（30s 推送窗口）
  const locatorMisses = { events: [], cursor: 0 };
  function pushLocatorMiss(evt) {
    locatorMisses.events.push(Object.assign({ ts: new Date().toISOString() }, evt));
    if (locatorMisses.events.length > 500) locatorMisses.events.shift();
  }
  if (adapters) {
    // adapters 可能是：① 已挂载 on(event, cb) 的对象；② 适配器数组（各自 .on）；③ 含 onLocatorMiss 直连
    const attach = [];
    if (typeof adapters.on === 'function') attach.push(adapters);
    else if (Array.isArray(adapters)) adapters.forEach((a) => attach.push(a));
    else if (adapters && typeof adapters.onLocatorMiss === 'function') {
      adapters.onLocatorMiss(pushLocatorMiss); // 直连回调
    }
    attach.forEach((a) => {
      try { a.on('locator-miss', pushLocatorMiss); } catch (_) { /* 个别适配器缺 on 则忽略 */ }
    });
  }

  // ---------------------------------------------------------------- 工具
  const json = (res, code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
  };
  const queryOf = (req) => {
    const u = new URL('http://localhost' + req.url);
    const out = {};
    u.searchParams.forEach((v, k) => { out[k] = v; });
    return out;
  };
  function getOne(res, selector) {
    if (!db) return json(res, 501, { ok: false, msg: 'store.db 未注入，无法执行查询' });
    try { return db.prepare(selector.sql).get(...selector.params); }
    catch (e) { json(res, 500, { ok: false, msg: e.message }); }
  }
  function getAll(res, selector) {
    if (!db) return json(res, 501, { ok: false, msg: 'store.db 未注入，无法执行查询' });
    try { return db.prepare(selector.sql).all(...selector.params); }
    catch (e) { json(res, 500, { ok: false, msg: e.message }); }
  }
  function allOk(res, row) {
    if (row === undefined || row === null) { json(res, 404, { ok: false, msg: 'not found' }); return; }
    json(res, 200, { ok: true, data: row });
  }
  function allOkList(res, rows) {
    json(res, 200, { ok: true, data: Array.isArray(rows) ? rows : [] });
  }

  // 兼容 Express（router/app 的 .get/.post）与原生 http.Server（通过 handler 转发）
  function register(method, pathname, handler) {
    if (app && typeof app.get === 'function' && typeof app.post === 'function') {
      if (method === 'GET') app.get(pathname, handler);
      else app.post(pathname, handler);
    } else if (app && app.listeners) {
      // 原生 http.Server：把 console 路由挂到一个内部 server 上由调用方转发。
      // 这里退化为把 handler 登记到 app.__consoleRoutes（调用方可在 server 'request' 里查表）
      if (!app.__consoleRoutes) app.__consoleRoutes = [];
      app.__consoleRoutes.push({ method, pathname, handler });
    } else {
      // 极简：直接给 app 挂方法
      const fn = app && typeof app[method.toLowerCase()] === 'function' ? app[method.toLowerCase()].bind(app) : null;
      if (fn) fn(pathname, handler);
    }
  }

  // 解析 body（原生 http 路径）
  function readBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); } catch (_) { resolve({}); }
      });
    });
  }
  function wrap(handler) {
    return async (req, res) => {
      try {
        const body = req.__body !== undefined ? req.__body : (req.method === 'POST' ? await readBody(req) : {});
        req.__body = body;
        await handler(req, res, body);
      } catch (e) {
        json(res, 500, { ok: false, msg: e.message });
      }
    };
  }

  // ---------------------------------------------------------------- 1) 客户卡片列表
  // 客户卡片 = 客户画像（ContactProfile）+ 账号人设（AccountPersona，按该客户最近会话的账号）
  //   + 最近对话流（Conversation/Message 摘要）+ 推荐回复（调 M3 talkEngine.buildTalks，按需懒加载，列表只占位）
    // 模型翻译调用（OpenAI 兼容接口）
  async function callModel(modelCfg, text, from, to, timeoutMs) {
    const prompt = '把下面' + (from === 'ja' ? '日文' : from) + '翻译成' + (to === 'zh-CN' ? '简体中文' : to) + '，只输出译文：\n' + text;
    // 硬超时：单条挂住不能拖垮整批（否则前端会出现"部分消息翻译不完"）
    const ctrl = new AbortController();
    const timer = setTimeout(function() { try { ctrl.abort(); } catch (_) {} }, timeoutMs || 25000);
    let resp;
    try {
      resp = await fetch(modelCfg.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + modelCfg.apiKey },
        body: JSON.stringify({ model: modelCfg.model || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.3 }),
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
    if (!resp.ok) throw new Error('model HTTP ' + resp.status);
    const data = await resp.json();
    const out = data.choices && data.choices[0] ? data.choices[0].message.content : '';
    if (!out) throw new Error('模型返回空');
    return out.trim();
  }

  // 模块2 · 免密钥翻译（deep_translator 子进程）：替换易超时的旧 LLM 节点
  // 调用 server/translate_service.py（Python 子进程，stdin 收 JSON 批量 → stdout 出 JSON 结果）
  // 入参预留 context/personaId（大模型角色扮演管道位），现阶段 deep_translator 透传不消费
  function callDeepTranslator(items, timeoutMs) {
    const { spawn } = require('child_process');
    const pyPath = require('path').join(__dirname, 'translate_service.py');
    const payload = JSON.stringify({ items: items, timeout_ms: timeoutMs || 8000 });
    return new Promise(function(resolve) {
      let settled = false;
      function done(v) { if (!settled) { settled = true; resolve(v); } }
      let child;
      try {
        child = spawn('python', [pyPath, payload], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        done({ ok: false, reason: 'spawn-error', msg: String((e && e.message) || e), results: {} });
        return;
      }
      let outBuf = '';
      let errBuf = '';
      const timer = setTimeout(function() {
        try { child.kill(); } catch (_) {}
        done({ ok: false, reason: 'timeout', msg: 'deep_translator 子进程超时（' + (timeoutMs || 8000) + 'ms）', results: {} });
      }, (timeoutMs || 8000) + 3000);
      child.stdout.on('data', function(d) { outBuf += d; });
      child.stderr.on('data', function(d) { errBuf += d; });
      child.on('close', function(code) {
        clearTimeout(timer);
        try {
          const j = JSON.parse(outBuf || '{}');
          if (j.ok) { done(Object.assign(j, { code: code, stderr: errBuf.slice(0, 200) })); return; }
          done({ ok: false, reason: (j && j.reason) || 'py-error', msg: ((j && j.msg) || errBuf || ('exit ' + code)).slice(0, 300), results: {} });
        } catch (_) {
          done({ ok: false, reason: 'parse-error', msg: (errBuf || outBuf || ('exit ' + code)).slice(0, 300), results: {} });
        }
      });
      child.on('error', function(e) {
        clearTimeout(timer);
        done({ ok: false, reason: 'spawn-fail', msg: String((e && e.message) || e), results: {} });
      });
    });
  }

  // 内置词典兜底（会出场景高频词，敬体→简体陈述）
  function dictFallback(text) {
    var t = String(text || '');
    var dict = [
      ['こんにちわ', '你好'], ['こんにちは', '你好'], ['こんばんは', '晚上好'], ['はじめまして', '初次见面'],
      ['ありがとうございます', '谢谢'], ['ありがとう', '谢谢'], ['メッセージ', '消息'], ['出会い', '相遇'],
      ['お会いしましょう', '见个面吧'], ['お会いしてみませんか', '不约见一下吗'], ['お相手', '对方'],
      ['胸は', '胸部是'], ['Dカップ', 'D 罩杯'], ['カップ', '罩杯'], ['住んでる', '住'], ['住んで', '住'],
      ['埼玉県', '埼玉县'], ['戸田', '户田'], ['さいたま', '埼玉'], ['岩槻', '岩槻'], ['東京', '东京'], ['神奈川', '神奈川'], ['熊谷', '熊谷'], ['上尾', '上尾'],
      ['大丈夫', '没问题'], ['もちろん', '当然'], ['お願いします', '拜托了'], ['いいです', '可以'], ['無理', '不行'],
      ['カラオケ', '卡拉OK'], ['温泉', '温泉'], ['ゴルフ', '高尔夫'], ['ゲーム', '游戏'], ['お笑い', '搞笑'],
      ['スイーツ', '甜点'], ['動物', '动物'], ['漫画', '漫画'], ['恋愛', '恋爱'], ['結婚', '结婚'],
      ['たばこ', '烟'], ['お酒', '酒'], ['車', '车'], ['吸わない', '不抽'], ['飲まない', '不喝'],
      ['会社員', '公司职员'], ['サービス業', '服务业'], ['未婚', '未婚'], ['独身', '单身'],
      ['目的が合えば会いたい', '目标合得来就想见'], ['フィーリング', '感觉'], ['平日休み', '平日休息'],
      ['優しく穏やか', '温柔稳重'], ['気持ち良い時間', '舒爽时光'], ['刺激', '刺激'], ['大人の関係', '大人的关系'],
      ['キス', '亲吻'], ['フェラ', '口交'], ['ゴム', '避孕套'], ['予算', '预算'], ['会える', '能见'],
      ['メッセージありがとうございます', '消息收到了谢谢'], ['出会えてますか', '有遇到合适的人吗'],
      ['優しく穏やかな女性', '温柔稳重的女性'], ['お喋り', '聊天'], ['過ごす', '度过'],
    ];
    dict.forEach(function(kv) { t = t.split(kv[0]).join(kv[1]); });
    t = t.replace(/ます[。．]?s*/g, '').replace(/です[。．]?s*/g, '').replace(/ですか[？?]?s*/g, '？').replace(/ます/g, '').replace(/ですか/g, '吗');
    return t;
  }

register('GET', '/api/console/customers', wrap(async (req, res) => {
    if (!db) return json(res, 501, { ok: false, msg: 'store.db 未注入' });
    const q = queryOf(req);
    const limit = Math.min(Number(q.limit) || 50, 200);
    const lifecycle = q.lifecycle;
    const accountId = q.accountId;
    // task-32：?tag=<layer>:<value>（按 Tag.appliedTo 层筛客户，只读）
    const tagFilter = q.tag;
    let tagContactIds = null; // 命中该标签的 contactId 集合；null=不启用
    let tagApplied = null; // { layer, value } 回显
    if (tagFilter) {
      const sepIdx = String(tagFilter).indexOf(':');
      const layer = sepIdx > 0 ? String(tagFilter).slice(0, sepIdx) : String(tagFilter);
      const value = sepIdx > 0 ? String(tagFilter).slice(sepIdx + 1) : '';
      tagApplied = { layer, value };
      try {
        const rowsT = db.prepare(
          "SELECT tagId, appliedTo FROM Tag WHERE layer = ? AND value = ?"
        ).all(layer, value);
        const idSet = new Set();
        rowsT.forEach((t) => {
          let applied = [];
          try { applied = JSON.parse(t.appliedTo || '[]'); } catch (_) { applied = []; }
          (Array.isArray(applied) ? applied : [applied]).forEach((cid) => {
            if (cid) idSet.add(String(cid));
          });
        });
        tagContactIds = Array.from(idSet);
      } catch (_) { tagContactIds = []; }
      // 若标签命中 0 客户：直接返回空
      if (!tagContactIds.length) {
        json(res, 200, { ok: true, data: [], total: 0, tag: tagApplied });
        return;
      }
    }
    let rows;
    try {
      // accountId 过滤（多账号切换顶栏）：只取该账号参与会话的客户
      // task-32：tag 过滤（Tag.appliedTo 命中客户）；两者可叠加（交集）
      let candidateIds = null;
      if (accountId) {
        const convRows = db.prepare(
          "SELECT DISTINCT conv.contactId FROM Conversation conv " +
          "JOIN Contact c ON c.contactId = conv.contactId AND c.mergedInto IS NULL " +
          "WHERE conv.accountId = ?"
        ).all(accountId);
        candidateIds = convRows.map((r) => r.contactId).filter(Boolean);
      }
      if (tagContactIds !== null) {
        candidateIds = candidateIds === null
          ? tagContactIds.slice()
          : candidateIds.filter((id) => tagContactIds.includes(id));
      }

      if (candidateIds !== null) {
        if (!candidateIds.length) { rows = []; }
        else {
          const ph = candidateIds.map(() => '?').join(',');
          if (lifecycle) {
            rows = db.prepare(
              'SELECT c.contactId, c.displayName, c.nickname, c.lifecycle, c.firstSeen, c.lastSeen, c.mergedInto ' +
              'FROM Contact c WHERE c.lifecycle = ? AND c.contactId IN (' + ph + ') ORDER BY c.lastSeen DESC LIMIT ?'
            ).all(lifecycle, ...candidateIds, limit);
          } else {
            rows = db.prepare(
              'SELECT c.contactId, c.displayName, c.nickname, c.lifecycle, c.firstSeen, c.lastSeen, c.mergedInto ' +
              'FROM Contact c WHERE c.contactId IN (' + ph + ') ORDER BY c.lastSeen DESC LIMIT ?'
            ).all(...candidateIds, limit);
          }
        }
      } else if (lifecycle) {
        rows = db.prepare(
          'SELECT c.contactId, c.displayName, c.nickname, c.lifecycle, c.firstSeen, c.lastSeen, c.mergedInto ' +
          'FROM Contact c WHERE c.lifecycle = ? ORDER BY c.lastSeen DESC LIMIT ?'
        ).all(lifecycle, limit);
      } else {
        rows = db.prepare(
          'SELECT c.contactId, c.displayName, c.nickname, c.lifecycle, c.firstSeen, c.lastSeen, c.mergedInto ' +
          'FROM Contact c ORDER BY c.lastSeen DESC LIMIT ?'
        ).all(limit);
      }
    } catch (e) { return json(res, 500, { ok: false, msg: e.message }); }

    // 批量补画像（一次查询，避免 N+1）
    const ids = rows.map((r) => r.contactId).filter(Boolean);
    let profiles = {};
    if (ids.length) {
      try {
        const ph = ids.map(() => '?').join(',');
        const pRows = db.prepare(
          'SELECT contactId, age, region, height, occupation, language, intent, interests, historySummary, confidence ' +
          'FROM ContactProfile WHERE contactId IN (' + ph + ')'
        ).all(...ids);
        pRows.forEach((p) => { profiles[p.contactId] = p; });
      } catch (_) { /* 画像表缺失时卡片退化为仅显示 Contact 基础字段 */ }
    }

    // 批量补每个客户最近一条会话（用于卡片展示「对话流摘要」+ 绑定账号人设）
    let latestConv = {};
    if (ids.length) {
      try {
        const ph = ids.map(() => '?').join(',');
        const convs = db.prepare(
          'SELECT conv.contactId, conv.conversationId, conv.channel, conv.lastActiveAt, conv.accountId ' +
          'FROM Conversation conv WHERE conv.contactId IN (' + ph + ') ' +
          'ORDER BY conv.lastActiveAt DESC LIMIT ?'
        ).all(...ids, ids.length * 5);
        convs.forEach((c2) => {
          if (!latestConv[c2.contactId]) latestConv[c2.contactId] = c2;
        });
      } catch (_) { /* 会话表缺失则跳过 */ }
    }

    // 账号人设：按最近会话的 accountId 取 active 人设（人设标签驱动推荐回复的「账号人设」维度）
    let personaByAccount = {};
    const accountIds = Object.values(latestConv).map((c) => c.accountId).filter(Boolean);
    if (accountIds.length) {
      try {
        const ph = accountIds.map(() => '?').join(',');
        const ps = db.prepare(
          "SELECT accountId, persona, tone, background, targetAudience, taboos, status FROM AccountPersona " +
          "WHERE accountId IN (" + ph + ") AND status = 'active'"
        ).all(...accountIds);
        ps.forEach((p) => {
          try { personaByAccount[p.accountId] = {
            persona: p.persona ? JSON.parse(p.persona) : null,
            tone: p.tone, background: p.background,
            targetAudience: p.targetAudience,
            taboos: p.taboos ? JSON.parse(p.taboos) : [],
          }; } catch (_) { personaByAccount[p.accountId] = null; }
        });
      } catch (_) { /* 人设表缺失则卡片人设维度留空 */ }
    }

    // task-32：每个客户的 funnel 当前层（会话/评分/hot/引流/留LINE/绑定）
    const funnelLayerOf = (contactId) => {
      try {
        // 1. 无会话？（直接查 Conversation，不依赖 latestConv）
        const hasConv = db.prepare('SELECT COUNT(*) n FROM Conversation WHERE contactId = ?').get(contactId).n;
        if (!hasConv) return { stage: 'none', label: '无会话', progress: 0 };
        // 2. 已绑定？（task-33 口径：EXISTS LineBind WHERE contactId=?）
        const bound = db.prepare('SELECT COUNT(*) n FROM LineBind WHERE contactId = ?').get(contactId).n;
        if (bound) return { stage: 'bound', label: '已绑定 LineMember', progress: 1 };
        // 3. 已留 LINE？（LeadEvent.lineAdded=1）
        const lineAdded = db.prepare('SELECT COUNT(*) n FROM LeadEvent WHERE contactId = ? AND lineAdded = 1').get(contactId).n;
        if (lineAdded) return { stage: 'line_added', label: '已留 LINE', progress: 5 / 6 };
        // 4. 已引流？（LeadEvent.lineOffered=1）
        const offered = db.prepare('SELECT COUNT(*) n FROM LeadEvent WHERE contactId = ? AND lineOffered = 1').get(contactId).n;
        if (offered) return { stage: 'lead_offered', label: '已引流（推LINE）', progress: 4 / 6 };
        // 5. hot 客户？（LeadEvent.tier='hot'）
        const hot = db.prepare("SELECT COUNT(*) n FROM LeadEvent WHERE contactId = ? AND tier = 'hot'").get(contactId).n;
        if (hot) return { stage: 'hot', label: 'hot 客户', progress: 3 / 6 };
        // 6. 已评分？（task-33 口径：EXISTS LeadEvent WHERE contactId=? AND action IN (...)）
        const scored = db.prepare(
          "SELECT COUNT(*) n FROM LeadEvent WHERE contactId = ? AND action IN ('triggered','scored','reminded','archived')"
        ).get(contactId).n;
        if (scored) return { stage: 'scored', label: '已评分', progress: 2 / 6 };
        // 7. 只有会话、无评分 → 会话层
        return { stage: 'conversation', label: '会话', progress: 1 / 6 };
      } catch (_) { return { stage: 'none', label: '无会话', progress: 0 }; }
    };

    const items = rows.map((r) => {
      const profile = profiles[r.contactId] || null;
      const conv = latestConv[r.contactId] || null;
      const persona = conv && personaByAccount[conv.accountId] ? personaByAccount[conv.accountId] : null;
      const funnel = funnelLayerOf(r.contactId);
      return {
        contactId: r.contactId,
        funnelCurrentLayer: funnel,
        displayName: r.displayName,
        nickname: r.nickname,
        lifecycle: r.lifecycle,
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
        mergedInto: r.mergedInto || null,
        profile: profile ? {
          age: profile.age, region: profile.region, height: profile.height,
          occupation: profile.occupation, language: profile.language,
          intent: profile.intent, interests: profile.interests ? JSON.parse(profile.interests) : [],
          historySummary: profile.historySummary, confidence: profile.confidence,
        } : null,
        latestConversation: conv ? {
          conversationId: conv.conversationId, channel: conv.channel,
          lastActiveAt: conv.lastActiveAt, accountId: conv.accountId,
        } : null,
        accountPersona: persona, // 卡片「账号人设标签」维度
        recommendedReply: null, // 列表不预生成话术（避免 buildTalks 批量调用）；详情端点按需生成
      };
    });
    json(res, 200, { ok: true, data: items, total: items.length, tag: tagApplied });
  }));

  // ---------------------------------------------------------------- 1a) 标签分布（task-32：各 Tag 层的 value + 客户数）
  // GET /api/console/tags → [{ layer, values: [{ value, contactCount, tags }] }]
  // 只读 M0 Tag 表；appliedTo 为 JSON 数组（contactId/openId），按去重后的 contactId 数计
  register('GET', '/api/console/tags', wrap(async (req, res) => {
    if (!db) return json(res, 501, { ok: false, msg: 'store.db 未注入' });
    const LAYERS = ['source', 'intent', 'category', 'status', 'ops'];
    let tagRows = [];
    try {
      tagRows = db.prepare('SELECT layer, value, appliedTo FROM Tag').all();
    } catch (e) { return json(res, 500, { ok: false, msg: e.message }); }
    // 按 layer → value 聚合
    const byLayer = {};
    LAYERS.forEach((l) => { byLayer[l] = {}; });
    tagRows.forEach((t) => {
      if (!byLayer[t.layer]) byLayer[t.layer] = {};
      const bucket = byLayer[t.layer][t.value] = (byLayer[t.layer][t.value] || { ids: new Set(), tags: 0 });
      let applied = [];
      try { applied = JSON.parse(t.appliedTo || '[]'); } catch (_) { applied = []; }
      (Array.isArray(applied) ? applied : [applied]).forEach((cid) => {
        if (cid) bucket.ids.add(String(cid));
      });
      bucket.tags += 1;
    });
    const data = LAYERS.map((l) => {
      const values = Object.entries(byLayer[l] || {}).map(([value, b]) => ({
        value,
        contactCount: b.ids.size,
        tagCount: b.tags,
      }));
      values.sort((a, b) => b.contactCount - a.contactCount);
      return { layer: l, values };
    });
    json(res, 200, { ok: true, data, totalTags: tagRows.length });
  }));

  // ---------------------------------------------------------------- 2) 单客户卡片详情
  register('GET', '/api/console/customers/:id', wrap(async (req, res, body) => {
    const params = req.params || {};
    const contactId = params.id;
    if (!contactId) return json(res, 400, { ok: false, msg: '缺少 :id' });
    if (!db) return json(res, 501, { ok: false, msg: 'store.db 未注入' });
    const row = db.prepare('SELECT * FROM Contact WHERE contactId = ?').get(contactId);
    if (!row) return json(res, 404, { ok: false, msg: '客户不存在' });
    const profile = db.prepare('SELECT * FROM ContactProfile WHERE contactId = ?').get(contactId) || null;
    const anchors = db.prepare('SELECT * FROM ContactAnchor WHERE contactId = ?').all(contactId);
    const convs = db.prepare(
      'SELECT conv.*, con.displayName AS convContactName, con.lifecycle AS convLifecycle ' +
      'FROM Conversation conv LEFT JOIN Contact con ON con.contactId = conv.contactId ' +
      'WHERE conv.contactId = ? ORDER BY conv.lastActiveAt DESC LIMIT 50'
    ).all(contactId);
    const leads = db.prepare(
      "SELECT * FROM LeadEvent WHERE contactId = ? ORDER BY createdAt DESC LIMIT 50"
    ).all(contactId);

    // 对话流：取最近一条会话的消息（角色/原文/译文/时间）
    let messages = [];
    if (convs.length && db.prepare('SELECT * FROM Message WHERE conversationId = ? ORDER BY seq DESC LIMIT 1').get(convs[0].conversationId)) {
      messages = db.prepare('SELECT seq, role, original, translation, timeText, timeIso, kind, name, url FROM Message WHERE conversationId = ? ORDER BY seq ASC LIMIT 200').all(convs[0].conversationId);
    }

    // 推荐回复：优先 M1 补强 recommender（人设+画像+规则 三要素 LLM 个性化，
    //            hot 走 aiService、warm/cold 走 talkEngine 模板、合规闸门逐条过滤）；
    //            recommender 未注入时回退裸调 talkEngine.buildTalks（兼容旧调用方）
    let recommendedReply = null;
    try {
      const rules = store.getEffectiveRules({ contactId }) || { rules: [], denyByDefault: false };
      const conv0 = convs[0];
      const accountId = conv0 ? conv0.accountId : null;
      const personaRow = accountId ? db.prepare("SELECT * FROM AccountPersona WHERE accountId = ? AND status='active'").get(accountId) : null;
      const accountPersona = personaRow ? {
        persona: personaRow.persona ? JSON.parse(personaRow.persona) : null,
        tone: personaRow.tone, background: personaRow.background,
        targetAudience: personaRow.targetAudience,
        taboos: personaRow.taboos ? JSON.parse(personaRow.taboos) : [],
      } : null;
      const customerProfile = profile ? {
        contactId, name: row.displayName, region: profile.region, age: profile.age,
        interest: profile.interests, intent: profile.intent,
      } : { contactId, name: row.displayName };
      const tier = leads.length ? leads[0].tier : 'warm';

      if (recommender && typeof recommender.recommendReply === 'function') {
        const rec = await recommender.recommendReply({
          conversationId: conv0 ? conv0.conversationId : null,
          accountPersona,
          customerProfile,
          governanceRules: rules,
          tier,
          messages: messages, // 最近对话流，供 LLM 上下文
        });
        recommendedReply = {
          replies: rec.replies || [],
          source: rec.source || 'none',
          tier: rec.tier || tier,
          gated: rec.gated || [],
          leadEventId: rec.leadEvent && rec.leadEvent.leadEventId ? rec.leadEvent.leadEventId : null,
          note: rec.note || '',
          ok: rec.ok === true,
        };
      } else if (talkEngine && typeof talkEngine.buildTalks === 'function') {
        // 回退路径：裸调 M3 talkEngine（旧行为）
        const talk = talkEngine.buildTalks(
          'outreach', 'ja', tier, conv0 ? conv0.channel : 'platform_dm',
          accountPersona, customerProfile, rules,
        );
        recommendedReply = {
          guide: talk.texts && talk.texts.guide || '',
          remind: talk.texts && talk.texts.remind || '',
          variant: talk.variant, tier: talk.tier,
          templateVersion: talk.templateVersion,
          gateOk: talk.gate ? talk.gate.ok : null,
          gateReason: talk.gate ? talk.gate.reason : '',
          personalized: talk.personalized === true,
          fallback: talk.fallback === true,
        };
      }
    } catch (e) {
      recommendedReply = { replies: [], note: '推荐回复失败: ' + e.message };
    }

    json(res, 200, {
      ok: true,
      data: {
        contact: row,
        profile: profile,
        anchors: anchors,
        conversations: convs,
        messages,
        leadEvents: leads,
        recommendedReply,
      },
    });
  }));

  // ---------------------------------------------------------------- 3) 账号资料页（AccountPersona）
  register('GET', '/api/console/accounts/:id', wrap(async (req, res) => {
    const params = req.params || {};
    const accountId = params.id;
    if (!accountId) return json(res, 400, { ok: false, msg: '缺少 :id' });
    if (!db) return json(res, 501, { ok: false, msg: 'store.db 未注入' });
    const account = db.prepare('SELECT * FROM Account WHERE accountId = ?').get(accountId);
    if (!account) return json(res, 404, { ok: false, msg: '账号不存在' });
    const personas = db.prepare('SELECT * FROM AccountPersona WHERE accountId = ? ORDER BY status, updatedAt DESC').all(accountId);
    const windows = db.prepare('SELECT * FROM WindowInstance WHERE accountId = ?').all(accountId);
    const convCount = db.prepare('SELECT COUNT(*) AS n FROM Conversation WHERE accountId = ?').get(accountId);
    json(res, 200, {
      ok: true,
      data: {
        account,
        personas: personas.map((p) => ({
          ...p,
          persona: p.persona ? JSON.parse(p.persona) : null,
          taboos: p.taboos ? JSON.parse(p.taboos) : [],
        })),
        windows,
        conversationCount: convCount ? convCount.n : 0,
      },
    });
  }));

  // ---------------------------------------------------------------- 4) 客户资料页（CustomerProfile）
  register('GET', '/api/console/customers/:id/profile', wrap(async (req, res) => {
    const params = req.params || {};
    const contactId = params.id;
    if (!contactId) return json(res, 400, { ok: false, msg: '缺少 :id' });
    if (!db) return json(res, 501, { ok: false, msg: 'store.db 未注入' });
    const profile = db.prepare('SELECT * FROM ContactProfile WHERE contactId = ?').get(contactId) || null;
    const contact = db.prepare('SELECT * FROM Contact WHERE contactId = ?').get(contactId) || null;
    const anchors = db.prepare('SELECT * FROM ContactAnchor WHERE contactId = ?').all(contactId);
    json(res, 200, { ok: true, data: { contact, profile, anchors } });
  }));

  // ---------------------------------------------------------------- 5) 指标看板（按日聚合，延迟≤1min）
  // 四大核心指标（04 §4）：
  //   自动处理覆盖率 = 有画像(≥10字段)且 ≥1 条自动回复/引流决策 的新会话 / 全部新会话
  //   引流成功率    = 触发成功率(发出/决策) 与 转化成功率(正向响应/发出)
  //   LINE 转化率   = 已绑定 LineMember 客户 / M3 转化成功客户
  //   去重准确率    = 误并率/漏并率（由人工抽检标签驱动，端点仅返回 MergeEvent 计数 + 队列）
  register('GET', '/api/console/metrics', wrap(async (req, res) => {
    if (!db) return json(res, 501, { ok: false, msg: 'store.db 未注入' });
    const q = queryOf(req);
    const days = Math.min(Number(q.days) || 30, 90);
    const since = new Date(Date.now() - days * 86400000).toISOString();

    function scalar(sql, ...p) {
      try { const r = db.prepare(sql).get(...p); return r ? (Object.values(r)[0]) : 0; }
      catch (_) { return 0; }
    }

    // 自动处理覆盖率（M1 ≥80% / M3 ≥95%）
    const newConvs = scalar('SELECT COUNT(*) FROM Conversation WHERE createdAt >= ?', since);
    const autoHandled = scalar(
      'SELECT COUNT(DISTINCT conv.conversationId) FROM Conversation conv ' +
      'JOIN ContactProfile p ON p.contactId = conv.contactId ' +
      'JOIN LeadEvent l ON l.contactId = conv.contactId ' +
      'WHERE conv.createdAt >= ? AND p.confidence IS NOT NULL',
      since,
    );
    const coverageRate = newConvs ? Math.round((autoHandled / newConvs) * 1000) / 10 : 0;

    // 引流成功率（触发 + 转化）
    const leadTriggered = scalar("SELECT COUNT(*) FROM LeadEvent WHERE action = 'triggered' AND createdAt >= ?", since);
    const leadOffered = scalar("SELECT COUNT(*) FROM LeadEvent WHERE action = 'triggered' AND lineOffered = 1 AND createdAt >= ?", since);
    const leadPositive = scalar("SELECT COUNT(*) FROM LeadEvent WHERE lineAdded = 1 AND createdAt >= ?", since);
    const triggerSuccessRate = leadTriggered ? Math.round((leadOffered / leadTriggered) * 1000) / 10 : 0;
    const conversionSuccessRate = leadOffered ? Math.round((leadPositive / leadOffered) * 1000) / 10 : 0;

    // LINE 转化率 = 已绑定 LineMember / 转化成功客户
    const boundLine = scalar('SELECT COUNT(*) FROM LineBind');
    const lineConversionRate = leadPositive ? Math.round((boundLine / leadPositive) * 1000) / 10 : 0;

    // 去重准确率（MergeEvent 维度；误并/漏并需人工抽检，端点返回 raw 计数 + 队列数）
    const mergedTotal = scalar("SELECT COUNT(*) FROM MergeEvent WHERE direction = \"merge\" AND reason NOT LIKE 'queue: %'");
    const rolledBack = scalar("SELECT COUNT(*) FROM MergeEvent WHERE direction = \"rollback\"");
    const likelySameQueued = scalar("SELECT COUNT(*) FROM MergeEvent WHERE reason LIKE 'queue: %'");

    // 按日聚合（趋势线）
    let daily = [];
    try {
      daily = db.prepare(
        "SELECT date(createdAt) AS d, " +
        "COUNT(*) AS leads, " +
        "SUM(CASE WHEN lineOffered = 1 THEN 1 ELSE 0 END) AS offered, " +
        "SUM(CASE WHEN lineAdded = 1 THEN 1 ELSE 0 END) AS positive " +
        "FROM LeadEvent WHERE createdAt >= ? GROUP BY d ORDER BY d ASC"
      ).all(since); // task-36 修 Bug：参数放 .all(since)，原 prepare(sql, since) 把 since 当 options 抛错被吞 → 趋势线恒空
    } catch (_) { daily = []; }

    // ---------------------------------------------------------- 引流漏斗（6 层，task-28）
    // 会话 → 已评分(LeadEvent) → hot 客户 → 已引流(lineOffered) → 已留LINE(lineAdded) → 已绑定(LineBind)
    // 每层 count + 相对上一层的转化率（百分比，1 位小数）
    const funnelCounts = [
      scalar('SELECT COUNT(DISTINCT conversationId) FROM Conversation WHERE createdAt >= ?', since), // 1 会话总数
      scalar('SELECT COUNT(DISTINCT contactId) FROM LeadEvent WHERE createdAt >= ?', since),         // 2 已评分客户
      scalar("SELECT COUNT(DISTINCT contactId) FROM LeadEvent WHERE tier = 'hot' AND createdAt >= ?", since), // 3 hot 客户
      scalar("SELECT COUNT(DISTINCT contactId) FROM LeadEvent WHERE lineOffered = 1 AND createdAt >= ?", since), // 4 已引流
      scalar("SELECT COUNT(DISTINCT contactId) FROM LeadEvent WHERE lineAdded = 1 AND createdAt >= ?", since),   // 5 已留 LINE
      scalar('SELECT COUNT(DISTINCT openId) FROM LineMember'),                                                 // 6 已绑定 LineMember
    ];
    const funnel = funnelCounts.map((count, i) => {
      const prev = i === 0 ? null : funnelCounts[i - 1];
      const rate = (prev === null || prev === 0 || count === 0 && i > 0)
        ? (i === 0 ? 100 : 0)
        : Math.round((count / prev) * 1000) / 10;
      const labels = ['会话总数', '已评分', 'hot 客户', '已引流', '已留 LINE', '已绑定 LineMember'];
      return { layer: labels[i], count, rate: prev === null ? 100 : rate, prev };
    });

    // ---------------------------------------------------------- byAccount（跨账号运营视图）
    // 按 accountId 分组：客户数（去重 contactId）+ 会话数 + hot 客户数
    let byAccount = [];
    try {
      byAccount = db.prepare(
        'SELECT conv.accountId, a.platform, a.label AS accountLabel, ' +
        'COUNT(DISTINCT conv.conversationId) AS conversationCount, ' +
        'COUNT(DISTINCT conv.contactId) AS contactCount ' +
        'FROM Conversation conv LEFT JOIN Account a ON a.accountId = conv.accountId ' +
        'WHERE conv.accountId IS NOT NULL ' +
        'GROUP BY conv.accountId, a.accountId ORDER BY conversationCount DESC LIMIT 50'
      ).all();
      // hot 客户数（按账号）
      const hotByAccount = db.prepare(
        "SELECT conv.accountId, COUNT(DISTINCT l.contactId) AS hotCount " +
        "FROM LeadEvent l JOIN Conversation conv ON conv.contactId = l.contactId " +
        "WHERE l.tier = 'hot' GROUP BY conv.accountId"
      ).all();
      const hotMap = {};
      hotByAccount.forEach((r) => { hotMap[r.accountId] = r.hotCount; });
      byAccount = byAccount.map((a) => ({
        accountId: a.accountId,
        platform: a.platform || '—',
        label: a.accountLabel || '',
        contactCount: a.contactCount || 0,
        conversationCount: a.conversationCount || 0,
        hotCount: hotMap[a.accountId] || 0,
      }));
    } catch (_) { byAccount = []; }

    // ---------------------------------------------------------- dataFreshness（数据新鲜度面板）
    // 各核心表的 lastUpdated（max(createdAt/updatedAt)）+ 行数；>60s 视为「过期」（前端标黄）
    const tables = ['Contact', 'Conversation', 'Message', 'LeadEvent', 'LineMember'];
    const freshnessThresholdMs = 60000; // 60s
    const nowMs = Date.now();
    let dataFreshness = [];
    try {
      dataFreshness = tables.map((t) => {
        // 各核心表的「最后更新」时间戳列（不存在则用 createdAt 兜底）
        const tsCol = t === 'Contact' ? 'lastSeen'
          : t === 'Conversation' ? 'lastActiveAt'
          : t === 'LineMember' ? 'updatedAt'
          : 'createdAt'; // Message / LeadEvent / 其余
        const row = db.prepare('SELECT COUNT(*) AS n, MAX(' + tsCol + ') AS lastTs FROM ' + t).get();
        const count = row ? (row.n || 0) : 0;
        const lastTs = row && row.lastTs ? Date.parse(row.lastTs) : null;
        const ageMs = lastTs ? nowMs - lastTs : null;
        return {
          table: t,
          count,
          lastUpdated: row && row.lastTs ? row.lastTs : null,
          ageMs,
          stale: ageMs !== null && ageMs > freshnessThresholdMs, // >60s 标黄
        };
      });
    } catch (_) { dataFreshness = []; }

    json(res, 200, {
      ok: true,
      data: {
        since, days,
        autoHandling: { rate: coverageRate, handled: autoHandled, total: newConvs, target: 80 },
        leadAcquisition: {
          triggerSuccessRate, conversionSuccessRate,
          triggered: leadTriggered, offered: leadOffered, positive: leadPositive,
          triggerTarget: 99, conversionTarget: 20,
        },
        lineConversion: { rate: lineConversionRate, bound: boundLine, target: 60 },
        dedup: {
          mergedTotal, rolledBack, likelySameQueued,
          falseMergeTarget: 5, missMergeTarget: 10,
        },
        // ---- task-28 新增 ----
        funnel,
        byAccount,
        dataFreshness,
        daily,
        computedAt: new Date().toISOString(),
      },
    });
  }));

  // ---------------------------------------------------------------- 6) 统一规则面板（GovernanceRule）
  register('GET', '/api/console/rules', wrap(async (req, res) => {
    if (!store || typeof store.getEffectiveRules !== 'function') {
      return json(res, 501, { ok: false, msg: 'store.getEffectiveRules 未注入' });
    }
    const q = queryOf(req);
    // 展示全部 active 规则（不按 scope 过滤，控制台全局管理视图）
    const scope = {
      platform: q.platform || undefined,
      accountId: q.accountId || undefined,
      channel: q.channel || undefined,
    };
    const effective = store.getEffectiveRules(scope);
    let all = [];
    if (db) {
      try {
        all = db.prepare("SELECT * FROM GovernanceRule WHERE status = 'active' ORDER BY priority DESC, ruleType").all();
      } catch (_) { all = effective.rules; }
    } else {
      all = effective.rules;
    }
    json(res, 200, {
      ok: true,
      data: {
        effective: { denyByDefault: effective.denyByDefault, count: effective.rules.length },
        rules: all,
      },
    });
  }));

  // ---------------------------------------------------------------- 7) 话术一键回滚（调 M3 talkEngine.rollbackLastTalk）
  // POST /api/console/rules/rollback { contactId? , templateVersion? }
  //   - 指定 contactId 时：调 talkEngine.rollbackLastTalk(contactId)
  //     （读最近一条 sentLog + 写 LeadEvent(action='archived') + TalkAbStat 版本回退 1 次）；
  //   - 未指定 contactId 时：全局回退——读当前 effective 规则（store.getEffectiveRules）写一条
  //     MergeEvent(direction='rollback', reason='rollback: global-talk') 审计，
  //     并对 abStats.winner 行置 reDecide 标记（需 M3 下次 recordConversion 重新裁决）。
  register('POST', '/api/console/rules/rollback', wrap(async (req, res, body) => {
    if (!talkEngine) return json(res, 501, { ok: false, msg: 'talkEngine 未注入，无法回滚话术' });
    const contactId = body && body.contactId ? String(body.contactId) : '';
    let result = null;

    if (contactId && typeof talkEngine.rollbackLastTalk === 'function') {
      result = talkEngine.rollbackLastTalk(contactId);
      // 审计：写 MergeEvent（direction='rollback'）记录全局话术版本回退（02 章合并审计可追溯）
      if (db) {
        try {
          const crypto = require('crypto');
          const mergeEventId = crypto.createHash('sha1').update('rollback/talk/' + contactId + '/' + Date.now()).digest('hex');
          const survivor = db.prepare("SELECT contactId FROM Contact WHERE contactId = ?").get(contactId);
          if (survivor) {
            db.prepare(
              "INSERT INTO MergeEvent (mergeEventId,survivorContactId,mergedContactId,reason,anchorKind,direction,rollbackOf,createdAt) " +
              "VALUES (?,?,?,'rollback: talk-version-revert','weak','rollback',NULL,?)"
            ).run(mergeEventId, contactId, contactId, new Date().toISOString());
          }
        } catch (_) { /* MergeEvent 写入失败不阻断回滚主流程 */ }
      }
      json(res, 200, {
        ok: true,
        data: Object.assign({}, result, {
          note: '已回退该客户最近一次 A/B 记账；TalkAbStat winner 标记 reDecide，下次 recordConversion 重新裁决模板版本',
        }),
      });
      return;
    }

    // 无 contactId → 全局回退（仅审计 + abStats.winner 重置）
    if (typeof talkEngine.rollbackLast === 'function') {
      result = talkEngine.rollbackLast();
    } else if (typeof talkEngine.rollback === 'function') {
      result = talkEngine.rollback(body && body.templateVersion || null);
    } else if (typeof talkEngine.getAbStats === 'function') {
      // 兜底：读当前 abStats（含 winner 裁决），提示需调用 M3 recordConversion 重新裁决
      result = {
        via: 'abStats-snapshot',
        abStats: talkEngine.getAbStats(),
        note: '未指定 contactId 且 talkEngine 未暴露 rollbackLast/rollback，仅返回当前 A/B 统计快照',
      };
    } else {
      return json(res, 501, { ok: false, msg: 'talkEngine 未暴露回滚/统计接口' });
    }
    json(res, 200, { ok: true, data: result });
  }));

  // ---------------------------------------------------------------- 8) M2 定位失败告警（onLocatorMiss）
  register('GET', '/api/console/locator-misses', wrap(async (req, res) => {
    const q = queryOf(req);
    const sinceCursor = Number(q.sinceCursor) || 0;
    const windowMs = Number(q.windowMs) || 30000; // 30s 推送窗口
    const cutoff = Date.now() - windowMs;
    const events = locatorMisses.events
      .filter((e, i) => i >= sinceCursor && (Date.parse(e.ts) || 0) >= cutoff)
      .map((e, i) => Object.assign({ cursor: sinceCursor + i + 1 }, e));
    json(res, 200, {
      ok: true,
      data: { events, total: locatorMisses.events.length, nextCursor: locatorMisses.events.length },
      note: '前端 30s 轮询；命中新 locator-miss 即上屏告警卡片（04 M5 验收：DOM 告警 30s 内推送）',
    });
  }));

  // ---------------------------------------------------------------- 8b) M5 核心改造①（task-36）：实时抓出会窗口
  // GET /api/console/live → 连活 17098 窗口（BitBrowser CDP）抓出会页面：
  //   返回 { window, accounts[], contacts[], messages[], profile, locatorMissCount }；
  //   窗口未开 / 连不上时 { ok:false, reason }，不卡死、不 500。
  // 现有 /api/console/customers 保持读 DB 快照（兼容）；前端 console.js 切到本端点。
  register('GET', '/api/console/live', wrap(async (req, res) => {
    if (!liveScanner || typeof liveScanner.scanLive !== 'function') {
      return json(res, 501, { ok: false, msg: 'liveScanner 未注入，无法抓出会窗口实时数据' });
    }
    try {
      const result = await liveScanner.scanLive();
      json(res, 200, result);
    } catch (e) {
      json(res, 200, { ok: false, reason: 'scan-exception', msg: String(e && e.message || e) });
    }
  }));

  // ---------------------------------------------------------------- 
  // ---------------------------------------------------------------- 8c) M5 核心改造②：17098 深度抓取（收件箱 2 页 18 客户 + 资料页 12 字段 + 兴趣 icon 反查）
  // GET /api/console/live/deep → 连活 17098 窗口深度抓取：
  //   返回 { ok, contacts[], nav[], paginator, fetchedAt }；
  //   每个 contact: { raw, link, name, profile, interests[], bbsPosts[], avatarUrl, avatarIsDefault }；
  //   窗口未开 / 连不上时 { ok:false, reason }，不卡死、不 500。
    // ---------------- 三层缓存 API（P0/P1 重构） ----------------

  // GET /api/console/mailbox → 轻量轮询：抓收件箱 → 写缓存 → 返回轻量列表（含未读）
  // 模块 1 · 出会消息队列过滤：?includeArchived=1 时含归档/拉黑客户（默认 0 排除）
  // 给 contacts 加 archived/blacklisted 字段 + 按 includeArchived 过滤
  // 模块1 · applyFlagsAndFilter：liveSet（本次 CDP 真实抓到的 contactId 集合）内的客户
  //   即使 DB 有 archived/blacklisted 旧标志也强制置 0（真实窗口为准——客户还在窗口里 = 没被删）
  //   只有 liveSet 之外 + DB 标志=1 的客户才被过滤/灰显（真正已删除的备份）
  function applyFlagsAndFilter(contacts, includeArchived, liveSet) {
    if (!Array.isArray(contacts) || !contacts.length) return contacts;
    var ids = contacts.map(function(c) { return c.contactId; }).filter(Boolean);
    var flags = {};
    if (store && typeof store.getContactFlags === 'function') {
      var m = store.getContactFlags(ids);
      m.forEach(function(v, k) { flags[k] = v; });
    }
    var out = contacts.map(function(c) {
      var f = flags[c.contactId] || { archived: 0, blacklisted: 0 };
      var a = f.archived, b = f.blacklisted;
      // 真实窗口还在 = 未删除，强制清 0（DB 旧标志是历史残留，不可信）
      if (liveSet && liveSet.has(c.contactId)) { a = 0; b = 0; }
      return Object.assign({}, c, { archived: a, blacklisted: b });
    });
    if (includeArchived) return out;
    return out.filter(function(c) { return !c.archived && !c.blacklisted; });
  }

  register('GET', '/api/console/mailbox', wrap(async (req, res) => {
    const qs0 = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const force = qs0.get('force') === '1';
    const includeArchived = qs0.get('includeArchived') === '1';
    if (!deepScrape || typeof deepScrape.mailboxOnly !== 'function') {
      // 降级：直接读缓存
      if (ichigoCache) return json(res, 200, { ok: true, from: 'cache-only', contacts: applyFlagsAndFilter(ichigoCache.getContacts().map(enrichContact), includeArchived, null), unread: ichigoCache.unreadTotal() });
      return json(res, 501, { ok: false, msg: 'deepScrape 未注入' });
    }
    if (!force && ichigoCache) {
      const cs = ichigoCache.getContacts();
      const newest = cs.reduce((acc, c) => {
        const t = c.lastSeen ? new Date(c.lastSeen).getTime() : 0;
        return t > acc ? t : acc;
      }, 0);
      // 缓存 90s 内直接用（避免重复打 CDP）
      if (cs.length && Date.now() - newest < 90 * 1000) {
        var cacheLiveSet = new Set(cs.map(function(x) { return x.contactId; }).filter(Boolean));
        return json(res, 200, { ok: true, from: 'cache', contacts: applyFlagsAndFilter(cs.map(enrichContact), includeArchived, cacheLiveSet), unread: ichigoCache.unreadTotal(), cached: true });
      }
    }
    const scan = await deepScrape.mailboxOnly();
    if (!scan.ok) {
      // 抓取失败：返回缓存，不让前端丢数据
      if (ichigoCache) return json(res, 200, { ok: true, from: 'cache-fallback', contacts: applyFlagsAndFilter(ichigoCache.getContacts().map(enrichContact), includeArchived, null), unread: ichigoCache.unreadTotal(), scanReason: scan.reason });
      return json(res, 200, { ok: false, reason: scan.reason, msg: scan.msg });
    }
    let up = { changed: [] };
    if (ichigoCache) up = ichigoCache.upsertMailbox(scan.contacts);
    // 模块1 · 自动归档：cache 里有但真实窗口本次没抓到的客户 → 自动 archived=1
    let autoArchived = 0;
    var liveIdsSet = new Set((scan.contacts || []).map(function(c) { return c.contactId; }).filter(Boolean));
    if (ichigoCache && store && typeof store.batchSetContactFlag === 'function') {
      var staleContacts = ichigoCache.getContacts().filter(function(c) {
        return c.contactId && !liveIdsSet.has(c.contactId);
      });
      if (staleContacts.length) {
        var staleIds = staleContacts.map(function(c) { return c.contactId; });
        var flags = store.getContactFlags(staleIds);
        var toArchive = staleIds.filter(function(id) { var f = flags.get(id); return !f || !f.archived; });
        if (toArchive.length) { var archRes = store.batchSetContactFlag(toArchive, 'archived'); autoArchived = archRes.updated; }
      }
    }
    const cs = ichigoCache ? ichigoCache.getContacts() : scan.contacts;
    var enriched = applyFlagsAndFilter(cs.map(enrichContact), includeArchived, liveIdsSet);
    enriched.forEach(function(c) { c.inLiveInbox = liveIdsSet.has(c.contactId); });
    return json(res, 200, {
      ok: true, from: 'live', contacts: enriched,
      unread: ichigoCache ? ichigoCache.unreadTotal() : 0, changed: up.changed,
      autoArchived: autoArchived, liveCount: liveIdsSet.size,
      scannedAt: scan.fetchedAt, pages: scan.pages
    });
  }));

  // GET /api/console/live/customers → 全量客户（缓存快照）
    // ---------------------------------------------------------------- 
  // H4 · 快乐平台（happymail.co.jp / 18595）只读端点（独立不碰出会 mailbox）
  // ---------------------------------------------------------------- 出会批量操作（模块 1）
  // POST /api/console/batch
  //   body: { action: 'archive'|'blacklist'|'restore', contactIds: string[] }
  //   语义：归档/拉黑 = Contact 表对应标志置 1；恢复 = 置 0。不物理删除。
  //   返回: { ok, action, updated, ids, detail? }
  register('POST', '/api/console/batch', wrap(async (req, res, body) => {
    if (!store || typeof store.batchSetContactFlag !== 'function') {
      return json(res, 501, { ok: false, msg: 'store 未注入，批量操作不可用' });
    }
    const action = body && body.action;
    const ids = body && Array.isArray(body.contactIds) ? body.contactIds.map(String).filter(Boolean) : [];
    if (!ids.length) return json(res, 200, { ok: true, action: action, updated: 0, ids: [], msg: '无选中客户' });
    // 去重
    const uniq = Array.from(new Set(ids));
    switch (action) {
      case 'archive':
      case 'blacklist': {
        const realFlag = (action === 'archive') ? 'archived' : 'blacklisted';
        const r = store.batchSetContactFlag(uniq, realFlag);
        // 模块1 · 拉黑/归档联动真实窗口（CDP）：
        //   * blacklist → 逐个调 deepScrape.blockContact(historyUrl) 触发真实拉黑
        //   * archive   → 仅 DB 打标（归档是本地操作，不触发平台动作）
        //   * CDP 不可用/按钮未找到 → queued 提示（"已排入真实拉黑队列/待同步到窗口"），不当成假拉黑
        let realSync = { queued: 0, blocked: 0, failed: 0, detail: [] };
        if (action === 'blacklist' && deepScrape && typeof deepScrape.blockContact === 'function') {
          // 模块1整改 · 真实 3 步 RPA：收件箱页「編集」→ 勾客户 checkboxN →「チェックを削除する」
          // 按客户名定位 checkbox（Step2 需要 customerName）
          for (const id of uniq) {
            const c = ichigoCache ? ichigoCache.getContact(id) : null;
            const custName = c ? (c.name || c.displayName || '') : '';
            if (!c) {
              realSync.queued += 1;
              realSync.detail.push({ contactId: id, status: 'queued', note: '客户缓存缺失，待窗口重新抓取后同步删除' });
              continue;
            }
            try {
              const br = await deepScrape.blockContact(custName, { refreshMailbox: true });
              if (br && br.ok) {
                realSync.blocked += 1;
                realSync.detail.push({ contactId: id, status: 'blocked', matched: br.matched, checkboxIndex: br.checkboxIndex, note: br.note });
              } else {
                realSync.queued += 1;
                realSync.detail.push({ contactId: id, status: 'queued', reason: br ? br.reason : 'cdp-unavailable', note: br ? (br.note || br.msg || '删除未触发') : 'CDP 不可用，待窗口打开后同步' });
              }
            } catch (e) {
              realSync.failed += 1;
              realSync.detail.push({ contactId: id, status: 'failed', note: String((e && e.message) || e) });
            }
          }
          // 真·自动同步：任一真实删除成功 → 强制重抓收件箱（刷新前端+DB+真实窗口三方）
          if (realSync.blocked > 0) {
            try {
              await deepScrape.mailboxOnly({ allPages: false, maxPages: 1 });
              if (ichigoCache) ichigoCache.saveNow();
              realSync.mailboxRefreshed = true;
            } catch (_) { realSync.mailboxRefreshed = false; }
          }
        } else if (action === 'blacklist') {
          // CDP 不可用 → 全部 queued
          realSync.queued = uniq.length;
          realSync.detail = uniq.map((id) => ({ contactId: id, status: 'queued', note: 'CDP 未注入，删除待同步到窗口' }));
        }
        return json(res, 200, {
          ok: true, action: action, flag: realFlag,
          updated: r.updated, ids: r.ids,
          realSync: realSync,
          note: (action === 'blacklist')
            ? (realSync.blocked > 0
                ? ('已在真实窗口删除 ' + realSync.blocked + ' 位' + (realSync.queued > 0 ? '，另有 ' + realSync.queued + ' 位待同步' : '') + '，收件箱已强制重抓同步')
                : (realSync.queued > 0 ? ('已排入真实删除队列（' + realSync.queued + ' 位待同步到窗口）；DB 已打标') : '已拉黑'))
            : '已归档',
        });
      }
      case 'restore': {
        // 恢复 = 同时清 archived + blacklisted
        const r1 = store.batchClearContactFlag(uniq, 'archived');
        const r2 = store.batchClearContactFlag(uniq, 'blacklisted');
        return json(res, 200, { ok: true, action: 'restore', updated: r1.updated + r2.updated, ids: uniq });
      }
      default:
        return json(res, 400, { ok: false, msg: 'action 必须是 archive|blacklist|restore' });
    }
  }));

  // GET /api/console/happy/inbox?force=1&more=1&expand=1
  //   缓存优先（5min 新鲜直接回 cached:true）→ 过期/force 真连 CDP → 成功后回写缓存；
  //   expand=1 时循环点「もっと見る」直到无按钮/不再增长/达 30 位上限（C 自动加载更多）；
  //   窗口未开/CDP 失败 → 降级回缓存（stale 标记），不回空。
  // GET /api/console/happy/inbox/customer?id={memberID}&mailID={mailID}
  //   按 memberID 键缓存 profile+messages（TTL 5min），无缓存/force 才真连拉。
  // GET /api/console/happy/inbox/brief
  //   从缓存取最近 1 个 messages>0 的客户 → 返回其 profile+messages（B 客户详情自动获取）；
  //   全客户无 messages → { ok:true, empty:true }。

  register('GET', '/api/console/happy/inbox', wrap(async (req, res) => {
    const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const force = qs.get('force') === '1';
    const more = qs.get('more') === '1'; // H4 缺陷②：more=1 点一次「もっと見る」
    const expand = qs.get('expand') === '1'; // H4 缺陷6 · C：expand=1 循环点「もっと見る」到全量
    if (!happyScanner || typeof happyScanner.scanInbox !== 'function') {
      // 端点 501 降级（scanner 未注入）；若 happyCache 有旧数据则 stale 降级回缓存
      if (happyCache) {
        const cached = happyCache.getInbox({ stale: true });
        if (cached) return json(res, 200, Object.assign({ ok: false, reason: 'happyScanner-not-injected', from: 'cache-stale', cached: !!cached.cached }, cached));
      }
      return json(res, 501, { ok: false, reason: 'happyScanner-not-injected', msg: '快乐抓取器未注入，暂无法加载快乐数据' });
    }
    // C 自动加载更多：expand=true 时把 more 升级成「循环点」语义（scanInbox 内部循环）
    try {
      const wantMore = expand ? true : more;
      const scan = await happyScanner.scanInbox(wantMore, { expand: !!expand });
      if (scan.ok) {
        // A 持久化：成功 → 回写缓存
        if (happyCache) happyCache.upsertInbox(scan);
        return json(res, 200, scan);
      }
      // 抓取失败：降级回缓存（stale 标记），不回空
      if (happyCache) {
        const cached = happyCache.getInbox({ stale: true });
        if (cached) return json(res, 200, Object.assign({ ok: true, from: 'cache-fallback', scanReason: scan.reason, cached: !!cached.cached, stale: true }, cached));
      }
      return json(res, 501, Object.assign({ ok: false }, scan));
    } catch (e) {
      if (happyCache) {
        const cached = happyCache.getInbox({ stale: true });
        if (cached) return json(res, 200, Object.assign({ ok: false, from: 'cache-exception', reason: 'scan-exception', msg: String(e && e.message || e), cached: !!cached.cached, stale: true }, cached));
      }
      return json(res, 501, { ok: false, reason: 'happy-scan-exception', msg: String(e && e.message || e) });
    }
  }));

  register('GET', '/api/console/happy/inbox/customer', wrap(async (req, res) => {
    const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const memberID = qs.get('id') || '';
    const mailID = qs.get('mailID') || '';
    const force = qs.get('force') === '1';
    if (!happyScanner || typeof happyScanner.scanCustomer !== 'function') {
      // 端点 501；有缓存则 stale 降级
      if (happyCache && memberID) {
        const cached = happyCache.getCustomer(memberID, { stale: true });
        if (cached) return json(res, 200, Object.assign({ ok: false, reason: 'happyScanner-not-injected', from: 'cache-stale', memberID }, cached, { cached: !!cached.cached, stale: true }));
      }
      return json(res, 501, { ok: false, reason: 'happyScanner-not-injected', msg: '快乐抓取器未注入，暂无法加载客户详情' });
    }
    if (!memberID) {
      return json(res, 400, { ok: false, reason: 'missing-memberID', msg: '缺少 id（memberID）查询参数' });
    }
    // B/A：先读缓存（非 force + 新鲜直接回）
    if (!force && happyCache) {
      const cached = happyCache.getCustomer(memberID, {});
      if (cached) return json(res, 200, Object.assign({ ok: true, from: 'cache', memberID, contact: cached.profile ? { tid: cached.memberID, name: (cached.profile.fields && cached.profile.fields.name) || '' } : null, profile: cached.profile, messages: cached.messages, mailID: cached.mailID || mailID }, { cached: cached.cached, scannedAt: cached.fetchedAt }));
    }
    try {
      const r = await happyScanner.scanCustomer(memberID, mailID);
      if (r.ok) {
        if (happyCache) happyCache.upsertCustomer(memberID, r.profile, r.messages, r.mailID || mailID);
        return json(res, 200, r);
      }
      // 抓取失败：降级回缓存
      if (happyCache) {
        const cached = happyCache.getCustomer(memberID, { stale: true });
        if (cached) return json(res, 200, Object.assign({ ok: false, from: 'cache-fallback', scanReason: r.reason, memberID, contact: null, profile: cached.profile, messages: cached.messages, mailID: cached.mailID || mailID }, { stale: true }));
      }
      return json(res, 501, Object.assign({ ok: false }, r));
    } catch (e) {
      if (happyCache) {
        const cached = happyCache.getCustomer(memberID, { stale: true });
        if (cached) return json(res, 200, Object.assign({ ok: false, from: 'cache-exception', reason: 'scan-exception', memberID, profile: cached.profile, messages: cached.messages }, { stale: true }));
      }
      return json(res, 501, { ok: false, reason: 'happy-customer-scan-exception', msg: String(e && e.message || e) });
    }
  }));

  // H4 缺陷 6 · B 客户详情自动获取：/brief 从缓存取最近 1 个 messages>0 的客户
  register('GET', '/api/console/happy/inbox/brief', wrap(async (req, res) => {
    // H4 缺陷6 · B 增强：缓存里 messages 全空但 happyScanner 在 → 真连拉「收件箱首条有 lastMessage 客户」的 history（只读），回写缓存
    if (happyCache && happyScanner && typeof happyScanner.scanInbox === 'function') {
      const cachedBrief = happyCache.getBrief();
      if (!cachedBrief && !happyCache.hasAnyWithMessages()) {
        // 缓存无有 messages 的客户 → 真连拉 1 个（取收件箱首条有 mailID 的客户 navigate 会话页抽 history）
        try {
          const scan = await happyScanner.scanInbox(false);
          if (scan.ok && Array.isArray(scan.contacts)) {
            const target = scan.contacts.find(function(c) { return c && c.mailID && c.lastMessage; }) || (scan.contacts[0] || null);
            if (target && target.mailID) {
              const cust = await happyScanner.scanCustomer(target.memberID, target.mailID);
              if (cust.ok) {
                happyCache.upsertCustomer(target.memberID, cust.profile, cust.messages, target.mailID);
                return json(res, 200, {
                  ok: true, empty: !(Array.isArray(cust.messages) && cust.messages.length), from: 'live-brief',
                  memberID: target.memberID,
                  contact: cust.contact || { tid: target.memberID, name: target.name || '' },
                  profile: cust.profile,
                  messages: cust.messages || [],
                  mailID: target.mailID,
                });
              }
            }
          }
        } catch (e) {
          // 真连拉 brief 失败 → 降级缓存（可能全空）
        }
      }
    }
    if (!happyCache) {
      // 无缓存层：直接真连（退化为旧行为）
      if (happyScanner && typeof happyScanner.scanInbox === 'function') {
        try {
          const scan = await happyScanner.scanInbox(false);
          if (scan.ok) {
            const withMsg = (scan.contacts || []).filter(function(c) { return c && c.mailID; });
            if (withMsg.length) {
              const first = withMsg[0];
              const cust = await happyScanner.scanCustomer(first.memberID, first.mailID);
              return json(res, 200, { ok: true, memberID: first.memberID, contact: cust.contact, profile: cust.profile, messages: cust.messages, mailID: first.mailID, empty: false, from: 'live' });
            }
          }
          return json(res, 200, { ok: true, empty: true, from: 'live' });
        } catch (e) {
          return json(res, 501, { ok: false, reason: 'brief-scan-exception', msg: String(e && e.message || e) });
        }
      }
      return json(res, 501, { ok: false, reason: 'no-cache-no-scanner', msg: 'happyCache/happyScanner 均未注入' });
    }
    // 有缓存：取最近 1 个 messages>0 的客户（不真连 CDP）
    const brief = happyCache.getBrief();
    if (brief) {
      return json(res, 200, {
        ok: true, empty: false, from: 'cache',
        memberID: brief.memberID,
        contact: brief.profile ? { tid: brief.memberID, name: (brief.profile.fields && brief.profile.fields.name) || '' } : null,
        profile: brief.profile,
        messages: brief.messages,
        mailID: brief.mailID,
        scannedAt: brief.fetchedAt,
      });
    }
    // 全客户无 messages → 缓存里看收件箱是否有客户（提示占位）
    const inbox = happyCache.getInbox({});
    if (inbox && Array.isArray(inbox.contacts) && inbox.contacts.length) {
      return json(res, 200, { ok: true, empty: true, from: 'cache', note: '收件箱 ' + inbox.contacts.length + ' 位客户均暂无历史消息（可切收件箱选客户拉取）', contactsCount: inbox.contacts.length });
    }
    return json(res, 200, { ok: true, empty: true, from: 'cache', note: '暂无客户数据' });
  }));

    register('GET', '/api/console/live/customers', wrap(async (req, res) => {
    if (!ichigoCache) return json(res, 501, { ok: false, msg: 'ichigoCache 未注入' });
    return json(res, 200, { ok: true, contacts: ichigoCache.getContacts().map(enrichContact), stats: ichigoCache.stats() });
  }));

  // GET /api/console/live/customer?id=xxx → 单客户详情（缓存优先；缺则按需抓历史/资料）
  register('GET', '/api/console/live/customer', wrap(async (req, res) => {
    if (!ichigoCache) return json(res, 501, { ok: false, msg: 'ichigoCache 未注入' });
    const qs1 = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const id = decodeURIComponent(String(qs1.get('id') || ''));
    const wantMsg = qs1.get('messages') !== '0';
    const wantProf = qs1.get('profile') !== '0';
    const forceMsg = qs1.get('force') === '1';   // 发送成功后强制重抓历史（绕过新鲜度判断）
    let c = ichigoCache.getContact(id);
    if (!c) {
      // 尝试按姓名找
      const byName = ichigoCache.getContacts().find(x => x.name === id);
      c = byName || null;
    }
    if (!c) return json(res, 404, { ok: false, msg: '客户不存在（先调 /api/console/mailbox 建立快照）' });

    const fetched = [];
    // 按需抓历史（页面内 fetch，零导航）
    if (wantMsg && c.historyUrl && deepScrape && typeof deepScrape.fetchHistory === 'function' && (forceMsg || ichigoCache.needsMessages(c.contactId))) {
      const h = await deepScrape.fetchHistory(c.historyUrl);
      if (h && h.ok) {
        ichigoCache.setMessages(c.contactId, h.messages || [], { avatarUrl: h.avatarUrl, avatarIsDefault: h.avatarIsDefault, historyUrl: c.historyUrl });
        if (h.profileUrl && !c.profileUrl) {
          const cc = ichigoCache.getContact(c.contactId); if (cc) cc.profileUrl = h.profileUrl;
        }
        fetched.push('messages');
      }
    }
    // 按需抓资料（永久缓存，30 天）
    if (wantProf && c.profileUrl && deepScrape && typeof deepScrape.fetchProfile === 'function' && ichigoCache.needsProfile(c.contactId, 30)) {
      const pr = await deepScrape.fetchProfile(c.profileUrl);
      if (pr && pr.ok) { ichigoCache.setProfile(c.contactId, pr); fetched.push('profile'); }
    }
    // 已读
    if (qs1.get('read') === '1') ichigoCache.markRead(c.contactId);
    ichigoCache.saveNow();
    c = enrichContact(ichigoCache.getContact(c.contactId));
    return json(res, 200, { ok: true, contact: c, fetched, source: 'cache' });
  }));

  // POST /api/console/live/customer/read?id=xxx → 标记已读
  register('POST', '/api/console/live/customer/read', wrap(async (req, res) => {
    if (!ichigoCache) return json(res, 501, { ok: false, msg: 'ichigoCache 未注入' });
    const qsr = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const id = decodeURIComponent(String(qsr.get('id') || ''));
    ichigoCache.markRead(id);
    return json(res, 200, { ok: true, unread: ichigoCache.unreadTotal() });
  }));

  // POST /api/console/live/customer/refresh?id=xxx → 强制重抓历史+资料
  register('POST', '/api/console/live/customer/refresh', wrap(async (req, res) => {
    if (!ichigoCache) return json(res, 501, { ok: false, msg: 'ichigoCache 未注入' });
    const qsf = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const id = decodeURIComponent(String(qsf.get('id') || ''));
    const c = ichigoCache.getContact(id);
    if (!c) return json(res, 404, { ok: false, msg: '客户不存在' });
    const out = { ok: true, fetched: [] };
    if (c.historyUrl && deepScrape && deepScrape.fetchHistory) {
      const h = await deepScrape.fetchHistory(c.historyUrl);
      out.historyResult = h ? { ok: h.ok, reason: h.reason, msg: h.msg, err: h.err, count: (h.messages || []).length, url: h.url } : null;
      if (h && h.ok) {
        ichigoCache.setMessages(c.contactId, h.messages || [], { avatarUrl: h.avatarUrl, avatarIsDefault: h.avatarIsDefault, historyUrl: c.historyUrl });
        out.fetched.push('messages');
        const pUrl = h.profileUrl || c.profileUrl;
        if (pUrl) {
          const cc = ichigoCache.getContact(c.contactId);
          if (cc && !cc.profileUrl) cc.profileUrl = pUrl;
          const pr = await deepScrape.fetchProfile(pUrl);
          out.profileResult = pr ? { ok: pr.ok, reason: pr.reason, msg: pr.err || pr.msg, fieldCount: pr.fields ? Object.keys(pr.fields).length : 0 } : null;
          if (pr && pr.ok) { ichigoCache.setProfile(c.contactId, pr); out.fetched.push('profile'); }
        } else {
          out.profileResult = { ok: false, reason: 'no-profile-url' };
        }
      }
    } else {
      out.historyResult = { ok: false, reason: !c.historyUrl ? 'no-history-url' : 'no-fetchHistory' };
    }
    ichigoCache.saveNow();
    return json(res, 200, Object.assign(out, { contact: enrichContact(ichigoCache.getContact(c.contactId)) }));
  }));

  register('GET', '/api/console/live/deep', wrap(async (req, res) => {
    if (!deepScrape || typeof deepScrape.deepScrape !== 'function') {
      return json(res, 501, { ok: false, msg: 'deepScrape 未注入，无法深度抓出会窗口' });
    }
    try {
      const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
      const maxContacts = parseInt(qs.get('maxContacts') || '3', 10);
      const result = await deepScrape.deepScrape({
        maxContacts,
        withHistory: qs.get('history') !== '0',
        withProfile: qs.get('profile') !== '0',
        concurrency: parseInt(qs.get('concurrency') || '4', 10),
      });
      // 写入缓存（收件箱快照 + 历史 + 资料）
      if (result && result.ok && ichigoCache) {
        ichigoCache.upsertMailbox(result.contacts || []);
        (result.contacts || []).forEach(function(c) {
          if (!c.contactId) return;
          if (Array.isArray(c.messages) && c.messages.length) {
            ichigoCache.setMessages(c.contactId, c.messages, { avatarUrl: c.avatarUrl, avatarIsDefault: c.avatarIsDefault, historyUrl: c.historyUrl });
          }
          if (c.profile) ichigoCache.setProfile(c.contactId, c.profile);
          if (c.profileUrl) { const cc = ichigoCache.getContact(c.contactId); if (cc && !cc.profileUrl) cc.profileUrl = c.profileUrl; }
        });
        ichigoCache.saveNow();   // 深抓后立即落盘（不等防抖）
        result.cached = ichigoCache.stats();
      }
      json(res, 200, result);
    } catch (e) {
      json(res, 200, { ok: false, reason: 'deep-scan-exception', msg: String(e && e.message || e) });
    }
  }));

  // ---------------- 翻译端点（基于模型，兜底词典） ----------------
  // GET /api/console/translate?text=xxx&from=ja&to=zh-CN
  register('GET', '/api/console/translate', wrap(async (req, res) => {
    const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const text = String(qs.get('text') || '');
    const from = String(qs.get('from') || 'ja');
    const to = String(qs.get('to') || 'zh-CN');
    // 模块2 · 大模型管道预留：context / personaId（现阶段 deep_translator 透传，后续接本地 LLM 角色扮演翻译）
    const context = String(qs.get('context') || '');
    const personaId = String(qs.get('personaId') || '');
    if (!text) return json(res, 400, { ok: false, msg: '缺少 text 参数' });
    const activeCfg = modelStore ? modelStore.getUsableActive() : null;
    const settings = deps.settings || {};
    const modelCfg = activeCfg || settings.model || settings.llm || null;
    const modelConfigured = !!(modelCfg && modelCfg.apiKey && modelCfg.baseUrl);
    // ① 命中缓存直接返回（切回不用重翻）
    if (translationCache) {
      const hit = translationCache.get(text, from, to, modelConfigured);
      if (hit) return json(res, 200, { ok: true, source: hit.source, model: hit.model, translated: hit.translated, cached: true, context: context, personaId: personaId });
    }
    // ①' 模块2 · 免密钥 deep_translator 优先（替换易超时的 LLM 节点；模型未配置或 LLM 失败时走这里）
    if (!modelConfigured) {
      try {
        const dt = await callDeepTranslator([{ text: text, from: from, to: to, context: context, personaId: personaId }], 8000);
        if (dt.ok && dt.results && dt.results[text]) {
          const r = dt.results[text];
          if (r.ok && r.translated) {
            if (translationCache) translationCache.set(text, from, to, { translated: r.translated, source: r.source || 'google-free' });
            return json(res, 200, { ok: true, source: r.source || 'google-free', model: 'deep-translator', translated: r.translated, context: context, personaId: personaId });
          }
        }
      } catch (e) { /* deep_translator 不可用 → 落词典兜底 */ }
    }
    // ② 模型翻译
    if (modelConfigured) {
      try {
        const out = await callModel(modelCfg, text, from, to);
        if (translationCache) translationCache.set(text, from, to, { translated: out, source: 'model', model: modelCfg.model || null });
        return json(res, 200, { ok: true, source: 'model', model: modelCfg.model || 'unknown', translated: out });
      } catch (e) { /* 模型失败 → 词典兜底 */ }
    }
    // ③ 词典兜底
    const translated = dictFallback(text);
    if (translationCache) translationCache.set(text, from, to, { translated: translated, source: 'dict-fallback', model: null });
    return json(res, 200, { ok: true, source: 'dict-fallback', model: null, translated: translated, note: '模型未配置/不可用，使用内置词典近似翻译' });
  }));

  // POST /api/console/translate/batch { items: [{ text, from, to }] } → { results: { text: {translated, source, cached} }, stats }
  register('POST', '/api/console/translate/batch', wrap(async (req, res, body) => {
    const items = (body && body.items) || [];
    const activeCfg = modelStore ? modelStore.getUsableActive() : null;
    const settings = deps.settings || {};
    const modelCfg = activeCfg || settings.model || settings.llm || null;
    const modelConfigured = !!(modelCfg && modelCfg.apiKey && modelCfg.baseUrl);
    const results = {};
    let cacheHits = 0, translatedCount = 0;

    // 去重
    const uniq = [];
    const seen = {};
    items.forEach(function(it) {
      const t = String((it && it.text) || '');
      if (!t || seen[t]) return;
      seen[t] = true;
      uniq.push({ text: t, from: (it.from || 'ja'), to: (it.to || 'zh-CN') });
    });

    // ① 缓存命中
    const miss = [];
    uniq.forEach(function(it) {
      const hit = translationCache ? translationCache.get(it.text, it.from, it.to, modelConfigured) : null;
      if (hit) {
        results[it.text] = { ok: true, translated: hit.translated, source: hit.source, model: hit.model, cached: true };
        cacheHits++;
      } else miss.push(it);
    });

    // ② 未命中：模型（并发 6）或词典
    const limit = 6;
    let idx2 = 0;
    async function worker() {
      while (idx2 < miss.length) {
        const it = miss[idx2++];
        try {
          if (modelConfigured) {
            const out = await callModel(modelCfg, it.text, it.from, it.to);
            results[it.text] = { ok: true, translated: out, source: 'model', model: modelCfg.model || null };
            if (translationCache) translationCache.set(it.text, it.from, it.to, { translated: out, source: 'model', model: modelCfg.model || null });
          } else {
            const out = dictFallback(it.text);
            results[it.text] = { ok: true, translated: out, source: 'dict-fallback', model: null };
            if (translationCache) translationCache.set(it.text, it.from, it.to, { translated: out, source: 'dict-fallback', model: null });
          }
          translatedCount++;
        } catch (e) {
          const out = dictFallback(it.text);
          results[it.text] = { ok: true, translated: out, source: 'dict-fallback', model: null, modelError: String(e && e.message || e) };
          translatedCount++;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, miss.length)) }, worker));
    if (translationCache) { try { translationCache.saveNow(); } catch (_) {} }
    return json(res, 200, { ok: true, results, cacheHits, translated: translatedCount, total: uniq.length });
  }));

  // GET /api/console/model-status → { configured, model, baseUrl, provider }
  register('GET', '/api/console/model-status', wrap(async (req, res) => {
    const active = modelStore ? modelStore.getActive() : null;
    const settings = deps.settings || {};
    const modelCfg = active || settings.model || settings.llm || null;
    const configured = !!(modelCfg && modelCfg.apiKey && modelCfg.baseUrl);
    return json(res, 200, {
      ok: true, configured,
      id: (active && active.id) || null,
      name: (active && active.name) || null,
      model: (modelCfg && modelCfg.model) || null,
      baseUrl: (modelCfg && modelCfg.baseUrl) || null,
      provider: (modelCfg && modelCfg.provider) || null
    });
  }));

  // ---------------- 账号信息 + 常用语 API ----------------

  // 当前窗口的账号信息（自动探测 + 用户覆盖）
  function currentAccountCtx() {
    const settings = deps.settings || {};
    const grp = (settings.platformGroups && settings.platformGroups[0]) || {};
    const windowId = (grp.windows && grp.windows[0]) || settings.windowId || '';
    const base = { windowLabel: '', windowId: windowId, platformName: grp.name || '', override: null };
    // 两段式：先解析出账号标签（如 17098），再按标签取用户覆盖值
    if (!accountInfo) return base;
    const first = accountInfo.resolve(base);
    const label = String(first.window || settings.windowSeq || '');
    base.windowLabel = label;
    base.override = (consolePrefs && label) ? consolePrefs.getAccountOverride(label) : null;
    return base;
  }

  // GET /api/console/account → 账号信息
  register('GET', '/api/console/account', wrap(async (req, res) => {
    if (!accountInfo) return json(res, 501, { ok: false, msg: 'accountInfo 未注入' });
    const info = accountInfo.resolve(currentAccountCtx());
    // 附上已缓存的账号资料卡（来自 snsmypage/show_profile.html）
    const card = consolePrefs ? consolePrefs.getAccountProfile(info.window) : null;
    if (card) {
      info.profileCard = card;
      info.profileCardFetchedAt = card.fetchedAt || null;
      if (card.nickname) info.nickname = card.nickname;
      if (card.ageNum) info.profile = (card.ageNum + '歳 ' + (card.pref || '')).trim();
    }
    return json(res, 200, { ok: true, account: info });
  }));

  // POST /api/console/account/refresh → 抓取账号自己的资料卡（snsmypage/show_profile.html）
  register('POST', '/api/console/account/refresh', wrap(async (req, res) => {
    if (!accountInfo || !deepScrape || typeof deepScrape.fetchAccountProfile !== 'function') {
      return json(res, 501, { ok: false, msg: '抓取能力未注入' });
    }
    const info = accountInfo.resolve(currentAccountCtx());
    let card = null, err = null;
    try {
      const r = await deepScrape.fetchAccountProfile();
      if (r && r.ok) {
        card = Object.assign({}, r, { fetchedAt: new Date().toISOString() });
        if (consolePrefs) consolePrefs.setAccountProfile(info.window, card);
      } else {
        err = (r && (r.err || r.msg || r.reason)) || '抓取失败';
      }
    } catch (e) { err = String(e && e.message || e); }
    const fresh = accountInfo.resolve(currentAccountCtx());
    if (card) {
      fresh.profileCard = card;
      fresh.profileCardFetchedAt = card.fetchedAt;
      if (card.nickname) fresh.nickname = card.nickname;
      if (card.ageNum) fresh.profile = (card.ageNum + '歳 ' + (card.pref || '')).trim();
    } else {
      const cached = consolePrefs ? consolePrefs.getAccountProfile(fresh.window) : null;
      if (cached) { fresh.profileCard = cached; fresh.profileCardFetchedAt = cached.fetchedAt; }
    }
    return json(res, 200, { ok: !!card, account: fresh, err: err });
  }));

  // POST /api/console/account/update { nicknameOverride?, profileOverride?, places? }
  register('POST', '/api/console/account/update', wrap(async (req, res, body) => {
    if (!consolePrefs || !accountInfo) return json(res, 501, { ok: false, msg: 'consolePrefs 未注入' });
    const ctx = currentAccountCtx();
    const b = body || {};
    const saved = consolePrefs.setAccountOverride(ctx.windowLabel, {
      nicknameOverride: b.nicknameOverride,
      profileOverride: b.profileOverride,
      places: b.places
    });
    const info = accountInfo.resolve(Object.assign({}, ctx, { override: saved }));
    return json(res, 200, { ok: true, account: info });
  }));

  // GET /api/console/phrases → 常用语列表 + 分组
  register('GET', '/api/console/phrases', wrap(async (req, res) => {
    if (!consolePrefs) return json(res, 501, { ok: false, msg: 'consolePrefs 未注入' });
    return json(res, 200, { ok: true, phrases: consolePrefs.listPhrases(), groups: consolePrefs.groups() });
  }));

  // POST /api/console/phrases/save { id?, group, text } → 新增或更新
  register('POST', '/api/console/phrases/save', wrap(async (req, res, body) => {
    if (!consolePrefs) return json(res, 501, { ok: false, msg: 'consolePrefs 未注入' });
    const b = body || {};
    if (!b.text || !String(b.text).trim()) return json(res, 400, { ok: false, msg: '内容不能为空' });
    const saved = b.id
      ? consolePrefs.updatePhrase(b.id, { group: b.group, text: b.text, order: b.order })
      : consolePrefs.createPhrase({ group: b.group, text: b.text });
    if (!saved) return json(res, 404, { ok: false, msg: '常用语不存在' });
    consolePrefs.saveNow();
    return json(res, 200, { ok: true, phrase: saved, phrases: consolePrefs.listPhrases(), groups: consolePrefs.groups() });
  }));

  // POST /api/console/phrases/delete?id=
  register('POST', '/api/console/phrases/delete', wrap(async (req, res) => {
    if (!consolePrefs) return json(res, 501, { ok: false, msg: 'consolePrefs 未注入' });
    const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const id = qs.get('id');
    if (!id) return json(res, 400, { ok: false, msg: '缺少 id' });
    const okDel = consolePrefs.deletePhrase(id);
    if (!okDel) return json(res, 404, { ok: false, msg: '常用语不存在' });
    return json(res, 200, { ok: true, phrases: consolePrefs.listPhrases(), groups: consolePrefs.groups() });
  }));

  // POST /api/console/phrases/use?id= → 记一次使用（用于排序/统计）
  register('POST', '/api/console/phrases/use', wrap(async (req, res) => {
    if (!consolePrefs) return json(res, 501, { ok: false, msg: 'consolePrefs 未注入' });
    const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const ph = consolePrefs.bumpUse(qs.get('id'));
    return json(res, 200, { ok: !!ph });
  }));

  // ---------------- 多模型管理 API ----------------

  // GET /api/console/translate/stats → 翻译缓存统计
  register('GET', '/api/console/translate/stats', wrap(async (req, res) => {
    if (!translationCache) return json(res, 200, { ok: true, enabled: false });
    return json(res, 200, { ok: true, enabled: true, stats: translationCache.stats() });
  }));

  // POST /api/console/translate/clear → 清空翻译缓存
  register('POST', '/api/console/translate/clear', wrap(async (req, res) => {
    if (translationCache) translationCache.clear();
    return json(res, 200, { ok: true });
  }));

  // GET /api/console/models → { models: [...], activeId }
  register('GET', '/api/console/models', wrap(async (req, res) => {
    if (!modelStore) return json(res, 501, { ok: false, msg: 'modelStore 未注入' });
    const l = modelStore.list();
    return json(res, 200, { ok: true, models: l.models, activeId: l.activeId });
  }));

  // POST /api/console/models/create { name, provider, baseUrl, model, apiKey }
  register('POST', '/api/console/models/create', wrap(async (req, res, body) => {
    if (!modelStore) return json(res, 501, { ok: false, msg: 'modelStore 未注入' });
    const b = body || {};
    if (!b.baseUrl) return json(res, 400, { ok: false, msg: '缺少 Base URL' });
    const created = modelStore.create(b);
    return json(res, 200, { ok: true, model: created });
  }));

  // POST /api/console/models/update?id=xxx { name, provider, baseUrl, model, apiKey }
  register('POST', '/api/console/models/update', wrap(async (req, res, body) => {
    if (!modelStore) return json(res, 501, { ok: false, msg: 'modelStore 未注入' });
    const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const id = qs.get('id');
    if (!id) return json(res, 400, { ok: false, msg: '缺少 id' });
    const updated = modelStore.update(id, body || {});
    if (!updated) return json(res, 404, { ok: false, msg: '模型不存在' });
    return json(res, 200, { ok: true, model: updated });
  }));

  // POST /api/console/models/delete?id=xxx
  register('POST', '/api/console/models/delete', wrap(async (req, res) => {
    if (!modelStore) return json(res, 501, { ok: false, msg: 'modelStore 未注入' });
    const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const id = qs.get('id');
    if (!id) return json(res, 400, { ok: false, msg: '缺少 id' });
    const okDel = modelStore.remove(id);
    if (!okDel) return json(res, 404, { ok: false, msg: '模型不存在' });
    const l = modelStore.list();
    return json(res, 200, { ok: true, models: l.models, activeId: l.activeId });
  }));

  // POST /api/console/models/activate?id=xxx  → 设为当前项目使用
  register('POST', '/api/console/models/activate', wrap(async (req, res) => {
    if (!modelStore) return json(res, 501, { ok: false, msg: 'modelStore 未注入' });
    const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const id = qs.get('id');
    if (!id) return json(res, 400, { ok: false, msg: '缺少 id' });
    const act = modelStore.activate(id);
    if (!act) return json(res, 404, { ok: false, msg: '模型不存在' });
    // 同步进程内 settingsForLive（翻译立即生效）
    if (deps.settingsForLive) deps.settingsForLive.model = { provider: act.provider, baseUrl: act.baseUrl, model: act.model, apiKey: (modelStore.get(id) || {}).apiKey };
    return json(res, 200, { ok: true, model: act });
  }));

  // POST /api/console/models/test?id=xxx  或  POST body 直接给未保存配置
  register('POST', '/api/console/models/test', wrap(async (req, res, body) => {
    if (!modelStore) return json(res, 501, { ok: false, msg: 'modelStore 未注入' });
    const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const id = qs.get('id');
    const b = body || {};
    let result;
    if (id) {
      const override = {};
      if (b.baseUrl) override.baseUrl = b.baseUrl;
      if (b.model) override.model = b.model;
      if (b.apiKey) override.apiKey = b.apiKey;
      result = await modelStore.testById(id, override);
    } else {
      result = await modelStore.test(b);
    }
    return json(res, 200, result);
  }));

  // POST /api/console/model-config { provider, baseUrl, model, apiKey } → 写 settings.json model 字段
  register('POST', '/api/console/model-config', wrap(async (req, res, body) => {
    const cfg = body || {};
    // 允许保存任意配置（apiKey 空也能存，model-status 显示未接通；不阻塞保存）
    const settingsPath = require('path').join(__dirname, '..', 'settings.json');
    const raw = JSON.parse(require('fs').readFileSync(settingsPath, 'utf8'));
    raw.model = {
      provider: cfg.provider || 'deepseek',
      baseUrl: cfg.baseUrl || 'https://api.deepseek.com/v1',
      model: cfg.model || 'deepseek-chat',
      apiKey: String(cfg.apiKey),
    };
    require('fs').writeFileSync(settingsPath, JSON.stringify(raw, null, 2), 'utf8');
    // 同步更新进程内 settingsForLive（让翻译立即生效，不用重启）
    const settingsForLive = deps.settingsForLive || deps.settings;
    if (settingsForLive) {
      settingsForLive.model = raw.model;
    }
    return json(res, 200, { ok: true, msg: '模型配置已写入 settings.json', model: raw.model.model });
  }));

  // ---------------------------------------------------------------- 8a) 账号列表（多账号切换顶栏）
  // GET /api/console/accounts → [{ accountId, platform, label, status, active, windowCount, conversationCount }]
  register('GET', '/api/console/accounts', wrap(async (req, res) => {
    if (!db) return json(res, 501, { ok: false, msg: 'store.db 未注入' });
    let accounts;
    try {
      accounts = db.prepare(
        'SELECT a.accountId, a.platform, a.label, a.status, a.legacyKey, ' +
        '(SELECT COUNT(*) FROM WindowInstance w WHERE w.accountId = a.accountId) AS windowCount, ' +
        '(SELECT COUNT(*) FROM Conversation c WHERE c.accountId = a.accountId) AS conversationCount ' +
        'FROM Account a ORDER BY a.platform, a.label'
      ).all();
    } catch (e) { return json(res, 500, { ok: false, msg: e.message }); }
    json(res, 200, {
      ok: true,
      data: accounts.map((a) => ({
        accountId: a.accountId,
        platform: a.platform,
        label: a.label,
        status: a.status,
        active: a.status === 'active',
        windowCount: a.windowCount || 0,
        conversationCount: a.conversationCount || 0,
      })),
    });
  }));

  // ---------------------------------------------------------------- 8b) 平台列表（Phase 4 工单 H2 · 平台切换 UI 只读端点）
  // GET /api/console/platforms → { ok, platforms: [{ id, label, baseUrl }], active }
  // 纯只读：返回 adapters 注册表 + liveScanner 当前 adapterPlatform（H2 不切抓取，H3 才激活 kairaku）
  register('GET', '/api/console/platforms', wrap(async (req, res) => {
    if (!adapters || !liveScanner) return json(res, 501, { ok: false, msg: 'adapters 或 liveScanner 未注入' });
    const platformMeta = [
      { id: 'ichigo194964', label: '出会（ikuru）', baseUrl: 'sp.194964.com' },
      { id: 'kairaku', label: '快乐', baseUrl: 'happymail.co.jp' },
    ];
    let active = 'ichigo194964';
    try { active = (typeof liveScanner.getAdapterPlatform === 'function' ? liveScanner.getAdapterPlatform() : null) || 'ichigo194964'; } catch (e) { active = 'ichigo194964'; }
    json(res, 200, { ok: true, platforms: platformMeta, active: active });
  }));

  // ---------------------------------------------------------------- 9) likelySame 待确认队列（dedup.scanLikelySame）
  register('GET', '/api/console/likely-same', wrap(async (req, res) => {
    if (!dedup || typeof dedup.scanLikelySame !== 'function') {
      return json(res, 501, { ok: false, msg: 'dedup 未注入，无法列出 likelySame 队列' });
    }
    const q = queryOf(req);
    const limit = Math.min(Number(q.limit) || 50, 500);
    const items = dedup.scanLikelySame(limit);
    json(res, 200, { ok: true, data: items, total: items.length });
  }));

  // ---------------------------------------------------------------- 10) 一级菜单 · 私域管理（LINE/其他平台占位，只读）
  // 返回：{ line: { status, required[] }, others: [...] }
  //   - status：'pending'（待接入）| 'live'（已接入）——当前 M4 未接真实凭据，恒为 pending；
  //   - required：docs/plan/m4-handoff.md 的 3 项 LINE OA 凭据（channelAccessToken / channelSecret / webhookSecret）；
  //   - others：其他平台私域占位（FB / WhatsApp），后续可扩展。
  // 约束：只读端点，不改 M0 store / M3 lineOa。
  // ---------------------------------------------------------------- task-37：老板确认发送
  // POST /api/console/send-confirm { contactId, accountId?, text?, tier?, governanceRules? }
  //   老板在控制台点「确认发送」才调（话术只生成不自动发，保留合规闸门 + 频控）。
  //   - 无 text 时取 talkEngine 待确认队列里该客户最近一条未确认话术；
  //   - 经 checkGate（compliance/speechBoundary 红线）+ withinRateLimit（24h/1h/每分钟 cap）才真发；
  //   - 发送成功 ⇒ 写 LeadEvent(action='triggered', lineOffered=1) + sentLog(blocked=false)，标记该 pending 条目 confirmed=true；
  //   - 被闸门/频控拦 ⇒ 不发送，返回 reason，条目保持 pending（老板可改写后重发）。
  // 约束：不改 M0 schema；发送走 talkEngine.confirmSend（单一写入路径）。
  register('POST', '/api/console/send-confirm', wrap(async (req, res, body) => {
    if (!talkEngine || typeof talkEngine.confirmSend !== 'function') {
      return json(res, 501, { ok: false, msg: 'talkEngine.confirmSend 未注入，无法确认发送' });
    }
    const contactId = body && body.contactId ? String(body.contactId) : '';
    if (!contactId) return json(res, 400, { ok: false, msg: '缺少 contactId' });
    // 补默认 governanceRules（该客户 effective 规则，含 compliance/speechBoundary 红线）
    let governanceRules = (body && body.governanceRules) || null;
    if (!governanceRules && store && typeof store.getEffectiveRules === 'function') {
      try { governanceRules = store.getEffectiveRules({ contactId }) || { rules: [], denyByDefault: false }; } catch (_) { governanceRules = { rules: [], denyByDefault: false }; }
    }
    let result;
    try {
      result = talkEngine.confirmSend({
        contactId,
        accountId: body.accountId || undefined,
        text: body.text || undefined,
        tier: body.tier || 'warm',
        governanceRules,
      });
    } catch (e) { return json(res, 500, { ok: false, msg: e.message }); }
    json(res, 200, {
      ok: true,
      data: {
        sent: result.sent === true,
        pending: !result.sent,
        reason: result.reason || '',
        queueEntry: result.queueEntry ? {
          contactId: result.queueEntry.contactId,
          text: result.queueEntry.text,
          tier: result.queueEntry.tier,
          confirmed: result.queueEntry.confirmed === true,
          confirmedAt: result.queueEntry.confirmedAt || null,
          gateBlocked: result.queueEntry.gateBlocked === true,
          ts: result.queueEntry.ts,
        } : null,
        note: result.sent ? '已确认发送（经合规闸门 + 频控）' : '未发送：' + (result.reason || '未找到待确认话术'),
      },
    });
  }));

  // ---------------------------------------------------------------- Ai SAY 助手面板 B v1（单轮 + 工具调用）
  // POST /api/console/assistant { message, contactId?, history?, maxMsgs? }
  //   → { ok, degraded, reason, reply, actions:[{type,label,payload,sideEffect,needConfirm?}], contact, fetchedAt }
  //   只读/弱副作用动作直接给；强副作用（send_message）只出「需确认」卡片，前端点了才走 send-live。
  //   模型不可用 → degraded=true + 本地摘要（不删功能）。
  register('POST', '/api/console/assistant', wrap(async (req, res, body) => {
    if (!assistant) return json(res, 501, { ok: false, msg: 'assistant 未注入（Ai SAY 助手面板后端不可用）' });
    const r = await assistant.chat({
      message: body && body.message,
      contactId: body && body.contactId,
      history: Array.isArray(body && body.history) ? body.history : [],
      maxMsgs: body && body.maxMsgs ? Number(body.maxMsgs) : 12,
    });
    json(res, r && r.ok ? 200 : 400, r);
  }));
  // ---------------------------------------------------------------- IPDeep 代理池 v1（事件驱动，不定时轮换）
  // GET  /api/console/proxy/pool         池状态（槽位/使用/冷却/粘性/密码是否就绪）
  // POST /api/console/proxy/rotate       { windowId?, dryRun?, force? } 手动换 IP（30min 冷却，force 跳过）
  // POST /api/console/proxy/pool/expand  { n } 扩池
  // POST /api/console/proxy/pool/sticky  { minutes } 改粘性时长
  // POST /api/console/proxy/health-rotate 体检驱动换 IP（body 不传 health 则现测）
  register('GET', '/api/console/proxy/pool', wrap(async (req, res) => {
    if (!proxyPool) return json(res, 501, { ok: false, msg: 'proxyPool 未注入' });
    try { json(res, 200, { ok: true, data: proxyPool.list() }); } catch (e) { json(res, 200, { ok: false, msg: e.message }); }
  }));
  register('POST', '/api/console/proxy/rotate', wrap(async (req, res, body) => {
    if (!proxyPool) return json(res, 501, { ok: false, msg: 'proxyPool 未注入' });
    const win = body && body.windowId ? String(body.windowId) : (settingsForLive && settingsForLive.windowId ? String(settingsForLive.windowId) : '');
    if (!win) return json(res, 400, { ok: false, msg: '缺少 windowId（settings 未配置且未传参）' });
    const r = await proxyPool.rotate(win, { dryRun: !!(body && body.dryRun), force: !!(body && body.force) });
    json(res, (r && r.ok) ? 200 : 409, { ok: !!(r && r.ok), data: r, msg: r && (r.msg || r.reason) });
  }));
  register('POST', '/api/console/proxy/pool/expand', wrap(async (req, res, body) => {
    if (!proxyPool) return json(res, 501, { ok: false, msg: 'proxyPool 未注入' });
    json(res, 200, { ok: true, data: await proxyPool.expand(body && body.n) });
  }));
  register('POST', '/api/console/proxy/pool/sticky', wrap(async (req, res, body) => {
    if (!proxyPool) return json(res, 501, { ok: false, msg: 'proxyPool 未注入' });
    json(res, 200, { ok: true, data: await proxyPool.setSticky(body && body.minutes) });
  }));
  register('POST', '/api/console/proxy/health-rotate', wrap(async (req, res, body) => {
    if (!proxyPool) return json(res, 501, { ok: false, msg: 'proxyPool 未注入' });
    const win = body && body.windowId ? String(body.windowId) : (settingsForLive && settingsForLive.windowId ? String(settingsForLive.windowId) : '');
    if (!win) return json(res, 400, { ok: false, msg: '缺少 windowId' });
    let health = body && body.health;
    if (!health && deepScrape && typeof deepScrape.networkHealth === 'function') health = await deepScrape.networkHealth();
    if (!health) return json(res, 501, { ok: false, msg: '无法获取体检结果（deepScrape 未注入且未传 health）' });
    const r = await proxyPool.healthDrivenRotate(win, health);
    json(res, 200, { ok: !!(r && r.ok), data: r });
  }));
  // ---------------------------------------------------------------- 网络体检（只读，归因诊断）
  // ---------------------------------------------------------------- 轻量健康探针（task-2 / GUARDIAN ⑤ 守护验收）
  // GET /api/console/health → 200 { ok, service:'alive', port, cdp:{reachable, port}, ts }
  //   纯只读：服务活 + 监听端口 + CDP（BitBrowser apiBase，默认 127.0.0.1:54346）TCP 可达探测。
  //   【铁律】不调 /api/console/network/health、不做平台风控归因、不读代理池——
  //   pm2/Docker 健康检查打它绝不因风控非 200 误判→重启风暴（GUARDIAN ⑤ 决议）。
  //   CDP 不可达时 cdp.reachable=false 但端点仍 200（探针只报可达性，不归因）。
  register('GET', '/api/console/health', wrap(async (req, res) => {
    const host = settingsForLive && settingsForLive.host ? String(settingsForLive.host) : '127.0.0.1';
    const cdpPort = settingsForLive && settingsForLive.port ? Number(settingsForLive.port) : 54346;
    const svcPort = process.env.PORT ? Number(process.env.PORT) : 8300;
    let cdpReachable = false;
    try {
      cdpReachable = await new Promise((resolve) => {
        const sock = net.connect({ host, port: cdpPort });
        const timer = setTimeout(() => { try { sock.destroy(); } catch (e) { console.error('[consoleRoutes.health] CDP 探测 destroy 失败:', e && e.message); } resolve(false); }, 2000);
        sock.once('connect', () => { clearTimeout(timer); try { sock.destroy(); } catch (e) { console.error('[consoleRoutes.health] CDP 探测 destroy 失败:', e && e.message); } resolve(true); });
        sock.once('error', () => { clearTimeout(timer); try { sock.destroy(); } catch (e) { console.error('[consoleRoutes.health] CDP 探测 destroy 失败:', e && e.message); } resolve(false); });
      });
    } catch (e) {
      console.error('[consoleRoutes.health] CDP TCP 探测异常（记 reachable=false，不阻断 200）:', e && e.message);
      cdpReachable = false;
    }
    json(res, 200, { ok: true, service: 'alive', port: svcPort, cdp: { reachable: cdpReachable, port: cdpPort }, ts: new Date().toISOString() });
  }));

  // ---------------------------------------------------------------- 收件箱未读（Phase B 切单轨启用；InboxSnapshot 归位写）
  // GET /api/console/inbox/unread → 200 { ok, unread:[{ contactId, name, unread, lastMsgTime, onlineTier }], total }
  //   数据源 = SQLite InboxSnapshot（task-2 缓存轨归位）；前端「new 角标」改读此端点（§3.2 切单轨后启用）。
  //   过渡期（Phase A 双写）JSON 轨缓存仍写，本端点只读 SQLite，双源并存但前端角标以 SQLite 为准。
  //   纯只读聚合，不写 DB、不抓页面。
  register('GET', '/api/console/inbox/unread', wrap(async (req, res) => {
    if (!db) return json(res, 501, { ok: false, msg: 'store.db 未注入，无法查 InboxSnapshot' });
    let rows;
    try {
      rows = db.prepare(
        "SELECT s.contactId, c.displayName AS name, s.unread, s.lastMsgTime, s.onlineTier " +
        "FROM InboxSnapshot s LEFT JOIN Contact c ON c.contactId = s.contactId " +
        "WHERE s.unread > 0 ORDER BY s.lastMsgTime DESC"
      ).all();
    } catch (e) {
      // 表尚未归位（迁移未跑）或旧库无列时降级空，不 500（铁律 §0.5 catch 必 log）
      console.error('[consoleRoutes.inboxUnread] 查 InboxSnapshot 失败（降级空列表）:', e && e.message);
      return json(res, 200, { ok: true, unread: [], total: 0, degraded: true });
    }
    const unread = rows.map((r) => ({
      contactId: r.contactId, name: r.name || '', unread: r.unread,
      lastMsgTime: r.lastMsgTime || '', onlineTier: r.onlineTier || null,
    }));
    json(res, 200, { ok: true, unread, total: unread.length });
  }));

  // GET /api/console/network/health → { ok, health:{exitIp,platform,diagnosis}, fetchedAt }
  //   在出会窗口页面上下文探测：出口 IP（ipinfo/ipify）+ 平台连通 + CDP 可达性。
  //   用于回答「发消息失败/页面不动」到底是网络问题、平台问题还是 CDP 卡住。
  register('GET', '/api/console/network/health', wrap(async (req, res) => {
    if (!deepScrape || typeof deepScrape.networkHealth !== 'function') {
      return json(res, 501, { ok: false, msg: 'deepScrape 未注入，无法做网络体检' });
    }
    const result = await deepScrape.networkHealth();
    json(res, 200, result);
  }));

  // ---------------------------------------------------------------- 真发（出会窗口 · CDP 页面操作）
  // POST /api/console/send-live { contactId, text, doConfirm?, waitMs?, toInbox? }
  //   老板在控制台填好要说的话 → 点「确认发送」才调（直接真发，非话术生成确认）
  //   - 经 deepScrape.sendToContact：切到目标会话页 → 填 textarea → 点 #sendButton → 确认弹窗 → 点 #submitBtn（POST ajax_mail_send.html）
  //   - toInbox 默认 true：发完把窗口切回收件箱，避免停在会话页中断后续操作
  //   - 参数缺失 / 客户不存在 / 文本为空 / 文本>500字 → 拒绝发送，返回 reason（不打 CDP）
  // 约束：不改 M0 schema；发送走 deepScrape（单一页面操作路径）。
  register('POST', '/api/console/send-live', wrap(async (req, res, body) => {
    if (!deepScrape || typeof deepScrape.sendToContact !== 'function') {
      return json(res, 501, { ok: false, msg: 'deepScrape 未注入（出会窗口 CDP 不可用），无法真发' });
    }
    const contactId = body && body.contactId ? String(body.contactId) : '';
    const text = body && body.text ? String(body.text).trim() : '';
    if (!contactId) return json(res, 400, { ok: false, msg: '缺少 contactId' });
    if (!text) return json(res, 400, { ok: false, msg: '缺少 text（发送内容不能为空）' });
    if (text.length > 500) return json(res, 400, { ok: false, msg: 'text 超过 500 字，出会平台限制 500 字以内' });
    const c = ichigoCache ? ichigoCache.getContact(contactId) : null;
    if (!c || !c.historyUrl) {
      return json(res, 404, { ok: false, msg: '客户不存在或无会话页（先调 /api/console/mailbox 建立快照）', contactId: contactId });
    }
    const doConfirm = body && body.doConfirm !== undefined ? !!body.doConfirm : true;
    const toInbox = body && body.toInbox !== undefined ? !!body.toInbox : true;
    let result;
    try {
      result = await deepScrape.sendToContact(c.historyUrl, text, { doConfirm: doConfirm, waitMs: body && body.waitMs ? Number(body.waitMs) : 6000 });
    } catch (e) { return json(res, 500, { ok: false, msg: e.message }); }
    let inboxNav = null;
    if (toInbox && result && result.ok && typeof deepScrape.navigateInbox === 'function') {
      inboxNav = await deepScrape.navigateInbox();
      if (inboxNav && inboxNav.ok) result.returnedToInbox = true;
    }
    // 发送成功 → 强制重抓该客户历史（让前端立即看到刚发出的消息）并顺带刷新收件箱列表
    if (result && result.ok) {
      try {
        const h = await deepScrape.fetchHistory(c.historyUrl);
        if (h && h.ok) {
          ichigoCache.setMessages(c.contactId, h.messages || [], { avatarUrl: h.avatarUrl, avatarIsDefault: h.avatarIsDefault, historyUrl: c.historyUrl });
          const cc = ichigoCache.getContact(c.contactId);
          if (cc) {
            cc.lastMsg = String(text || '').slice(0, 60);
            cc.lastMsgTime = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
            cc.lastMsgTimeSeen = cc.lastMsgTime;      // 自己发的不算未读
            cc.unread = 0;
          }
          result.messagesRefreshed = true;
          result.messageCount = (h.messages || []).length;
        }
      } catch (e) { /* 重抓失败不影响发送结果 */ }
      // 刷新收件箱快照（更新该客户在列表里的"最后一条"）
      try { await deepScrape.mailboxOnly({ allPages: false, maxPages: 1 }); } catch (e) { /* 忽略 */ }
      ichigoCache.saveNow();
    }
    json(res, 200, {
      ok: !!(result && result.ok),
      data: {
        sent: !!(result && result.ok),
        contactId: contactId,
        name: c.name || null,
        step: result && result.step || null,
        reason: result && result.reason || '',
        via: result && result.via || null,
        sentAt: result && result.sentAt || null,
        returnedToInbox: !!(result && result.returnedToInbox),
        inboxNav: inboxNav,
        messagesRefreshed: !!(result && result.messagesRefreshed),
        messageCount: result && result.messageCount != null ? result.messageCount : null,
        textLen: text.length,
      },
      note: result && result.ok ? '已真发（出会窗口页面操作）' : '未发送：' + ((result && (result.reason || result.msg)) || '未知'),
    });
  }));

  // ---------------------------------------------------------------- task-37：待确认话术队列（只读）
  // GET /api/console/pending-queue?contactId=&limit= → 还没发的话术列表（审计视图「待确认」区块数据源）
  register('GET', '/api/console/pending-queue', wrap(async (req, res) => {
    if (!talkEngine || typeof talkEngine.getPendingQueue !== 'function') {
      return json(res, 501, { ok: false, msg: 'talkEngine.getPendingQueue 未注入' });
    }
    const q = queryOf(req);
    const limit = Math.min(Number(q.limit) || 50, 500);
    const contactId = q.contactId || null;
    let items = talkEngine.getPendingQueue(limit);
    if (contactId) items = items.filter((p) => String(p.contactId) === String(contactId));
    json(res, 200, {
      ok: true,
      data: items.map((p) => ({
        contactId: p.contactId,
        accountId: p.accountId || null,
        text: p.text,
        tier: p.tier,
        confirmed: p.confirmed === true,
        confirmedAt: p.confirmedAt || null,
        gateBlocked: p.gateBlocked === true,
        gateBlockReason: p.reason || '',
        ts: p.ts,
      })),
      total: items.length,
    });
  }));

  // ---------------------------------------------------------------- 审计 + 封号演练（task-30，只读聚合）
  // GET /api/console/audit → { complianceSummary, banDrillStatus, recentAudit[20] }
  //   - complianceSummary：active GovernanceRule 合规集 + 近 24h 被拦截话术计数（按 reason 分组，
  //     数据源 = talkEngine.getAuditSummary()，M3 话术引擎闸门拦截账本）；
  //   - banDrillStatus：封号演练状态 = lineOa.stats() 的 failRate/degraded（deps.lineOa 注入时读；
  //     未注入则从 LeadEvent 近 24h signals 里 rollback/ban 标记推 degraded）+ 24h 停发开关生效标记；
  //   - recentAudit：最近 20 条 LeadEvent（action/signals/contactId/tier/createdAt）供时间线展示。
  // 约束：只读，不改 M0 schema、不写业务逻辑。
  register('GET', '/api/console/audit', wrap(async (req, res) => {
    if (!db) return json(res, 501, { ok: false, msg: 'store.db 未注入' });
    const dayAgoIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

    // ---- complianceSummary：合规红线集 + 拦截计数 ----
    let complianceRules = [];
    try {
      complianceRules = db.prepare(
        "SELECT ruleId, ruleType, scope, scopeKey, rule, priority FROM GovernanceRule " +
        "WHERE status = 'active' AND ruleType IN ('compliance','speechBoundary') ORDER BY priority DESC"
      ).all();
    } catch (_) { complianceRules = []; }

    // 拦截计数：优先 talkEngine.getAuditSummary()（M3 闸门账本，按 reason 分组）
    let gateBlocks = { byReason: {}, totalBlocked: 0, recentGateBlocks: [] };
    if (talkEngine && typeof talkEngine.getAuditSummary === 'function') {
      try {
        const sum = talkEngine.getAuditSummary(200);
        gateBlocks.byReason = sum.byReason || {};
        gateBlocks.totalBlocked = sum.totalBlocked || 0;
        gateBlocks.recentGateBlocks = (sum.recentGateBlocks || []).slice(-50);
      } catch (_) { /* 账本不可用则空 */ }
    }
    // 兜底：近 24h LeadEvent signals 里的 gateOk=false 计数（无 talkEngine 注入时）
    if (!talkEngine) {
      try {
        const evts = db.prepare(
          "SELECT signals FROM LeadEvent WHERE createdAt >= ? AND action = 'triggered'"
        ).all(dayAgoIso);
        const counts = {};
        for (const ev of evts) {
          let sig = null; try { sig = ev.signals ? JSON.parse(ev.signals) : []; } catch (_) { sig = []; }
          for (const s of (Array.isArray(sig) ? sig : [])) {
            if (s && s.signal === 'talkEngine' && s.gateOk === false) {
              const key = /频控/.test(String(s.reason || '')) ? 'rateLimit' : (/黑名单|compliance/.test(String(s.reason || '')) ? 'blacklist' : 'compliance');
              counts[key] = (counts[key] || 0) + 1;
            }
          }
        }
        gateBlocks.byReason = counts;
        gateBlocks.totalBlocked = Object.keys(counts).reduce((a, k) => a + counts[k], 0);
      } catch (_) { /* ignore */ }
    }
    const complianceSummary = {
      activeComplianceRules: complianceRules,
      activeComplianceCount: complianceRules.length,
      blocked24h: gateBlocks.totalBlocked,
      byReason: gateBlocks.byReason,
    };

    // ---- banDrillStatus：封号演练状态 ----
    //  1) deps.lineOa.stats()（M3 LINE OA 风控账本：failRate / degraded）
    let lineStats = null;
    if (deps.lineOa && typeof deps.lineOa.stats === 'function') {
      try { lineStats = deps.lineOa.stats(); } catch (_) { lineStats = null; }
    }
    //  2) 近 24h LeadEvent 里 action='archived' 且 signals 含 rollback/ban 的条数（停发开关生效标记）
    let banSignals24h = 0;
    try {
      const rows = db.prepare(
        "SELECT signals FROM LeadEvent WHERE createdAt >= ? AND action = 'archived'"
      ).all(dayAgoIso);
      for (const row of rows) {
        let sig = null; try { sig = row.signals ? JSON.parse(row.signals) : []; } catch (_) { sig = []; }
        const joined = JSON.stringify(sig).toLowerCase();
        if (joined.includes('rollback') || joined.includes('ban') || joined.includes('停发')) banSignals24h += 1;
      }
    } catch (_) { banSignals24h = 0; }

    const failRate = lineStats ? Number(lineStats.failRate) : 0;
    const degraded = !!(lineStats && lineStats.degraded) || failRate > 0.05;
    // 封号演练「通过」= 触发限流后 24h 停发开关生效（banSignals24h>0 或 degraded 已标记）且无持续 fail
    const drillPassed = !!(banSignals24h > 0 || degraded);
    const banDrillStatus = {
      failRate: Math.round(failRate * 1000) / 1000,   // 0-1
      failRatePct: Math.round(failRate * 10000) / 100, // 展示用百分数（1 位）
      degraded,                                          // >5% 标红
      threshold: 0.05,
      sendCount: lineStats ? lineStats.sendCount : 0,
      failCount: lineStats ? lineStats.failCount : 0,
      banSignals24h,                                     // 近 24h 停发/回滚/封号标记事件数
      drillPassed,                                        // 封号演练通过标记
      lineOaInjected: !!(deps.lineOa && typeof deps.lineOa.stats === 'function'),
      computedAt: new Date().toISOString(),
    };

    // ---- recentAudit：最近 20 条 LeadEvent ----
    let recentAudit = [];
    try {
      recentAudit = db.prepare(
        "SELECT leadEventId, contactId, score, tier, action, signals, lineOffered, lineAdded, createdAt " +
        "FROM LeadEvent ORDER BY createdAt DESC LIMIT 20"
      ).all().map((e) => {
        let sig = null; try { sig = e.signals ? JSON.parse(e.signals) : []; } catch (_) { sig = []; }
        return Object.assign({}, e, { signals: Array.isArray(sig) ? sig : sig });
      });
    } catch (_) { recentAudit = []; }

    // ---- task-37：待确认话术队列（审计视图展示「还没发的」）----
    let pendingQueue = [];
    if (talkEngine && typeof talkEngine.getPendingQueue === 'function') {
      try {
        pendingQueue = talkEngine.getPendingQueue(50).map((p) => ({
          contactId: p.contactId,
          text: p.text,
          tier: p.tier,
          confirmed: p.confirmed === true,
          gateBlocked: p.gateBlocked === true,
          ts: p.ts,
        }));
      } catch (_) { pendingQueue = []; }
    }
    json(res, 200, {
      ok: true,
      data: { complianceSummary, banDrillStatus, recentAudit, pendingQueue },
    });
  }));

  register('GET', '/api/console/private-domain', wrap(async (req, res) => {
    const lineStatus = 'pending'; // M4 未接真实 LINE 官方账号凭据（m4-handoff.md）
    json(res, 200, {
      ok: true,
      data: {
        line: {
          status: lineStatus,
          required: ['channelAccessToken', 'channelSecret', 'webhookSecret'],
          ref: 'docs/plan/m4-handoff.md',
          note: 'LINE 官方 OA 私域基建：注入 3 项凭据到 createLineOa() + 注册 /line/webhook 后即可切换为 live',
        },
        others: ['fb', 'whatsapp'],
      },
    });
  }));

  return app;
}

module.exports = { mountConsoleRoutes };
