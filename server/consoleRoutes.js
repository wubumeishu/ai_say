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

const http = require('http')
const path = require('path');;
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
const domainRank = require('./adapter/domainRank.js');
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
  const unreadPoller = deps.unreadPoller || null; // v5.3 · 批2 未读轮询器（非秒回）
  const breathEngine = deps.breathEngine || null; // T3 · 任务编排：呼吸引擎（节拍调度，不直接发）
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
  const followupSop = require('./acquisition/followupSop.js');
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
      else if (method === 'DELETE' && typeof app.delete === 'function') app.delete(pathname, handler);
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
    // 模块2 · 总控紧急修复：翻译指令漂移（日翻日）→ 强硬 System Prompt
    // 原单条 prompt 太弱，模型对"ぜひー！"这类短语气词会原样吐回。现在双角色（system 强硬 + user 任务）
    var fromLabel = from === 'ja' ? '日语' : from;
    var toLabel = to === 'zh-CN' ? '简体中文' : (to === 'zh-TW' ? '繁体中文' : to);
    var systemPrompt =
      '你是一个专业的「' + fromLabel + '→' + toLabel + '」翻译引擎。你的唯一任务是输出' + toLabel + '。' +
      '无论输入什么内容（包括语气词、拟声词、无意义字符），绝对禁止输出' + fromLabel + '原文，' +
      '严禁回复任何解释、前缀、引号、代码块包裹。只输出译文本身，没有译文也输出最接近的' + toLabel + '等价表达。' +
      '若原文是「ぜひ」→「来吧」；若是「いいですね」→「好的呢」；严禁原样复读。';
    var userPrompt = '原文（' + fromLabel + '）：\n' + text + '\n请输出' + toLabel + '译文：';
    // 硬超时：单条挂住不能拖垮整批（否则前端会出现"部分消息翻译不完"）
    const ctrl = new AbortController();
    const timer = setTimeout(function() { try { ctrl.abort(); } catch (_) {} }, timeoutMs || 25000);
    let resp;
    try {
      resp = await fetch(modelCfg.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + modelCfg.apiKey },
        body: JSON.stringify({
          model: modelCfg.model || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
        }),
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
    if (!resp.ok) throw new Error('model HTTP ' + resp.status);
    const data = await resp.json();
    const out = data.choices && data.choices[0] ? data.choices[0].message.content : '';
    if (!out) throw new Error('模型返回空');
    var cleaned = String(out).trim();
    // 兜底校验：若模型仍复读日文原文（日翻日漂移），强制标记漂移（前端可走词典兜底）
    var jaCount = (cleaned.match(/[ぁ-んァ-ヶ]/g) || []).length;
    var cleanAscii = cleaned.replace(/[ぁ-んァ-ヶ]/g, '');
    if (cleaned && jaCount > 0 && cleanAscii.length < 4) {
      // 几乎全是日文字符 + 无其他内容 = 漂移
      throw new Error('llm-drift: ' + cleaned.slice(0, 30));
    }
    return cleaned;
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


  // 007 · 资料池自动同步: 线索灌库后自动 promote 进 Profile(幂等; 同 leadId 已存在则刷新快照, 否则新建 pending)
  // 仅手动灌库入口调用, 不发消息/不抓平台(铁律 0.1); 抓取状态仍走 /profiles/crawl
  function autoSyncProfile(leadRow, input) {
    if (!store || typeof store.upsertProfile !== 'function') return null;
    const leadId = (leadRow && leadRow.leadId) || input.leadId;
    if (!leadId) return null;
    let msgCount = 0;
    try {
      if (leadRow && leadRow.contactId && store.db) {
        const c = store.db.prepare('SELECT COUNT(*) AS c FROM Message WHERE contactId = ?').get(String(leadRow.contactId));
        msgCount = c ? Number(c.c || 0) : 0;
      }
    } catch (_) { msgCount = 0; }
    try {
      return store.upsertProfile({
        leadId: leadId,
        contactId: leadRow && leadRow.contactId ? String(leadRow.contactId) : null,
        platform: input.platform,
        accountId: input.accountId || (leadRow && leadRow.accountId) || '17098',
        name: input.name, gender: input.gender, age: input.age, region: input.region,
        online: input.online, avatarUrl: input.avatarUrl, profileUrl: input.profileUrl,
        selfIntro: input.selfIntro, sourceDim: input.sourceDim,
        communicated: msgCount > 0,
        msgCount: msgCount,
        extras: input.extras || (leadRow && leadRow.extras ? (function () { try { return JSON.parse(leadRow.extras); } catch (_) { return {}; } })() : {}),
      });
    } catch (e) {
      try { console.warn('[autoSyncProfile] 同步资料池失败:', e && e.message); } catch (_) {}
      return null;
    }
  }
  // 收件箱客户同步 helper: 按"当前页实际客户"(前端传入优先, 否则缓存 liveSet) 进资料池
  // 用户 2026-11-10 裁定: ① 双向消息=已沟通 ② 按页面实际内容, 测试(AA_test)/已删客户不进 ③ 支持重爬+维护
  function syncInboxProfiles(platform, accountId, inboxContacts) {
    const EXCLUDE = { AA_test: 1 }; // 测试数据剔除
    // 数据来源: 优先前端传入的"当前页实际客户"(最准, 4 人); 否则 ichigoCache 缓存
    let src = Array.isArray(inboxContacts) && inboxContacts.length ? inboxContacts : null;
    if (!src && ichigoCache && typeof ichigoCache.getContacts === 'function') {
      // 默认取"最近 7 天活跃"的(近似当前页可见客户; 页面按活跃展示, 已删/归档自然不在)
      var sevenDaysAgo = Date.now() - 7 * 86400000;
      src = (ichigoCache.getContacts() || []).filter(function (c) {
        if (!c || !c.contactId || c.archived) return false;
        // 近 7 天有 lastSeen 的 = 当前页可见(平台按活跃展示收件箱)
        var ls = c.lastSeen ? new Date(c.lastSeen).getTime() : 0;
        return ls >= sevenDaysAgo;
      });
    }
    src = src || [];
    let synced = 0;
    src.forEach(function (ct) {
      if (!ct.contactId) return;
      if (EXCLUDE[ct.name]) return;
      try {
        var mCount = Array.isArray(ct.messages) ? ct.messages.length : 0;
        var r = store.upsertProfile({
          leadId: null,
          profileId: 'PINB' + require('crypto').createHash('sha1').update('inbox/' + ct.contactId).digest('hex').slice(0, 16),
          contactId: String(ct.contactId),
          platform: platform,
          accountId: accountId,
          name: ct.name || ct.displayName || '',
          age: ct.age || null, region: ct.region || null, online: ct.onlineTier || null,
          avatarUrl: ct.avatarUrl || null, profileUrl: ct.profileUrl || null,
          sourceDim: 'inbox',
          communicated: mCount > 0,
          msgCount: mCount,
          extras: { fromInbox: 1, inboxUnread: ct.unread || 0, inboxLastMsgTime: ct.lastMsgTime || ct.lastSeen || null, inboxLastMsg: ct.lastMsg || '' },
        });
        if (r) synced++;
      } catch (_) { /* 单条失败不阻断 */ }
    });
    return { synced: synced, note: '收件箱同步 ' + synced + ' 客户(当前页实际)' };
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
        //   * blacklist → 逐个调 deepScrape.blockContact(customerName) 触发真实 3 步删除（收件箱编辑模式）
        //   * archive   → 仅 DB 打标（归档是本地操作，不触发平台动作）
        //   * CDP 不可用/按钮未找到 → queued 提示（"已排入真实拉黑队列/待同步到窗口"），不当成假拉黑
        let realSync = { queued: 0, blocked: 0, failed: 0, detail: [] };
if (action === 'blacklist' && deepScrape && typeof deepScrape.blockContact === 'function') {
          // 模块1整改 · 真实 5 步 RPA（2026-10-23 实测）：
          //   收件箱页「編集」→ 编辑模式勾 N 个 checkbox（按客户名）→「チェックを削除する」
          //   → show_mail_delete.html 二次确认页 →「削除する」→ 显式导航回收件箱
          // 批量一次调用（customerName 传数组，平台合并成 1 个确认页，不是逐人 N 次循环）
          // 按客户名定位 checkbox（Step2 需要 customerName）
          const named = [];   // { contactId, custName }
          for (const id of uniq) {
            const c = ichigoCache ? ichigoCache.getContact(id) : null;
            if (!c) {
              realSync.queued += 1;
              realSync.detail.push({ contactId: id, status: 'queued', note: '客户缓存缺失，待窗口重新抓取后同步删除' });
              continue;
            }
            named.push({ contactId: id, custName: c.name || c.displayName || '' });
          }
          if (named.length > 0) {
            // 一次传数组，blockContact 内部：preflight 拿编辑 href → 导航编辑模式 → execute 勾 N 个 → 删除 → 确认 → 显式回 inbox
            const nameArr = named.map((n) => n.custName).filter(Boolean);
            try {
              const br = await deepScrape.blockContact(nameArr, { refreshMailbox: true, verify: true });
              if (br && br.ok) {
                // 映射 br.matched 回 contactId
                const matchedSet = new Set(br.matched || []);
                for (const n of named) {
                  if (matchedSet.has(n.custName)) {
                    realSync.blocked += 1;
                    realSync.detail.push({ contactId: n.contactId, status: 'blocked', matched: n.custName, note: br.note });
                  } else {
                    realSync.queued += 1;
                    realSync.detail.push({ contactId: n.contactId, status: 'queued', reason: 'customer-not-in-list', note: '窗口编辑模式下未匹配到「' + n.custName + '」（可能名称漂移/缓存缺失）' });
                  }
                }
                realSync.missed = br.missed || [];
                realSync.partialMiss = !!br.partialMiss;
                realSync.confirmPage = !!br.confirmPage;
                realSync.mailboxNav = !!br.mailboxNav;
                realSync.remainingCount = br.remainingCount != null ? br.remainingCount : null;
              } else {
                // CDP 不可用 / 客户不在列表 → 全部 queued
                for (const n of named) {
                  realSync.queued += 1;
                  realSync.detail.push({ contactId: n.contactId, status: 'queued', reason: br ? br.reason : 'cdp-unavailable', note: br ? (br.note || br.msg || '删除未触发') : 'CDP 不可用，待窗口打开后同步' });
                }
                realSync.missed = br && br.missed ? br.missed : [];
              }
            } catch (e) {
              realSync.failed += 1;
              realSync.detail.push({ contactId: named.map((n) => n.contactId).join(','), status: 'failed', note: String((e && e.message) || e) });
            }
          }
          // 真·自动同步：真实删除成功 → 强制重抓收件箱（刷新前端+DB+真实窗口三方；blockContact 内已显式回 inbox，这里重抓 DB 快照）
          if (realSync.blocked > 0) {
            try {
              await deepScrape.mailboxOnly({ allPages: false, maxPages: 1 });
              if (ichigoCache) ichigoCache.saveNow();
              realSync.mailboxRefreshed = true;
            } catch (_) { realSync.mailboxRefreshed = false; }
          }
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

  // GET /api/console/bbs/posts?page=1&genre=5&board=pure
  //   模块3 · BBS 帖子查询（只读）：在出会窗口 POST ajax 端点 + 解析卡片 → 结构化帖子列表
  //   窗口未连上 → 501 cdp-unavailable（不 500）；无帖子 → ok:true + posts:[]（空不报错）
  // POST /api/console/bbs/post/edit  模块3 阶段2 · 改帖（强副作用，需 confirmed=true）
  //   body: { targetBbsId, title?, body?, confirmed: true }
  //   铁律 1/2：confirmed 必须显式 true 且 body 非空才执行；否则 409 + 提示待确认
  //   执行 → deepScrape.bbsWritePost(targetBbsId, { title, body }) → 真实窗口改帖
  register('POST', '/api/console/bbs/post/edit', wrap(async (req, res, body) => {
    if (!deepScrape || typeof deepScrape.bbsWritePost !== 'function') {
      return json(res, 501, { ok: false, reason: 'bbs-writer-not-injected', msg: 'BBS 改帖器未注入（deepScrape 未就绪）' });
    }
    const targetBbsId = body && body.targetBbsId;
    const writeOpts = {};
    if (body && typeof body.title === 'string') writeOpts.title = body.title;
    if (body && typeof body.body === 'string') writeOpts.body = body.body;
    if (!targetBbsId) return json(res, 400, { ok: false, reason: 'missing-targetBbsId', msg: '缺少 targetBbsId（帖子 ID）' });
    if (!writeOpts.title && !writeOpts.body) return json(res, 400, { ok: false, reason: 'nothing-to-write', msg: '未提供 title/body，无改动内容' });
    // 铁律 2：确认闸门
    if (!body || body.confirmed !== true) {
      return json(res, 409, {
        ok: false,
        reason: 'confirmation-required',
        msg: '改帖是强副作用，需 body.confirmed=true 才执行；当前未确认。复述：改 targetBbsId=' + targetBbsId + '，改字段：' + Object.keys(writeOpts).join('/'),
        pending: { targetBbsId: String(targetBbsId), title: writeOpts.title || null, body: writeOpts.body || null }
      });
    }
    try {
      const r = await deepScrape.bbsWritePost(targetBbsId, writeOpts);
      if (!r || !r.ok) return json(res, 200, Object.assign({ ok: false }, r, { note: '改帖未成功，窗口状态未变；可重试' }));
      return json(res, 200, Object.assign({ ok: true }, r, { note: '已在真实窗口改帖 targetBbsId=' + targetBbsId }));
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'bbs-edit-exception', msg: String((e && e.message) || e) });
    }
  }));

  // POST /api/console/bbs/post/delete  模块3 阶段2 · 删帖（强副作用，需 confirmed=true + 复述 ID）
  //   body: { targetBbsIds: [id,...] | id, board?, confirmed: true }
  //   铁律 1/2：confirmed 必须显式 true + targetBbsIds 非空才执行；否则 409 回显待确认
  //   执行 → deepScrape.bbsDeletePosts → 勾选 → 点「チェックを削除」→ 确认页「削除する」→ 回列表页验证
  register('POST', '/api/console/bbs/post/delete', wrap(async (req, res, body) => {
    if (!deepScrape || typeof deepScrape.bbsDeletePosts !== 'function') {
      return json(res, 501, { ok: false, reason: 'bbs-deleter-not-injected', msg: 'BBS 删帖器未注入（deepScrape 未就绪）' });
    }
    let ids = body && body.targetBbsIds;
    if (!ids && body && body.targetBbsId) ids = [body.targetBbsId];
    ids = Array.isArray(ids) ? ids.map(String).filter(Boolean) : (ids ? [String(ids)] : []);
    if (ids.length === 0) return json(res, 400, { ok: false, reason: 'missing-targetBbsIds', msg: '缺少 targetBbsIds（拒绝盲删）' });
    if (!body || body.confirmed !== true) {
      return json(res, 409, {
        ok: false,
        reason: 'confirmation-required',
        msg: '删帖是强副作用（不可逆），需 body.confirmed=true 才执行；当前未确认。复述：删 ' + ids.length + ' 帖（ID: ' + ids.join(', ') + '）',
        pending: { targetBbsIds: ids, board: (body && body.board) || 'pure' }
      });
    }
    try {
      const r = await deepScrape.bbsDeletePosts(ids, { board: (body && body.board) || 'pure' });
      if (!r || !r.ok) return json(res, 200, Object.assign({ ok: false }, r, { note: '删帖未成功，窗口状态未变；可重试' }));
      return json(res, 200, Object.assign({ ok: true }, r, { note: '已在真实窗口删 ' + (r.matched ? r.matched.length : ids.length) + ' 帖' + (r.verifiedDeleted ? '（验证已消失）' : '（验证状态未知，请人工确认）') }));
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'bbs-delete-exception', msg: String((e && e.message) || e) });
    }
  }));

  // ===== agent 包管理（总控 2026-10-25）=====
  // GET /api/console/agent-pkg  列 agent（内置 + 动态合并）+ LLM 工具清单
  // POST /api/console/agent-pkg/run  试跑一个 agent（走 agentExecutor；强副作用不带 confirmed 则只返回 confirmation-required）
  //   body: { agentId, params, confirmed? }；默认不带 confirmed（试跑安全，强副作用不真执行）
  register('POST', '/api/console/agent-pkg/run', wrap(async (req, res, body) => {
    const executor = require('./agents/agentExecutor');
    if (!body || !body.agentId) return json(res, 400, { ok: false, reason: 'missing-agentId', msg: '需 agentId' });
    try {
      const r = await executor.executeAgent({ agentId: body.agentId, params: body.params || {}, confirmed: body.confirmed === true }, { baseUrl: 'http://127.0.0.1:' + (process.env.PORT || 8300) });
      return json(res, 200, r);
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'agent-run-exception', msg: String((e && e.message) || e) });
    }
  }));

  register('GET', '/api/console/agent-pkg', wrap(async (req, res) => {
    const registry = deepScrape ? require('./agents/registry') : null;
    const reg = registry || require('./agents/registry');
    try {
      const merged = reg.mergedAgents ? reg.mergedAgents() : reg.AGENTS;
      const llmTools = reg.mergedLlmToolList ? reg.mergedLlmToolList() : reg.toLlmToolList();
      return json(res, 200, { ok: true, agents: merged, llmTools: llmTools, count: merged.length, builtin: reg.AGENTS.length });
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'agent-pkg-load-failed', msg: String((e && e.message) || e) });
    }
  }));

  // POST /api/console/agent-pkg/add  新增/更新动态 agent（写 data/agent-pkg.json，免重启生效）
  //   body: agent 定义 { id, name, module, desc, sideEffect, params, endpoint, needsConfirm, buildPayload? }
  //   同名 id 覆盖内置（调试/临时改）
  register('POST', '/api/console/agent-pkg/add', wrap(async (req, res, body) => {
    const reg = require('./agents/registry');
    const a = body || {};
    if (!a.id || !a.name) return json(res, 400, { ok: false, reason: 'missing-id-name', msg: 'agent 需 id + name' });
    if (!a.endpoint || !a.endpoint.path) return json(res, 400, { ok: false, reason: 'missing-endpoint', msg: 'agent 需 endpoint.path（映射到 /api/console/*）' });
    if (!a.sideEffect || ['none', 'weak', 'strong'].indexOf(a.sideEffect) === -1) return json(res, 400, { ok: false, reason: 'bad-sideEffect', msg: 'sideEffect 需 none/weak/strong' });
    // strong 副作用强制 needsConfirm=true（铁律，防误配）
    if (a.sideEffect === 'strong' && a.needsConfirm !== true) a.needsConfirm = true;
    try {
      const list = reg.loadDynamic();
      const i = list.findIndex(function (x) { return x.id === a.id || x.type === a.id; });
      if (i >= 0) list[i] = a; else list.push(a);
      reg.saveDynamic(list);
      return json(res, 200, { ok: true, saved: a.id, count: list.length, replaced: i >= 0 });
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'agent-pkg-save-failed', msg: String((e && e.message) || e) });
    }
  }));

  // DELETE /api/console/agent-pkg/:id  删动态 agent（内置 agent 不可删，提示走 registry.js 代码改）
  register('DELETE', '/api/console/agent-pkg/:id', wrap(async (req, res, body) => {
    const reg = require('./agents/registry');
    const id = String((req.params || {}).id || '');
    const list = reg.loadDynamic();
    const i = list.findIndex(function (x) { return x.id === id || x.type === id; });
    if (i === -1) {
      // 内置 agent
      const builtin = reg.AGENTS.some(function (x) { return x.id === id || reg.llmTypeOf(x) === id; });
      if (builtin) return json(res, 409, { ok: false, reason: 'builtin-agent', msg: id + ' 是内置 agent（registry.js 代码定义），不可删；要删改 server/agents/registry.js' });
      return json(res, 404, { ok: false, reason: 'not-found', msg: '未找到动态 agent ' + id });
    }
    list.splice(i, 1);
    reg.saveDynamic(list);
    return json(res, 200, { ok: true, deleted: id, count: list.length });
  }));
  register('GET', '/api/console/bbs/posts', wrap(async (req, res) => {
    if (!deepScrape || typeof deepScrape.queryBbsPosts !== 'function') {
      return json(res, 501, { ok: false, reason: 'bbs-scraper-not-injected', msg: 'BBS 查询器未注入（deepScrape 未就绪）' });
    }
    const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const opts = {
      page: parseInt(qs.get('page') || '1', 10),
      genre: parseInt(qs.get('genre') || '5', 10),
      count: parseInt(qs.get('count') || '15', 10),
      prefId: parseInt(qs.get('prefId') || '24', 10),
      hokkaidoFlag: parseInt(qs.get('hokkaidoFlag') || '0', 10),
      board: qs.get('board') || 'pure'
    };
    try {
      const r = await deepScrape.queryBbsPosts(opts);
      if (!r || !r.ok) {
        // 空帖子（reason=empty）仍回 200 + 空列表；CDP 不可用回 501
        if (r && r.reason === 'empty') return json(res, 200, Object.assign({ ok: true, posts: [], total: 0, empty: true }, r));
        return json(res, 501, Object.assign({ ok: false }, r));
      }
      return json(res, 200, Object.assign({ ok: true }, r));
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'bbs-query-exception', msg: String((e && e.message) || e) });
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
  //   全客户无 messages → { ok:true, empty:true }。  // GET /api/console/bbs/cooldown  模块3 · 读 BBS 1h 冷却规则 + 当前冷却剩余
  //   读 GovernanceRule bbs-post-cooldown → 算自上次 BBS 操作（SentLog/操作日志）以来是否仍在冷却期
  //   返回 { ruleId, cooldownMinutes, lastBbsOpAt?, inCooldown, cooldownRemainingSec? }
  // ---- 账号池/窗口池 + 健康巡检 + 跨账号任务分发（v5.3 · 批1 群控基座） ----
  register('GET', '/api/console/account-pool', wrap(async (req, res) => {
    if (!store) return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const accounts = store.listAccounts ? store.listAccounts() : [];
    const windows = store.listWindows ? store.listWindows() : [];
    // 健康巡检：对每个窗口试 CDP 连通（超时会降级，不阻断；只巡检已注入 scanner 的平台）
    const health = [];
    for (const w of windows) {
      const scanner = w.platform === 'kairaku' ? happyScanner : liveScanner;
      let h = { windowId: w.windowId, accountId: w.accountId, status: 'unknown' };
      if (scanner && typeof scanner.openCdpSession === 'function') {
        try {
          const session = await scanner.openCdpSession();
          h.status = session ? 'healthy' : 'unreachable';
          if (session && session.close) try { session.close(); } catch (_) { /* */ }
          if (store.markWindowHealth) store.markWindowHealth(w.windowId, h.status === 'healthy', h.status);
        } catch (e) {
          h.status = 'error'; h.error = String(e && e.message || e).slice(0, 120);
        }
      } else {
        h.status = 'no-scanner';
      }
      health.push(h);
    }
    return json(res, 200, {
      ok: true,
      accounts,
      windows,
      health,
      note: '健康巡检逐窗口试 CDP 连通；no-scanner = 该平台抓取器未注入',
    });
  }));
  register('GET', '/api/console/tasks', wrap(async (req, res) => {
    if (!store || typeof store.listTasks !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const qs = queryOf(req);
    const rows = store.listTasks({ status: qs.status || undefined, accountId: qs.accountId || undefined });
    rows.forEach((r) => { try { if (r.payload) r.payload = JSON.parse(r.payload); } catch (_) { /* */ } });
    return json(res, 200, { ok: true, count: rows.length, tasks: rows });
  }));

  // ------------------------------------------------------------------
  // T3 任务编排：呼吸引擎路由组（/tasks/breath/*）
  // 引擎只调度节拍（何时唤醒 + 抢单 + 异常熔断），不直接发消息/发链接（铁律 0.1）。
  // 真实业务副作用由 SOP 执行器接管（onTask 钩子）；本组负责 启停/状态/入队/规则/看板。
  // ------------------------------------------------------------------
  register('GET', '/api/console/tasks/breath/status', wrap(async (req, res) => {
    if (!breathEngine) return json(res, 501, { ok: false, reason: 'breathEngine-not-injected' });
    return json(res, 200, { ok: true, engine: breathEngine.status() });
  }));
  register('POST', '/api/console/tasks/breath/start', wrap(async (req, res) => {
    if (!breathEngine) return json(res, 501, { ok: false, reason: 'breathEngine-not-injected' });
    const r = breathEngine.start();
    return json(res, 200, { ok: true, ...r, note: '引擎已启动（节拍调度；副作用由 SOP 执行器驱动）' });
  }));
  register('POST', '/api/console/tasks/breath/stop', wrap(async (req, res) => {
    if (!breathEngine) return json(res, 501, { ok: false, reason: 'breathEngine-not-injected' });
    const r = breathEngine.stop();
    return json(res, 200, { ok: true, ...r });
  }));
  // 入队呼吸任务（按场景 + 账号 + 节拍 + nextWakeAt；幂等键）
  register('POST', '/api/console/tasks/breath/enqueue', wrap(async (req, res, body) => {
    if (!store || typeof store.enqueueTask !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const type = String(body.type || 'like');
    const accountId = body.accountId ? String(body.accountId) : null;
    const platform = String(body.platform || 'ichigo');
    const nextWakeAt = Number(body.nextWakeAt) || (Date.now() + Number(body.delayMs) + 0);
    const payload = body.payload || {};
    const row = store.enqueueTask({
      platform, accountId, type, payload, priority: Number(body.priority) || 0,
      taskId: body.taskId || null
    });
    // 写 004 呼吸列（nextWakeAt/breathRuleId/claimedAt/claimToken）
    if (row) {
      try {
        const db = store.db;
        const breathRuleId = body.breathRuleId || ('default:' + (body.pool || 'warmup'));
        db.prepare(
          "UPDATE TaskQueue SET nextWakeAt = ?, breathRuleId = ?, claimedAt = 0, claimToken = NULL WHERE taskId = ?"
        ).run(nextWakeAt, breathRuleId, row.taskId);
      } catch (e) {
        return json(res, 200, { ok: true, enqueued: row.taskId, note: '入队成功，但呼吸列写入失败: ' + e.message });
      }
    }
    return json(res, 200, { ok: true, taskId: row ? row.taskId : null, nextWakeAt, type, accountId });
  }));
  // 呼吸规则种子（GovernanceRule scene 维度，缺则插默认；幂等）
  register('POST', '/api/console/tasks/breath/rules/seed', wrap(async (req, res, body) => {
    if (!store || !store.db) return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const db = store.db;
    const scenes = (body.scenes && Array.isArray(body.scenes)) ? body.scenes : ['like', 'footprint', 'first_msg', 'recruit_post', 'delete_post', 'exception'];
    const pool = String(body.pool || 'warmup');
    const defaults = {
      'like': { preFixedWaitMs: 3000, preRandomMinMs: 2000, preRandomMaxMs: 8000, postFixedWaitMs: 5000, postRandomMinMs: 3000, postRandomMaxMs: 10000 },
      'footprint': { preFixedWaitMs: 5000, preRandomMinMs: 4000, preRandomMaxMs: 15000, postFixedWaitMs: 8000, postRandomMinMs: 5000, postRandomMaxMs: 18000 },
      'first_msg': { preFixedWaitMs: 6000, preRandomMinMs: 5000, preRandomMaxMs: 20000, postFixedWaitMs: 10000, postRandomMinMs: 8000, postRandomMaxMs: 25000 },
      'recruit_post': { preFixedWaitMs: 3600000, preRandomMinMs: 3600000, preRandomMaxMs: 5400000, postFixedWaitMs: 60000, postRandomMinMs: 30000, postRandomMaxMs: 90000 },
      'delete_post': { preFixedWaitMs: 3000, preRandomMinMs: 2000, preRandomMaxMs: 6000, postFixedWaitMs: 4000, postRandomMinMs: 2000, postRandomMaxMs: 8000 },
      'exception': { preFixedWaitMs: 60000, preRandomMinMs: 30000, preRandomMaxMs: 120000, postFixedWaitMs: 60000, postRandomMinMs: 30000, postRandomMaxMs: 180000 }
    };
    let inserted = 0;
    for (const sc of scenes) {
      const spec = defaults[sc] || defaults['like'];
      try {
        // 幂等：已有 (scene,accountGroup) 活跃行则跳过
        const exists = db.prepare(
          "SELECT 1 FROM GovernanceRule WHERE scene = ? AND accountGroup = ? AND status = 'active' LIMIT 1"
        ).get(sc, pool);
        if (exists) continue;
        const now = new Date().toISOString();
        const rid = 'breath_' + sc + '_' + pool;
        db.prepare(
          "INSERT INTO GovernanceRule (ruleId, ruleType, scope, scopeKey, rule, priority, status, effectiveFrom, createdAt, updatedAt, scene, accountGroup, preFixedWaitMs, preRandomMinMs, preRandomMaxMs, postFixedWaitMs, postRandomMinMs, postRandomMaxMs) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
        ).run(
          rid, 'breath', 'scene', sc, JSON.stringify(spec), 50, 'active', now, now, now,
          sc, pool,
          spec.preFixedWaitMs, spec.preRandomMinMs, spec.preRandomMaxMs, spec.postFixedWaitMs, spec.postRandomMinMs, spec.postRandomMaxMs
        );
        inserted++;
      } catch (e) { /* duplicate → 跳过 */ }
    }
    return json(res, 200, { ok: true, inserted, scenes });
  }));
  // 看板数据（来源分布 / 完成情况 / 人工介入提醒 high_intent）
  register('GET', '/api/console/tasks/breath/board', wrap(async (req, res) => {
    if (!store || !store.db) return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const db = store.db;
    const byType = db.prepare("SELECT type, status, COUNT(*) n FROM TaskQueue GROUP BY type, status").all();
    const highIntent = db.prepare("SELECT taskId, accountId, payload, createdAt FROM TaskQueue WHERE type='exception' AND status='pending' ORDER BY priority DESC, createdAt ASC").all();
    const recent = db.prepare("SELECT taskId, accountId, type, status, finishedAt, error FROM TaskQueue ORDER BY updatedAt DESC LIMIT 30").all();
    let results = [];
    try { results = db.prepare("SELECT idempotencyKey, taskId, accountId, httpStatus, executedByNode, executedAt FROM TaskResult ORDER BY executedAt DESC LIMIT 30").all(); } catch (_) {}
    let engine = null;
    if (breathEngine) engine = breathEngine.status();
    return json(res, 200, { ok: true, byType, highIntent, recent, results, engine });
  }));
  register('POST', '/api/console/tasks', wrap(async (req, res, body) => {
    if (!store || typeof store.enqueueTask !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const b = body || {};
    if (!b.type) return json(res, 400, { ok: false, reason: 'missing-type' });
    const row = store.enqueueTask(b);
    row.payload = row.payload ? JSON.parse(row.payload) : null;
    return json(res, 200, { ok: true, task: row });
  }));
  register('POST', '/api/console/tasks/dispatch', wrap(async (req, res, body) => {
    if (!store || typeof store.claimTask !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const b = body || {};
    // 跨账号分发：领某账号下一任务（pending → assigned）
    const task = store.claimTask(b.accountId || null, b.platform || 'ichigo');
    if (!task) return json(res, 200, { ok: true, assigned: false, note: '无可分配任务' });
    task.payload = task.payload ? JSON.parse(task.payload) : null;
    return json(res, 200, { ok: true, assigned: true, task });
  }));
  register('POST', '/api/console/tasks/:id/finish', wrap(async (req, res, body) => {
    if (!store || typeof store.finishTask !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const params = req.params || {};
    const b = body || {};
    const row = store.finishTask(params.id ? String(params.id) : '', !!b.ok, b.error || null);
    return json(res, 200, { ok: true, task: row });
  }));

    // ---- 未读轮询器（v5.3 批2：非秒回，发现新未读 → 待跟进） ----
  register('GET', '/api/console/poller', wrap(async (req, res) => {
    if (!deps.unreadPoller) return json(res, 501, { ok: false, reason: 'poller-not-injected' });
    const snap = deps.unreadPoller.snapshot();
    return json(res, 200, { ok: true, poller: snap });
  }));
  register('POST', '/api/console/poller/tick', wrap(async (req, res) => {
    if (!deps.unreadPoller || typeof deps.unreadPoller.tick !== 'function') return json(res, 501, { ok: false, reason: 'poller-not-injected' });
    await deps.unreadPoller.tick();
    return json(res, 200, { ok: true, snapshot: deps.unreadPoller.snapshot() });
  }));

    // ---- 跟进 SOP（v5.3 C 阶段：3 天加ライン，软推进） ----
  register('GET', '/api/console/followup', wrap(async (req, res) => {
    if (!store || typeof store.getFollowupStage !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const qs = queryOf(req);
    const conversationId = qs.conversationId || '';
    if (!conversationId) return json(res, 400, { ok: false, reason: 'missing-conversationId' });
    const stage = store.getFollowupStage(conversationId);
    // 距上条消息天数（从 Message 表取该会话最新一条）
    let daysSinceLast = 0;
    try {
      const m = store.db.prepare('SELECT MAX(createdAt) AS m FROM Message WHERE conversationId = ?').get(conversationId);
      if (m && m.m) daysSinceLast = Math.floor((Date.now() - new Date(m.m).getTime()) / 86400000);
    } catch (_) { daysSinceLast = 0; }
    const ctx = { stage, daysSinceLast, name: qs.name || 'あなた' };
    const result = followupSop.generate(ctx);
    // SOP 规则表（供前端/审计）
    const sops = store.listFollowupSops ? store.listFollowupSops({ platform: qs.platform || undefined }) : [];
    return json(res, 200, {
      ok: true,
      conversationId, stage, daysSinceLast,
      decision: result.decision,
      recommended: result.recommended,
      talks: result.talks,
      sops: sops.map(s => ({ stage: s.stage, afterDays: s.afterDays, actionKind: s.actionKind, note: s.note })),
      note: '参考话术（LINE 一律 ライン 软推进，不直接说 LINE 品牌）；发送仍走 建议→确认→执行 铁律',
    });
  }));
  register('POST', '/api/console/followup/stage', wrap(async (req, res, body) => {
    if (!store || typeof store.setFollowupStage !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const b = body || {};
    if (!b.conversationId) return json(res, 400, { ok: false, reason: 'missing-conversationId' });
    const stage = store.setFollowupStage(b.conversationId, b.stage);
    return json(res, 200, { ok: true, conversationId: b.conversationId, stage });
  }));
  register('POST', '/api/console/followup/sop', wrap(async (req, res, body) => {
    if (!store || typeof store.upsertFollowupSop !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const b = body || {};
    const row = store.upsertFollowupSop(b);
    return json(res, 200, { ok: true, sop: row });
  }));

    // ===========================================================================
  // v5.3 · 运营工具箱（备忘录 / 日历 / 模板库）——独立不碰客户数据，挂 store
  // ===========================================================================
  // ---- 备忘录 ----
  register('GET', '/api/console/memos', wrap(async (req, res) => {
    if (!store || typeof store.listMemos !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const qs = queryOf(req);
    const rows = store.listMemos(qs.accountId || null, { contactId: qs.contactId || undefined, kind: qs.kind || undefined });
    return json(res, 200, { ok: true, count: rows.length, memos: rows });
  }));
  register('POST', '/api/console/memos', wrap(async (req, res, body) => {
    if (!store || typeof store.upsertMemo !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const b = body || {};
    if (!b.title && !b.body) return json(res, 400, { ok: false, reason: 'missing-title-or-body' });
    const row = store.upsertMemo(b.accountId || null, b);
    return json(res, 200, { ok: true, memo: row });
  }));
  register('POST', '/api/console/memos/:id/delete', wrap(async (req, res, body) => {
    if (!store || typeof store.deleteMemo !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const params = req.params || {};
    const ok = store.deleteMemo(params.id ? String(params.id) : '');
    return json(res, 200, { ok, deleted: ok });
  }));
  // ---- 日历 ----
  register('GET', '/api/console/calendar', wrap(async (req, res) => {
    if (!store || typeof store.dueCalendarEvents !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const qs = queryOf(req);
    const until = qs.until || new Date().toISOString();
    const rows = store.dueCalendarEvents(qs.accountId || null, until);
    return json(res, 200, { ok: true, count: rows.length, events: rows });
  }));
  register('POST', '/api/console/calendar', wrap(async (req, res, body) => {
    if (!store || typeof store.upsertCalendarEvent !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const b = body || {};
    if (!b.scheduledAt) return json(res, 400, { ok: false, reason: 'missing-scheduledAt' });
    const row = store.upsertCalendarEvent(b.accountId || null, b);
    return json(res, 200, { ok: true, event: row });
  }));
  register('POST', '/api/console/calendar/:id/done', wrap(async (req, res, body) => {
    if (!store || typeof store.completeCalendarEvent !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const params = req.params || {};
    const ok = store.completeCalendarEvent(params.id ? String(params.id) : '');
    return json(res, 200, { ok, done: ok });
  }));
  // ---- 模板库 ----
  register('GET', '/api/console/phrase-library', wrap(async (req, res) => {
    if (!store || typeof store.listPhrases !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const qs = queryOf(req);
    const rows = store.listPhrases({
      scene: qs.scene || undefined,
      accountId: qs.accountId || undefined,
      platform: qs.platform || undefined,
      lang: qs.lang || undefined,
    });
    return json(res, 200, { ok: true, count: rows.length, phrases: rows });
  }));
  register('POST', '/api/console/phrase-library', wrap(async (req, res, body) => {
    if (!store || typeof store.upsertPhrase !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const b = body || {};
    if (!b.content) return json(res, 400, { ok: false, reason: 'missing-content' });
    const row = store.upsertPhrase(b);
    return json(res, 200, { ok: true, phrase: row });
  }));
  register('POST', '/api/console/phrase-library/:id/use', wrap(async (req, res, body) => {
    if (!store || typeof store.bumpPhraseUsage !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const params = req.params || {};
    store.bumpPhraseUsage(params.id ? String(params.id) : '');
    return json(res, 200, { ok: true });
  }));

    register('GET', '/api/console/bbs/cooldown', wrap(async (req, res) => {
    if (!store || typeof store.getEffectiveRules !== 'function') {
      return json(res, 501, { ok: false, reason: 'store-not-ready', msg: 'store 未就绪' });
    }
    const nowIso = new Date().toISOString();
    const rules = store.getEffectiveRules({ platform: 'ichigo' }).rules || [];
    const cd = rules.find(function (r) { return r.ruleId === 'bbs-post-cooldown' || (r.ruleType === 'rateLimit' && r.rule && String(r.rule).indexOf('bbsPostCooldown') !== -1); });
    if (!cd) {
      return json(res, 200, { ok: true, found: false, note: 'bbs-post-cooldown 规则未落库（跑 migrate + 重启服务落库，或 POST 本端点）' });
    }
    let spec = {};
    try { spec = JSON.parse(String(cd.rule || '{}')); } catch (_) { spec = {}; }
    // 算冷却剩余（从 BBS 操作日志取 lastBbsOpAt；没有则 unknown）
    let inCooldown = false, cooldownRemainingSec = null, lastBbsOpAt = null;
    try {
      const logs = store.db ? store.db.prepare("SELECT MAX(createdAt) as m FROM SentLog WHERE accountId LIKE '%ichigo%' LIMIT 1").get() : null;
      if (logs && logs.m) {
        lastBbsOpAt = logs.m;
        const elapsed = Math.floor((Date.now() - new Date(logs.m).getTime()) / 1000);
        const cool = (spec.cooldownMinutes || 60) * 60;
        if (elapsed < cool) { inCooldown = true; cooldownRemainingSec = cool - elapsed; }
      }
    } catch (_) { /* 日志表缺则 unknown */ }
    return json(res, 200, {
      ok: true, found: true,
      ruleId: cd.ruleId,
      cooldownMinutes: spec.cooldownMinutes || 60,
      status: cd.status,
      lastBbsOpAt: lastBbsOpAt,
      inCooldown: inCooldown,
      cooldownRemainingSec: cooldownRemainingSec
    });
  }));

  // POST /api/console/bbs/cooldown  模块3 · 落库/更新 BBS 1h 冷却规则（weak：配置操作，非强副作用）
  //   body: { cooldownMinutes? }（缺省 60）；幂等，已存在则跳过
  register('POST', '/api/console/bbs/cooldown', wrap(async (req, res, body) => {
    if (!store || typeof store.ensureBbsCooldownRule !== 'function') {
      return json(res, 501, { ok: false, reason: 'store-not-ready', msg: 'store 未就绪或无 ensureBbsCooldownRule' });
    }
    try {
      const r = store.ensureBbsCooldownRule({
        ruleId: 'bbs-post-cooldown',
        cooldownMinutes: (body && body.cooldownMinutes) || 60,
        platform: 'ichigo',
        accountId: process.env.AISAY_ACCOUNT_ID
      });
      return json(res, 200, Object.assign({ ok: true }, r));
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'cooldown-rule-exception', msg: String((e && e.message) || e) });
    }
  }));



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
      if (cached) return json(res, 200, Object.assign({ ok: true, from: 'cache', memberID, contact: cached.profile ? { tid: cached.memberID, name: (cached.profile.fields && cached.profile.fields.name) || '' } : null, profile: cached.profile, recruitPosts: cached.recruitPosts || [], messages: cached.messages, mailID: cached.mailID || mailID }, { cached: cached.cached, scannedAt: cached.fetchedAt }));
    }
    try {
      const r = await happyScanner.scanCustomer(memberID, mailID);
      if (r.ok) {
        if (happyCache) happyCache.upsertCustomer(memberID, r.profile, r.messages, r.mailID || mailID, r.recruitPosts || []);
        return json(res, 200, r);
      }
      // 抓取失败：降级回缓存
      if (happyCache) {
        const cached = happyCache.getCustomer(memberID, { stale: true });
        if (cached) return json(res, 200, Object.assign({ ok: false, from: 'cache-fallback', scanReason: r.reason, memberID, contact: null, profile: cached.profile, recruitPosts: cached.recruitPosts || [], messages: cached.messages, mailID: cached.mailID || mailID }, { stale: true }));
      }
      return json(res, 501, Object.assign({ ok: false }, r));
    } catch (e) {
      if (happyCache) {
        const cached = happyCache.getCustomer(memberID, { stale: true });
        if (cached) return json(res, 200, Object.assign({ ok: false, from: 'cache-exception', reason: 'scan-exception', memberID, profile: cached.profile, recruitPosts: cached.recruitPosts || [], messages: cached.messages }, { stale: true }));
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
  // TODO(自动化引流准入条件)：本路由当前无合规闸门/无频控/无审计（AGENTS §1.1 裁定：现在不给 send-live 加闸门，
  //   留待自动化引流阶段统一接入 talkEngine.checkGate / withinRateLimit / SentLog+GateBlock 审计，复用 006_send_queue 表落库）。
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


  // ==================== 全域 RPA 路由（模块4-8） ====================
  // 基于 2026-10-26 全域 DOM 探测结果（docs/tools/bbs-probe/global-dom-topology.md）
  // 所有路由通过 deepScrape 调度，强副作用需 confirmed=true（前端二次确认）

  // ---------- 模块4 · 足迹反撩（只读） ----------
  register('GET', '/api/console/domain/ashiato', wrap(async (req, res) => {
    if (!deepScrape || typeof deepScrape.fetchAshiato !== 'function') {
      return json(res, 501, { ok: false, reason: 'ashiato-scraper-not-injected', msg: 'deepScrape not injected' });
    }
    const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const opts = {};
    const maxItems = qs.get('maxItems');
    if (maxItems) opts.maxItems = parseInt(maxItems, 10);
    const direction = qs.get('direction') || 'received'; // received | mine
    opts.direction = direction;
    const maxPages = qs.get('maxPages');
    if (maxPages) opts.maxPages = parseInt(maxPages, 10);
    try {
      const r = await deepScrape.fetchAshiato(opts);
      if (!r || !r.ok) {
        if (r && r.reason === 'empty') return json(res, 200, Object.assign({ ok: true, footmarks: [], direction: direction }, r));
        return json(res, 501, Object.assign({ ok: false, direction: direction }, r));
      }
      return json(res, 200, Object.assign({ ok: true, direction: direction }, r));
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'ashiato-exception', msg: String((e && e.message) || e) });
    }
  }));

  // ---------- 模块5 · 找对象页会员列表（只读） ----------
  register('GET', '/api/console/domain/faces', wrap(async (req, res) => {
    if (!deepScrape || typeof deepScrape.fetchFaces !== 'function') {
      return json(res, 501, { ok: false, reason: 'faces-scraper-not-injected', msg: 'deepScrape 未注入' });
    }
    const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const opts = {};
    const maxItems = qs.get('maxItems');
    if (maxItems) opts.maxItems = parseInt(maxItems, 10);
    try {
      const r = await deepScrape.fetchFaces(opts);
      if (!r || !r.ok) {
        if (r && r.reason === 'empty') return json(res, 200, Object.assign({ ok: true, members: [] }, r));
        return json(res, 501, Object.assign({ ok: false }, r));
      }
      return json(res, 200, Object.assign({ ok: true }, r));
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'faces-exception', msg: String((e && e.message) || e) });
    }
  }));

  // ---------- 模块5 · 高级搜索（强副作用，需 confirmed） ----------
  register('POST', '/api/console/domain/search', wrap(async (req, res, body) => {
    if (!deepScrape || typeof deepScrape.runProfileSearch !== 'function') {
      return json(res, 501, { ok: false, reason: 'search-scraper-not-injected', msg: 'deepScrape 未注入' });
    }
    const opts = body && body.opts ? body.opts : (body || {});
    try {
      const r = await deepScrape.runProfileSearch(opts);
      if (!r || !r.ok) {
        if (r && r.reason === 'not-confirmed') return json(res, 403, Object.assign({ ok: false }, r));
        if (r && r.reason === 'cdp-unavailable') return json(res, 501, Object.assign({ ok: false }, r));
        return json(res, 500, Object.assign({ ok: false }, r));
      }
      return json(res, 200, Object.assign({ ok: true }, r));
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'search-exception', msg: String((e && e.message) || e) });
    }
  }));

  // ---------- 模块6 · 忽略/解除忽略 ----------
  register('POST', '/api/console/domain/ignore', wrap(async (req, res, body) => {
    if (!deepScrape || typeof deepScrape.manageIgnore !== 'function') {
      return json(res, 501, { ok: false, reason: 'ignore-scraper-not-injected', msg: 'deepScrape 未注入' });
    }
    const opts = body && body.opts ? body.opts : (body || {});
    try {
      const r = await deepScrape.manageIgnore(opts);
      if (!r || !r.ok) {
        if (r && r.reason === 'not-confirmed') return json(res, 403, Object.assign({ ok: false }, r));
        if (r && r.reason === 'cdp-unavailable') return json(res, 501, Object.assign({ ok: false }, r));
        if (r && r.reason === 'empty') return json(res, 200, Object.assign({ ok: true, ignoredMemberIds: [] }, r));
        return json(res, 500, Object.assign({ ok: false }, r));
      }
      return json(res, 200, Object.assign({ ok: true }, r));
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'ignore-exception', msg: String((e && e.message) || e) });
    }
  }));

  // ---------- 模块7 · 日历会える日 ----------
  register('POST', '/api/console/domain/calendar', wrap(async (req, res, body) => {
    if (!deepScrape || typeof deepScrape.manageCalendar !== 'function') {
      return json(res, 501, { ok: false, reason: 'calendar-scraper-not-injected', msg: 'deepScrape 未注入' });
    }
    const opts = body && body.opts ? body.opts : (body || {});
    try {
      const r = await deepScrape.manageCalendar(opts);
      if (!r || !r.ok) {
        if (r && r.reason === 'not-confirmed') return json(res, 403, Object.assign({ ok: false }, r));
        if (r && r.reason === 'cdp-unavailable') return json(res, 501, Object.assign({ ok: false }, r));
        return json(res, 500, Object.assign({ ok: false }, r));
      }
      return json(res, 200, Object.assign({ ok: true }, r));
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'calendar-exception', msg: String((e && e.message) || e) });
    }
  }));

  // ---------- 模块8 · 日记发布/删除 ----------
  register('POST', '/api/console/domain/diary', wrap(async (req, res, body) => {
    if (!deepScrape || typeof deepScrape.manageDiary !== 'function') {
      return json(res, 501, { ok: false, reason: 'diary-scraper-not-injected', msg: 'deepScrape 未注入' });
    }
    const opts = body && body.opts ? body.opts : (body || {});
    try {
      const r = await deepScrape.manageDiary(opts);
      if (!r || !r.ok) {
        if (r && r.reason === 'not-confirmed') return json(res, 403, Object.assign({ ok: false }, r));
        if (r && r.reason === 'cdp-unavailable') return json(res, 501, Object.assign({ ok: false }, r));
        return json(res, 500, Object.assign({ ok: false }, r));
      }
      return json(res, 200, Object.assign({ ok: true }, r));
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'diary-exception', msg: String((e && e.message) || e) });
    }
  }));


  // ---------- 模块9 · 全域运营：线索排序器（纯函数，喂候选返回排好序列表） ----------
  // POST /api/console/domain/rank { candidates: [{ cat, online:{iconClass,label}, ... }] }
  //   返回 { ok, ranked: [按 P1~P6 类别 × 在线档 排好的候选], catCount, tierDist }
  register('POST', '/api/console/domain/rank', wrap(async (req, res, body) => {
    if (typeof domainRank.rankCandidates !== 'function') {
      return json(res, 501, { ok: false, reason: 'domain-rank-not-injected', msg: 'domainRank.js 未就绪' });
    }
    var DomainRank = domainRank;
    const candidates = Array.isArray(body && body.candidates) ? body.candidates : [];
    if (candidates.length === 0) {
      return json(res, 200, { ok: true, ranked: [], catCount: 0, tierDist: {} });
    }
    try {
      const ranked = DomainRank.rankCandidates(candidates);
      // 统计类别分布 + 在线档分布（前端展示用）
      const tierDist = {};
      const catCount = {};
      ranked.forEach(function(c) {
        tierDist[c.onlineTier] = (tierDist[c.onlineTier] || 0) + 1;
        catCount[c.cat] = (catCount[c.cat] || 0) + 1;
      });
      return json(res, 200, { ok: true, ranked: ranked, catCount: catCount, tierDist: tierDist, total: ranked.length });
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'rank-exception', msg: String((e && e.message) || e) });
    }
  }));


  // ---------- 模块9 · 正在聊（P1 最高价值，收件箱未读） ----------
  register('GET', '/api/console/domain/chat', wrap(async (req, res) => {
    if (!deepScrape || typeof deepScrape.fetchChatInbox !== 'function') {
      return json(res, 501, { ok: false, reason: 'chat-scraper-not-injected', msg: 'deepScrape 未注入' });
    }
    const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const opts = {};
    const maxItems = qs.get('maxItems');
    if (maxItems) opts.maxItems = parseInt(maxItems, 10);
    try {
      const r = await deepScrape.fetchChatInbox(opts);
      if (!r || !r.ok) {
        if (r && r.reason === 'empty') return json(res, 200, Object.assign({ ok: true, chats: [] }, r));
        return json(res, 501, Object.assign({ ok: false }, r));
      }
      return json(res, 200, Object.assign({ ok: true }, r));
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'chat-exception', msg: String((e && e.message) || e) });
    }
  }));

  // ---------- 模块9 · 点赞待回（P2 タイプされた列表） ----------
  register('GET', '/api/console/domain/like', wrap(async (req, res) => {
    if (!deepScrape || typeof deepScrape.fetchTypedLikes !== 'function') {
      return json(res, 501, { ok: false, reason: 'like-scraper-not-injected', msg: 'deepScrape 未注入' });
    }
    const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const opts = {};
    const maxItems = qs.get('maxItems');
    if (maxItems) opts.maxItems = parseInt(maxItems, 10);
    const tab = qs.get('tab') || 'received'; // received | sent | mutual
    opts.tab = tab;
    try {
      const r = await deepScrape.fetchTypedLikes(opts);
      if (!r || !r.ok) {
        if (r && r.reason === 'empty') return json(res, 200, Object.assign({ ok: true, likes: [], tab: tab }, r));
        return json(res, 501, Object.assign({ ok: false }, r));
      }
      return json(res, 200, Object.assign({ ok: true, tab: tab }, r));
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'like-exception', msg: String((e && e.message) || e) });
    }
  }));

  // ---------- 卡片交互原型 · 真实候选聚合（P1 正在聊 + P2 互赞，纯只读）----------
  // GET /api/console/card-leads?maxLikes=30&maxChats=30
  // 合并 deepScrape.fetchChatInbox + fetchTypedLikes(mutual)，富化 chat lastMsg/lastTime
  // + P1~P6 在线档排序（domainRank），输出 cards[] 供 /card-deck 前端消费。
  // 全部只读：不发消息、不写库、不改 DOM；仅调只读 CDP 表达式。
  register('GET', '/api/console/card-leads', wrap(async (req, res) => {
    const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const cards = [];
    let leadCount = 0, leadErr = null;
    // 模式选择: ?inbox=1 → 收件箱未读 + 最近活跃(二次筛选, 不灌全量 Lead 池); 默认(无参) → 同 inbox=1(用户裁定: 主候选=该动手的)
    // 只有 ?leads=1 显式才带全量 Lead 池(大批量线索补全用)
    const wantsInbox = (qs.get('inbox') || '1') !== '0';   // 默认走收件箱模式
    const wantsLeads = qs.get('leads') === '1';             // 显式才全量 Lead
    // 基底：Lead 线索池（仅 wantsLeads=1 时灌; 否则走收件箱未读 + 最近活跃）
    if (wantsInbox && !wantsLeads) {
      // 卡片流候选(用户裁定 Q1): 收件箱未读 + 最近 7 天有互动(不管新老客户)。
      // 数据源: ① 有 Message 记录的 Contact(最近互动) ② Lead 池里 sourceDim=like/footprint 的互动线索。
      // Contact 表无 accountId/contactKey 列(M0 归一化身份), 用 displayName+contactId 去重。
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
        // ① 未回复会话(第4点裁定): 该会话最后一条 Message.role='other'(对方发的) → 我还没回复,
        //    不随"点开=已读"清零。数据源 Conversation + Message(MAX seq 那条的 role)。
        let recentRows = [];
        if (store && store.db) {
          try {
            // 未回复口径: ① 最后一条 Message.role='other'(对方发的, 我还没回) 或 ② Conversation.unread>0(收件箱未读)。
            // UNION 双源 —— Message 表数据少时靠 unread 兜底; 点开客户页只清 unread 标记, 不删"未回复"判定(看最后一条方向)。
            // 未回复双源: ① 会话最后一条 Message.role='other'(对方发的我还没回) ② Conversation.unread>0(收件箱未读)。
            // UNION 合并, 不随"点开客户页"清零(看的是消息方向+未读数, 非"已读"动作)。
            recentRows = store.db.prepare(
              "SELECT u.convId AS convId, u.contactId, c.displayName AS name " +
              "FROM ( " +
              "  SELECT cv.conversationId AS convId, cv.contactId " +
              "  FROM Conversation cv " +
              "  JOIN (SELECT conversationId, MAX(seq) AS lastSeq FROM Message GROUP BY conversationId) lm ON lm.conversationId = cv.conversationId " +
              "  JOIN Message m ON m.conversationId = lm.conversationId AND m.seq = lm.lastSeq WHERE m.role = 'other' " +
              "  UNION " +
              "  SELECT cv.conversationId AS convId, cv.contactId FROM Conversation cv WHERE cv.unread > 0 " +
              ") u LEFT JOIN Contact c ON c.contactId = u.contactId " +
              "ORDER BY c.displayName LIMIT ?"
            ).all(parseInt(qs.get('maxChats') || '30', 10));
          } catch (_) {
            // 降级: 最近 7 天有消息的 Contact(不依赖 role 判定)
            try {
              recentRows = store.db.prepare(
                "SELECT c.contactId, c.displayName AS name, c.updatedAt AS lastAt " +
                "FROM Contact c WHERE c.updatedAt >= ? ORDER BY c.updatedAt DESC LIMIT ?"
              ).all(sevenDaysAgo, parseInt(qs.get('maxChats') || '30', 10));
            } catch (__) { recentRows = []; }
          }
        }
        // ② Lead 池互动线索(sourceDim like/footprint = 真互动过的, 二次筛选; 非全量 290 条)
        let leadRows = [];
        if (store && typeof store.listLeads === 'function') {
          try {
            const allLeads = store.listLeads({ platform: 'ichigo' }, { limit: parseInt(qs.get('maxLeads') || '100', 10) });
            leadRows = (Array.isArray(allLeads) ? allLeads : [])
              .filter(ld => ld.sourceDim === 'like' || ld.sourceDim === 'ashiato' || ld.sourceDim === 'footprint')
              .slice(0, parseInt(qs.get('maxChats') || '30', 10));
          } catch (_) { leadRows = []; }
        }
        // 合并去重(displayName 优先, 有资料卡 sourceHref 的 Lead 优先)
        const seen = new Set();
        const pick = function(name, tag, extra) {
          const k = String(name || '').trim();
          if (!k || seen.has(k)) return;
          seen.add(k);
          cards.push(Object.assign({
            id: (tag === 'lead' ? 'LD-' : (tag === 'profile' ? 'PF-' : 'IN-')) + k.slice(0, 8),
            cat: tag, source: tag === 'lead' ? '互动线索' : (tag === 'profile' ? '已抓资料(资料池)' : '最近活跃'),
            name: k, age: '', city: '',
            onlineIcon: null, onlineLabel: '',
            memberId: null, contactId: null, sourceHref: null,
            lastMsg: '', lastMsgZh: '', lastTime: '',
            selfIntro: '', interests: [], avatarUrls: [],
            ai: null, state: 'PENDING', selectedTalk: null, tags: [], opLog: [],
            platform: 'ichigo', noRevoke: true, fromInbox: true,
          }, extra || {}));
        };
        // ③ 资料池已抓取资料卡的客户(用户 2026-11-11 裁定: 挪进卡片流)
        let profileRows = [];
        if (store && store.db) {
          try {
            profileRows = store.db.prepare(
              "SELECT profileId, name, age, region, contactId, sourceDim, extras FROM Profile " +
              "WHERE crawlStatus = 'done' AND name IS NOT NULL AND name != '' AND platform = 'ichigo' LIMIT 100"
            ).all();
          } catch (_) { profileRows = []; }
        }
        (profileRows || []).forEach(function(pr) {
          var extra = {
            contactId: pr.contactId || null,
            sourceHref: null,
            age: pr.age != null ? String(pr.age) : '',
            city: pr.region || '',
            selfIntro: '',
            interests: [],
            avatarUrls: [],
            fromProfilePool: true,
          };
          try {
            var ex = pr.extras ? JSON.parse(pr.extras) : {};
            extra.sourceHref = ex.profileUrl || ex.profileHref || null;
            if (ex.avatarUrl) extra.avatarUrls = [ex.avatarUrl];
            if (Array.isArray(ex.interests)) extra.interests = ex.interests;
            else if (Array.isArray(ex.interestIcons)) extra.interests = ex.interestIcons.map(function(x){return (x&&x.label)||'';}).filter(Boolean);
            if (ex.selfIntro) extra.selfIntro = ex.selfIntro;
            if (ex.regionFull) extra.city = ex.regionFull;
          } catch (_) {}
          pick(pr.name, 'profile', extra);
        });
        (recentRows || []).forEach(function(r) {
          // 补上下文: 资料卡链接 + 该会话最近 5 条消息(assistant 生成话术的上下文), 不用 CDP 实时抓
          var ctxExtra = { contactId: r.contactId || null, conversationId: r.convId || null, lastTime: r.lastAt || '', notReplied: true };
          try {
            if (r.convId && store && store.db) {
              var convRow = store.db.prepare('SELECT profileUrl, historyUrl FROM Conversation WHERE conversationId = ?').get(r.convId);
              if (convRow && convRow.profileUrl) ctxExtra.sourceHref = convRow.profileUrl;
            }
            if (r.convId && store && store.db) {
              var msgs = store.db.prepare(
                "SELECT role, original, translation FROM Message WHERE conversationId = ? ORDER BY seq DESC LIMIT 5"
              ).all(r.convId).reverse();
              ctxExtra.chatHistory = msgs.map(function(mg) {
                return { who: mg.role === 'other' ? 'peer' : 'me', text: mg.original || '', zh: mg.translation || '' };
              });
            }
            // 客户画像(ContactProfile)补 interests/职业/地区(真实列), 头像/简介走 Conversation 兜底
            if (r.contactId && store && store.db) {
              try {
                var prof = store.db.prepare('SELECT age, region, occupation, interests, height FROM ContactProfile WHERE contactId = ?').get(r.contactId);
                if (prof) {
                  ctxExtra.interests = prof.interests ? (typeof prof.interests === 'string' ? (function(){try{var a=JSON.parse(prof.interests);return Array.isArray(a)?a:[];}catch(_){return [];}})() : (Array.isArray(prof.interests)?prof.interests:[])) : [];
                  if (prof.occupation) ctxExtra.occupation = prof.occupation;
                  if (prof.region) ctxExtra.city = prof.region;
                  if (prof.age != null) ctxExtra.age = String(prof.age);
                  if (prof.height) ctxExtra.height = String(prof.height);
                }
              } catch (_) {}
            }
          } catch (_) { /* 补上下文失败不阻断 */ }
          pick(r.name, 'active', ctxExtra);
        });
        (leadRows || []).forEach(ld => pick(ld.name, 'lead', {
          sourceHref: ld.profileUrl || null, memberId: (ld.extras && ld.extras.memberId) || null,
          lastTime: ld.lastSeen || '', age: ld.age != null ? String(ld.age) : '', city: ld.region || '',
          onlineIcon: ld.online || null,
          selfIntro: ld.selfIntro || '',
          interests: (ld.extras && Array.isArray(ld.extras.interests)) ? ld.extras.interests : [],
          avatarUrls: ld.avatarUrl ? [ld.avatarUrl] : [],
        }));
        
        leadCount = cards.length;
      } catch (e) { leadErr = String((e && e.message) || e); }
    }
    if (wantsLeads) {
    // 基底：Lead 线索池（已灌库，不依赖 CDP 窗口是否开）
    try {
      const leads = (store && typeof store.listLeads === 'function') ? store.listLeads({ platform: 'ichigo' }, { limit: parseInt(qs.get('maxLeads') || '100', 10) }) : [];
      leadCount = Array.isArray(leads) ? leads.length : 0;
      (Array.isArray(leads) ? leads : []).forEach(function(ld, i) {
        cards.push({
          id: 'LD-' + String(ld.leadId || i).slice(-8),
          cat: (ld.sourceDim === 'like' ? 'like' : 'browse'),
          source: ld.sourceDim === 'bbs' ? 'BBS帖子' : (ld.sourceDim === 'ashiato' ? '足迹' : (ld.sourceDim === 'search' ? '检索' : (ld.sourceDim === 'like' ? '点赞' : '线索池'))),
          name: ld.name || '',
          age: ld.age != null ? String(ld.age) : '',
          city: ld.region || '',
          onlineIcon: ld.online || null,
          onlineLabel: '',
          memberId: ld.extras && ld.extras.memberId ? String(ld.extras.memberId) : null,
          sourceHref: ld.profileUrl || null,
          lastMsg: '',
          lastMsgZh: '',
          lastTime: ld.lastSeen || '',
          selfIntro: ld.selfIntro || '',
          interests: (ld.extras && Array.isArray(ld.extras.interests)) ? ld.extras.interests : [],
          avatarUrls: ld.avatarUrl ? [ld.avatarUrl] : [],
          ai: null,
          state: 'PENDING',
          selectedTalk: null,
          tags: [],
          opLog: [],
          platform: 'ichigo',
          noRevoke: true,
          fromLead: true,
        });
      });
    } catch (e) { leadErr = String((e && e.message) || e); }
    }
    // CDP 实时补全: 仅 ?cdp=1 显式开启时跑(默认纯 DB 出候选, 不'先爬取再展示'; 资料卡走'精细爬取'手动补)
    if (qs.get('cdp') === '1') {
          // CDP 实时 P2 互赞（窗口开了才抓；抓到则补 seenKeys 去重，避免与 Lead 重复）
          const seenKeys = new Set();
          cards.forEach(function(c) {
            seenKeys.add(c.memberId ? ('m/' + c.memberId) : ('n/' + c.name + '/' + c.age + '/' + c.city + '/' + c.cat));
          });
          if (typeof deepScrape.fetchTypedLikes === 'function') {
            try {
              const likeR = await deepScrape.fetchTypedLikes({ tab: 'mutual', maxItems: parseInt(qs.get('maxLikes') || '30', 10) });
              if (likeR && likeR.ok && Array.isArray(likeR.likes)) {
                likeR.likes.forEach(function(lk, idx) {
                  const k = lk.memberId ? ('m/' + lk.memberId) : ('n/' + (lk.name||'') + '/' + (lk.age||'') + '/' + (lk.city||'') + '/like');
                  if (seenKeys.has(k)) return;
                  seenKeys.add(k);
                  cards.push({
                    id: 'L2-mutual-' + idx, cat: 'like', source: lk.tab === 'mutual' ? '互赞' : '点赞',
                    name: lk.name || '', age: lk.age || '', city: lk.city || '',
                    onlineIcon: lk.onlineIcon || null, onlineLabel: lk.time ? ('互赞 ' + lk.time) : '',
                    memberId: lk.memberId || null, sourceHref: lk.profileUrl || lk.sourceHref || null,
                    lastMsg: '', lastMsgZh: '', lastTime: lk.time || '',
                    selfIntro: lk.selfIntro || '', interests: Array.isArray(lk.interests) ? lk.interests : [],
                    avatarUrls: Array.isArray(lk.avatars) ? lk.avatars : (lk.avatar ? [lk.avatar] : []),
                    ai: null, state: 'PENDING', selectedTalk: null, tags: [], opLog: [],
                    platform: 'ichigo', noRevoke: true,
                  });
                });
              }
            } catch (e) { /* CDP 窗口未开 → 降级，不阻断 */ }
          }
          // CDP 实时 P1 正在聊
          if (typeof deepScrape.fetchChatInbox === 'function') {
            try {
              const chatR = await deepScrape.fetchChatInbox({ maxItems: parseInt(qs.get('maxChats') || '30', 10) });
              if (chatR && chatR.ok && Array.isArray(chatR.chats)) {
                chatR.chats.forEach(function(c, idx) {
                  const k = 'n/' + (c.name||'') + '/' + (c.age||'') + '/' + (c.city||'') + '/chat';
                  if (c.name && seenKeys.has(k)) return;
                  if (c.name) seenKeys.add(k);
                  cards.push({
                    id: 'L1-chat-' + idx, cat: 'chat', source: '正在聊',
                    name: c.name || '', age: c.age || '', city: c.city || '',
                    onlineIcon: c.onlineIcon || null, onlineLabel: '', memberId: null,
                    sourceHref: c.link || null, lastMsg: c.lastMsg || '', lastMsgZh: '', lastTime: c.lastTime || '',
                    selfIntro: '', interests: [], avatarUrls: [],
                    ai: null, state: 'PENDING', selectedTalk: null, tags: [], opLog: [],
                    platform: 'ichigo', noRevoke: true,
                  });
                });
              }
            } catch (e) { /* CDP 窗口未开 → 降级 */ }
          }

    }
    // domainRank 排序（P1 chat > P2 like > P6 browse）
    try {
      cards = domainRank.rankCandidates(cards);
    } catch (e) { /* 排序失败保持原序 */ }
    return json(res, 200, {
      ok: true,
      total: cards.length,
      leadCount: leadCount,
      leadErr: leadErr,
      cards: cards,
      note: '默认=收件箱未回复会话+Lead 互动线索(纯 DB, 秒出); ?cdp=1 才补 CDP 实时 P1/P2; 资料卡走精细爬取手动补。',
    });
  }));

  // ---------- 卡片流全链路 · SendQueue + OperationLog + 拉黑/微调/撤出/撤回 (006) ----------
  // POST /api/console/card/send-queue  入队(A~D 选话术, 20s±10s 浮动串行; 不真发, 仅落库排队)
  register('POST', '/api/console/card/send-queue', wrap(async (req, res, body) => {
    if (!store || typeof store.enqueueSend !== 'function') return json(res, 501, { ok: false, reason: 'store-send-queue-not-ready' });
    const b = body || {};
    if (!b.conversationId || !b.talkText) return json(res, 400, { ok: false, reason: 'missing-conversation-or-talk' });
    const q = store.enqueueSend({
      conversationId: String(b.conversationId),
      platform: b.platform || 'ichigo',
      accountId: b.accountId || '',
      contactKey: b.contactKey || null,
      talkText: String(b.talkText),
      talkZh: b.talkZh || null,
      talkIntent: b.talkIntent || null,
      talkConfidence: b.talkConfidence != null ? Number(b.talkConfidence) : null,
    });
    // 审计留痕(§0.2: 发给谁、发什么, 但此刻只是排队不真发)
    if (typeof store.logOperation === 'function') {
      store.logOperation({ conversationId: b.conversationId, platform: b.platform || 'ichigo', accountId: b.accountId || null, opType: 'send', detail: JSON.stringify({ queueId: q.queueId, slotSeq: q.slotSeq, scheduledAt: q.scheduledAt }), result: 'queued' });
    }
    return json(res, 200, { ok: true, queue: q });
  }));

  // GET /api/console/card/send-queue?status=pending&limit=50  队列快照(前端倒计时条读这个)
  register('GET', '/api/console/card/send-queue', wrap(async (req, res) => {
    if (!store || typeof store.listSendQueue !== 'function') return json(res, 501, { ok: false, reason: 'store-send-queue-not-ready' });
    const qs = queryOf(req);
    const status = qs.status || '';
    const limit = qs.limit || 50;
    const rows = store.listSendQueue(status || undefined, limit);
    return json(res, 200, { ok: true, count: rows.length, queue: rows });
  }));

  // POST /api/console/card/send-queue/cancel?id=  撤出队列(发出不晚于取消, 铁律安全)
  register('POST', '/api/console/card/send-queue/cancel', wrap(async (req, res, body) => {
    if (!store || typeof store.cancelSendQueue !== 'function') return json(res, 501, { ok: false, reason: 'store-send-queue-not-ready' });
    const qs = queryOf(req);
    const id = qs.id || (body && body.id) || '';
    if (!id) return json(res, 400, { ok: false, reason: 'missing-id' });
    const row = store.cancelSendQueue(id);
    if (typeof store.logOperation === 'function') {
      store.logOperation({ conversationId: row && row.conversationId, platform: row && row.platform, accountId: row && row.accountId, opType: 'cancel', detail: JSON.stringify({ queueId: id }), result: row ? 'cancelled' : 'not-found' });
    }
    return json(res, 200, { ok: !!row, queue: row || null });
  }));

  // POST /api/console/card/send-queue/revoke?id=  快乐平台撤回(§1.9 窗口最终回收件箱; 强副作用, 仅 happymail)
  register('POST', '/api/console/card/send-queue/revoke', wrap(async (req, res, body) => {
    if (!store || typeof store.getSendQueue !== 'function') return json(res, 501, { ok: false, reason: 'store-send-queue-not-ready' });
    const qs = queryOf(req);
    const id = qs.id || (body && body.id) || '';
    if (!id) return json(res, 400, { ok: false, reason: 'missing-id' });
    const row = store.getSendQueue(id);
    if (!row) return json(res, 404, { ok: false, reason: 'queue-not-found' });
    if (row.platform !== 'happymail') return json(res, 400, { ok: false, reason: 'platform-no-revoke', msg: '出会平台不可撤回(§1.1), 仅快乐平台支持撤回' });
    // 撤回本身要走 happyScanner/happySendExpr.revokeTextMessage(真副作用, 此处标记 revoked; 真撤回由窗口侧执行后回调)
    const up = store.revokeSendQueue(id, body && body.result ? String(body.result) : 'user-revoke');
    if (typeof store.logOperation === 'function') {
      store.logOperation({ conversationId: row.conversationId, platform: row.platform, accountId: row.accountId, opType: 'revoke', detail: JSON.stringify({ queueId: id }), result: 'revoked' });
    }
    return json(res, 200, { ok: true, queue: up });
  }));

  // POST /api/console/card/block { conversationId, platform, accountId, reason? }  2键拉黑(接 ichigoBlockExpr / Contact.blacklisted)
  register('POST', '/api/console/card/block', wrap(async (req, res, body) => {
    if (!store) return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const b = body || {};
    const contactId = b.contactId || b.conversationId;
    if (!contactId) return json(res, 400, { ok: false, reason: 'missing-contact' });
    // 落库: Contact.blacklisted=1(003 批次列)
    try {
      const r = store.db.prepare('UPDATE Contact SET blacklisted=1 WHERE contactId = ?').run(String(contactId));
      const affected = (r && r.changes) ? r.changes : 0;
      if (typeof store.logOperation === 'function') {
        store.logOperation({ conversationId: b.conversationId || contactId, platform: b.platform || 'ichigo', accountId: b.accountId || null, opType: 'block', detail: JSON.stringify({ contactId: contactId, reason: b.reason || 'card-deck 2键拉黑' }), result: affected > 0 ? 'ok' : 'no-contact-row' });
      }
      return json(res, 200, { ok: affected > 0, blocked: affected, contactId: contactId });
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'block-failed', msg: String(e && e.message || e) });
    }
  }));

  // POST /api/console/card/regenerate { conversationId, platform, accountId, intent?, adjustNote? }  4/5键: 调 assistant B v1.1 真生成
  register('POST', '/api/console/card/regenerate', wrap(async (req, res, body) => {
    if (!assistant || typeof assistant.chat !== 'function') return json(res, 501, { ok: false, reason: 'assistant-not-injected' });
    const b = body || {};
    // conversationId 不再必填: 候选可能无 conv id, 用候选自带客户资料当上下文(需求: 资料卡齐了 AI 才有针对性)
    try {
      const intentTag = (b.intent && b.intent !== 'reply') ? ('[意图:' + b.intent + '] ') : '';
      const adjustTag = b.adjustNote ? ('[微调指令:' + b.adjustNote + '] ') : '';
      // 候选客户资料(兴趣/人设/最近消息/资料卡)拼进 prompt —— 即使 Conversation 库没这个客户也有上下文
      let ctxNote = '';
      const cust = b.customer || {};
      if (cust.name || cust.interests || cust.selfIntro) {
        ctxNote = '目标客户: ' + (cust.name || '(未名)') + (cust.age ? ' ' + cust.age : '') + (cust.city ? ' ' + cust.city : '');
        if (Array.isArray(cust.interests) && cust.interests.length) ctxNote += '; 兴趣: ' + cust.interests.join(',');
        if (cust.selfIntro) ctxNote += '; 自我介绍: ' + String(cust.selfIntro).slice(0, 200);
      }
      const history = Array.isArray(b.history) ? b.history.slice(-12) : [];
      const r = await assistant.chat({
        message: (intentTag + adjustTag + ctxNote + '。基于上述客户资料与最近对话, 生成 4 条候选回复话术(日/中双语, 带意图与置信度)')
          .replace(/^[\s。]+/, ''),
        contactId: b.contactId || b.conversationId,
        history: history,
        maxMsgs: 12,
      });
      if (typeof store.logOperation === 'function') {
        store.logOperation({ conversationId: b.conversationId || b.contactId || null, platform: b.platform || 'ichigo', accountId: b.accountId || null, opType: 'regen', detail: JSON.stringify({ intent: b.intent, adjustNote: b.adjustNote, customer: cust.name }), result: r && r.ok !== false ? 'ok' : 'degraded' });
      }
      return json(res, 200, { ok: true, ai: r });
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'regen-failed', msg: String(e && e.message || e) });
    }
  }));

  // ---------- 卡片流增强 · 精细爬取 + 账户人设 + 启动增量 ----------
  // POST /api/console/card/refine-crawl { urls?:[], leadIds?:[], max?:3, intervalMs? }
  // 呼吸式: 对候选客户的资料卡逐个 CDP 抓取(拟人节拍 20-40s 间隔), 抓完 upsertLead 补 Lead.extras(兴趣/身高/收入/职业/人设)。
  // 后台异步跑, 不挡前端操作; 返回立即 + 每 5s 前端可 GET /card/refine-crawl/status 看进度。
  let refineCrawlState = { running: false, done: 0, total: 0, lastError: null, startedAt: null, finishedAt: null };
  register('POST', '/api/console/card/refine-crawl', wrap(async (req, res, body) => {
    if (!deepScrape || typeof deepScrape.fetchProfile !== 'function') return json(res, 501, { ok: false, reason: 'deepscrape-not-injected', msg: '出会深度抓取器未注入(17098 窗口未开?)' });
    if (refineCrawlState.running) return json(res, 409, { ok: false, reason: 'already-running', msg: '精细爬取进行中, 等完再发' });
    const b = body || {};
    // 入队对象: [{ leadId?, name?, url, age?, region? }] —— 候选卡带 sourceHref 的直接用; 没的按 name/memberId 从 Lead 池反查 profileUrl
    let targets = Array.isArray(b.items) ? b.items : [];
    if (targets.length && !targets[0].url && targets[0].sourceHref) targets = targets.map(t => ({ ...t, url: t.sourceHref }));
    const max = Math.min(parseInt(b.max || '5', 10), 10);   // 默认每次 5 个(拟人, 不触发风控)
    targets = targets.slice(0, max);
    if (!targets.length) return json(res, 400, { ok: false, reason: 'no-targets', msg: '没有可爬的目标(候选需带 name 或 sourceHref/资料卡 url)' });
    // 没 url 的按 name/memberId 从 Lead 池反查 profileUrl(二次筛选: 线索池里有资料卡链接的)
    if (store && typeof store.listLeads === 'function') {
      const needUrl = targets.filter(t => !t.url);
      if (needUrl.length) {
        let leadPool = [];
        try {
          const allLeads = store.listLeads({ platform: 'ichigo' }, { limit: 300 });
          leadPool = Array.isArray(allLeads) ? allLeads : [];
        } catch (_) { leadPool = []; }
        needUrl.forEach(function(t) {
          const hit = leadPool.find(function(ld) {
            if (t.memberId && ld.extras && ld.extras.memberId && String(ld.extras.memberId) === String(t.memberId)) return true;
            if (t.name && ld.name && String(t.name).trim() === String(ld.name).trim()) return true;
            return false;
          });
          if (hit && hit.profileUrl) t.url = hit.profileUrl;
        });
      }
    }
    // 启动后台爬取(不阻塞本请求)
    refineCrawlState = { running: true, done: 0, total: targets.length, lastError: null, startedAt: new Date().toISOString(), finishedAt: null };
    (async function() {
      const sleep = function(ms) { return new Promise(r => setTimeout(r, ms)); };
      // 呼吸节拍: 每个间隔 20000 + 0~20000ms 随机(Irwin-Hall 近似), 拟人不抢页
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        if (!t.url) { refineCrawlState.done++; continue; }
        try {
          const prof = await deepScrape.fetchProfile(t.url);
          if (prof && prof.ok !== false) {
            // 抓到的字段 → upsertLead(补 extras)
            const interestArr = (prof.interests && prof.interests.length) ? prof.interests : (Array.isArray(prof.interestIcons) ? prof.interestIcons.map(x => (x && x.label) || x) : []);
            const L = {
              leadId: t.leadId || null,
              platform: 'ichigo', accountId: '17098',
              name: t.name || prof.name || null,
              age: t.age || prof.age || null,
              region: t.region || prof.region || prof.city || null,
              online: null,
              avatarUrl: prof.avatar || prof.avatarUrl || null,
              profileUrl: t.url,
              selfIntro: (prof.selfIntro || prof.intro || '').slice(0, 500) || null,
              sourceDim: 'refine',
              extras: {
                memberId: t.memberId || null,
                interests: interestArr.slice(0, 20),
                height: prof.height || null, income: prof.income || null,
                occupation: prof.occupation || null, style: prof.style || null,
                refineCrawledAt: new Date().toISOString(),
                _raw: JSON.stringify(prof).slice(0, 2000)
              }
            };
            if (store && typeof store.upsertLead === 'function') store.upsertLead(L);
            refineCrawlState.lastError = null;
          } else {
            refineCrawlState.lastError = 'profile-fetch-failed:' + (prof && (prof.reason || prof.msg) || 'unknown');
          }
        } catch (e) {
          refineCrawlState.lastError = String(e && e.message || e);
        }
        refineCrawlState.done++;
        // 非最后一个 → 呼吸间隔
        if (i < targets.length - 1) {
          await sleep(20000 + Math.floor(Math.random() * 20000));
        }
      }
      refineCrawlState.running = false;
      refineCrawlState.finishedAt = new Date().toISOString();
    })();
    return json(res, 200, { ok: true, started: targets.length, interval: '20-40s 呼吸节拍', note: '后台逐个抓资料卡补 Lead.extras, GET /card/refine-crawl/status 看进度' });
  }));

  // GET /api/console/card/refine-crawl/status → 进度
  register('GET', '/api/console/card/refine-crawl/status', wrap(async (req, res) => {
    return json(res, 200, { ok: true, ...refineCrawlState });
  }));

  // POST /api/console/account-persona/crawl { platform?, accountId? } → 抓出会 17098 本账号资料卡 → AccountPersona
  register('POST', '/api/console/account-persona/crawl', wrap(async (req, res, body) => {
    if (!deepScrape || typeof deepScrape.fetchAccountProfile !== 'function') return json(res, 501, { ok: false, reason: 'deepscrape-not-injected' });
    if (!store || typeof store.db !== 'object') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const b = body || {};
    const accountId = b.accountId || '17098';
    try {
      const prof = await deepScrape.fetchAccountProfile();  // ACCOUNT_PROFILE_URL
      if (!prof || prof.ok === false) return json(res, 500, { ok: false, reason: 'account-profile-failed', msg: (prof && (prof.reason || prof.msg)) || '抓取失败' });
      // 存 AccountPersona(人设 = 账号本体资料, 不混客户数据; §-1.3 三要素隔离)
      const personaId = 'persona-' + accountId;
      // fetchAccountProfile 新返回: 账号页标签词解析出的字段(昵称/生日/身高/风格/职业/兴趣/自我介绍…)
      const personaJson = JSON.stringify({
        nickname: prof.nickname || null,
        birth: prof.birth || null,
        displayAge: prof.displayAge || null,
        height: prof.height || null,
        style: prof.style || null,
        bloodType: prof.bloodType || null,
        type: prof.type || null,
        region: prof.region || null,
        status: prof.status || null,
        birthplace: prof.birthplace || null,
        occupation: prof.occupation || null,
        income: prof.income || null,
        zodiac: prof.zodiac || null,
        smoking: prof.smoking || null,
        drinking: prof.drinking || null,
        children: prof.children || null,
        eyes: prof.eyes || null,
        freeTime: prof.freeTime || null,
        prefAge: prof.prefAge || null,
        prefStyle: prof.prefStyle || null,
        threeSize: prof.threeSize || null,
        cup: prof.cup || null,
        dateWant: prof.dateWant || null,
        meetingIntent: prof.meetingIntent || null,
        interests: prof.interests || null,
        selfIntro: prof.selfIntro || null,
        rawText: (prof.rawText || '').slice(0, 2000),
        crawledAt: new Date().toISOString()
      });
      const ts = new Date().toISOString();
      // AccountPersona.accountId 是 FK → Account.accountId(sha1 主键)。先解析真实 accountId;
      // 没有 Account 行(账号池未建)就临时建一条(§-1.1 群控账号池), 保证 FK 成立。
      let realAccId = null;
      try {
        const aRow = store.db.prepare("SELECT accountId FROM Account WHERE label = ? OR accountId = ?").get(accountId, accountId);
        realAccId = aRow ? aRow.accountId : null;
      } catch (_) { realAccId = null; }
      if (!realAccId) {
        try {
          const accId = 'acc-' + accountId;
          store.db.prepare("INSERT INTO Account (accountId, platform, label, status) VALUES (?, ?, ?, 'active') ON CONFLICT(accountId) DO NOTHING").run(accId, 'ichigo', accountId);
          realAccId = accId;
        } catch (e2) { realAccId = accountId; /* FK 未强制时兜底 */ }
      }
      // upsert AccountPersona(personaId 主键, 保留原 createdAt)
      const oldRow = store.db.prepare("SELECT createdAt FROM AccountPersona WHERE personaId = ?").get(personaId);
      const createdKeep = oldRow ? oldRow.createdAt : ts;
      store.db.prepare(
        "INSERT INTO AccountPersona (personaId, accountId, persona, tone, background, targetAudience, taboos, status, createdAt, updatedAt) " +
        "VALUES (?, ?, ?, '', '', '', ?, 'active', ?, ?) " +
        "ON CONFLICT(personaId) DO UPDATE SET persona = excluded.persona, accountId = excluded.accountId, updatedAt = excluded.updatedAt"
      ).run(personaId, realAccId, personaJson, null, createdKeep, ts);
      const saved = store.db.prepare("SELECT * FROM AccountPersona WHERE personaId = ?").get(personaId);
      return json(res, 200, { ok: true, persona: saved, crawled: JSON.parse(personaJson) });
    } catch (e) {
      console.error('[account-persona/crawl] 失败:', e && e.message);
      return json(res, 500, { ok: false, reason: 'crawl-error', msg: String(e && e.message || e) });
    }
  }));

  // POST /api/console/account-persona/randomize { accountId } → 一键随机填写所有资料(养号/测试用; 铁律 0.1: 只改本地人设, 不发平台)
  register('POST', '/api/console/account-persona/randomize', wrap(async (req, res, body) => {
    if (!store || typeof store.db !== 'object') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const b = body || {};
    const accountId = b.accountId || '17098';
    const personaId = 'persona-' + accountId;
    // 随机素材(日本女性养号池; 可后续接"人设库"表)
    var POOL = {
      nickname: ['さくら', 'ゆき', 'はな', 'まり', 'ゆな', 'こころ', 'れい', 'なお', 'みき', 'あおい'],
      displayAge: ['28', '30', '32', '34', '36', '38'],
      birth: ['1988年05月', '1990年03月', '1991年07月', '1989年11月', '1992年02月', '1987年09月'],
      height: ['150～154cm', '155～159cm', '160～164cm', '165～169cm', '145～149cm'],
      style: ['美人系', '癒し系', 'スポーツ系', 'ギャル系', 'エロ系', '清楚系', '巨乳'],
      bloodType: ['A型', 'B型', 'O型', 'AB型'],
      type: ['美人系', '癒し系', 'スポーツ系', '清楚系', 'セクシー系'],
      region: ['三重-津市', '三重-鈴鹿', '三重-四日市', '三重-松阪', '京都-京都', '滋賀-大津', '和歌山-和歌山', '大阪-大阪'],
      status: ['秘密', '付き合っている', '既婚', 'フリー'],
      birthplace: ['三重-津市', '京都-京都', '大阪-大阪', '滋賀-大津', '和歌山-和歌山', '東京-東京'],
      occupation: ['会社員', '公務員', 'サービス', '営業', 'フリーター', 'その他', '自営'],
      income: ['100～300万円', '300～500万円', '500～700万円', '700～1000万円', '1000万円以上'],
      zodiac: ['未設定', ' Cancer', '獅子座', '乙女座', '天秤座', '蠍座', '射手座', '魚座'],
      smoking: ['吸わない', '時々吸う', '禁煙中', '未設定'],
      drinking: ['普通', '弱め', '強い', '飲まない'],
      children: ['未設定', '子供はいない', '一人', '二人'],
      eyes: ['未設定', '二重', '一重'],
      freeTime: ['未設定', '夜', '土日', '毎日'],
      dateWant: ['食事をしたい', '映画を見たい', '散歩したい', 'ドライブ', 'その他'],
      meetingIntent: ['まずは会いたい', '友だちから', '交際から', '未設定'],
      interests: ['映画', '音楽', '料理', '旅行', 'ゴルフ', '写真', '読書', '猫', '犬', '海', '山', '釣り', 'ゲーム', 'アニメ'],
      selfIntro: ['こんにちは、よろしくお願いします。', '趣味は旅行と料理です。', '猫が好きです。よろしくお願いします。', '海と山が好きな、穏やかな性格です。', 'よろしくお願いしますね。']
    };
    function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
    // 读旧 persona, 保留 crawledAt/updatedAt, 其余随机覆盖
    const old = store.db.prepare('SELECT persona, createdAt FROM AccountPersona WHERE personaId = ?').get(personaId);
    let cur = {}; try { cur = old && old.persona ? JSON.parse(old.persona) : {}; } catch (_) { cur = {}; }
    Object.keys(POOL).forEach(function(k) {
      if (k === 'interests') {
        // 兴趣随机 3-5 个
        var n = 3 + Math.floor(Math.random() * 3);
        var arr = POOL.interests.slice();
        var out = [];
        for (var i = 0; i < n && arr.length; i++) { out.push(arr.splice(Math.floor(Math.random() * arr.length), 1)[0]); }
        cur.interests = out.join(',');
      } else {
        cur[k] = pick(POOL[k]);
      }
    });
    cur.crawledAt = new Date().toISOString();
    cur.randomizedAt = new Date().toISOString();
    // upsert
    store.db.prepare(
      'INSERT INTO AccountPersona (personaId, accountId, persona, tone, background, targetAudience, taboos, status, createdAt, updatedAt) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(personaId) DO UPDATE SET persona = excluded.persona, updatedAt = excluded.updatedAt'
    ).run(personaId, accountId, JSON.stringify(cur), '', '', '', '', 'active', old && old.createdAt ? old.createdAt : new Date().toISOString(), new Date().toISOString());
    const row = store.db.prepare('SELECT * FROM AccountPersona WHERE personaId = ?').get(personaId);
    return json(res, 200, { ok: true, persona: row, randomized: cur, note: '已随机填写全部资料(本地人设; 未发平台)。前端可单项改。' });
  }));

  // GET /api/console/account-persona?accountId=17098 → 读账户人设
  register('GET', '/api/console/account-persona', wrap(async (req, res) => {
    if (!store || typeof store.db !== 'object') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const accountId = qs.get('accountId') || '17098';
    const row = store.db.prepare("SELECT * FROM AccountPersona WHERE personaId = ?").get('persona-' + accountId);
    return json(res, 200, { ok: true, accountId: accountId, persona: row || null });
  }));

  // POST /api/console/account-persona/update { accountId, patch } → 一键修改人设(后续增强)
  register('POST', '/api/console/account-persona/update', wrap(async (req, res, body) => {
    if (!store || typeof store.db !== 'object') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const b = body || {};
    const accountId = b.accountId || '17098';
    const personaId = 'persona-' + accountId;
    const old = store.db.prepare("SELECT * FROM AccountPersona WHERE personaId = ?").get(personaId);
    if (!old) return json(res, 404, { ok: false, reason: 'persona-not-found', msg: '先抓取或随机生成一份人设' });
    // 合并 patch: 支持 { field, value } 单项 或 { 字段: 值 } 多项。白名单=parseAccountPersona 全字段 + 兼容旧 name/age
    let cur = {}; try { cur = JSON.parse(old.persona || '{}'); } catch (_) { cur = {}; }
    const allow = ['nickname', 'birth', 'displayAge', 'height', 'style', 'bloodType', 'type', 'region', 'status',
      'birthplace', 'occupation', 'income', 'zodiac', 'smoking', 'drinking', 'children', 'eyes', 'freeTime',
      'prefAge', 'prefStyle', 'threeSize', 'cup', 'dateWant', 'meetingIntent', 'interests', 'selfIntro',
      'name', 'age']; // 兼容旧字段
    if (b.field !== undefined) { // 单项: { field, value }
      if (allow.indexOf(b.field) !== -1) cur[b.field] = b.value;
    } else {
      allow.forEach(k => { if (b[k] !== undefined) cur[k] = b[k]; });
    }
    cur.updatedAt = new Date().toISOString();
    store.db.prepare("UPDATE AccountPersona SET persona = ?, updatedAt = ? WHERE personaId = ?").run(JSON.stringify(cur), cur.updatedAt, personaId);
    const row = store.db.prepare("SELECT * FROM AccountPersona WHERE personaId = ?").get(personaId);
    return json(res, 200, { ok: true, persona: row });
  }));


  // ---------- 模块9 · P2 点赞调试（诊断翻页） ----------
  register('GET', '/api/console/domain/like-debug', wrap(async (req, res) => {
    if (!deepScrape || typeof deepScrape.fetchTypedLikes !== 'function') {
      return json(res, 501, { ok: false, reason: 'like-scraper-not-injected', msg: 'deepScrape 未注入' });
    }
    const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const opts = {};
    const tab = qs.get('tab') || 'received';
    opts.tab = tab;
    opts.maxPages = parseInt(qs.get('maxPages') || '2', 10);
    opts.maxItems = 50;
    // 加诊断日志
    const dbg = [];
    const origEval = console.log;
    try {
      const r = await deepScrape.fetchTypedLikes(opts);
      return json(res, 200, Object.assign({ ok: true, tab: tab, dbg: dbg }, r));
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'like-debug-exception', msg: String((e && e.message) || e) });
    }
  }));

  // ============================================================================
  // 线索池 Lead（005 批次）：引流第一阶段"侦测"统一落点
  // GET /api/console/leads?platform=&sourceDim=&ageFrom=&ageTo=&online=&limit=
  //   - 读 Lead 表（通用字段 + extras JSON 平台特色），支持按平台/来源/年龄/在线筛
  //   - 返回 { ok, count, leads:[...] }，每条含 extras 解析后的 JSON
  // ============================================================================
  register('GET', '/api/console/leads', wrap(async (req, res) => {
    if (!store || typeof store.listLeads !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready', msg: 'store.listLeads 未注入' });
    const qs = queryOf(req);
    const filter = {};
    if (qs.platform) filter.platform = qs.platform;
    if (qs.sourceDim) filter.sourceDim = qs.sourceDim;
    if (qs.accountId) filter.accountId = qs.accountId;
    if (qs.online) filter.online = qs.online;
    if (qs.ageFrom) filter.ageFrom = qs.ageFrom;
    if (qs.ageTo) filter.ageTo = qs.ageTo;
    const limit = Math.min(parseInt(qs.limit || '200', 10), 1000);
    let rows;
    try {
      rows = store.listLeads(filter, { limit: limit });
    } catch (e) {
      return json(res, 500, { ok: false, reason: 'query-failed', msg: String(e && e.message || e) });
    }
    // 解析 extras JSON（容错）
    const leads = (rows || []).map(function (r) {
      var extras = null;
      try { extras = JSON.parse(r.extras || '{}'); } catch (e2) { extras = {}; }
      var o = Object.assign({}, r);
      delete o.extras;
      o.extras = extras;
      return o;
    });
    // 聚合：按 sourceDim 统计（任务汇报用）
    let agg = [];
    if (typeof store.leadBySourceDim === 'function') {
      try { agg = store.leadBySourceDim(filter); } catch (e) { agg = []; }
    }
    return json(res, 200, {
      ok: true,
      count: leads.length,
      leads: leads,
      bySourceDim: agg,
      filters: {
        platform: qs.platform || null,
        sourceDim: qs.sourceDim || null,
        ageFrom: qs.ageFrom || null,
        ageTo: qs.ageTo || null,
        online: qs.online || null,
      },
    });
  }));

  // POST /api/console/leads —— 灌入线索（二期 T1 会用，先占位；body = { leads: [...] }）
  register('POST', '/api/console/leads', wrap(async (req, res, body) => {
    if (!store || typeof store.upsertLead !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const arr = body && Array.isArray(body.leads) ? body.leads : [];
    if (arr.length === 0) return json(res, 200, { ok: true, upserted: 0, msg: 'empty' });
    let upserted = 0;
    for (const L of arr) {
      // 透传 memberId（平台唯一身份），让 upsertLead 按稳定键去重累积
      const r = store.upsertLead(L);
      if (r && r.leadId) { upserted++; autoSyncProfile(r, L); }
    }
    return json(res, 200, { ok: true, upserted: upserted, total: arr.length });
  }));


  // ============================================================================
  // 窗口手动控制（用户 2026-11-02 需求：不自动启停，控制台手动开/关 + 状态图标）
  // GET  /api/console/window/status  → { open, windowId, cdp }
  // POST /api/console/window/open     → 手动启动窗口（/browser/open）
  // POST /api/console/window/close    → 手动关闭窗口（/browser/close）
  // ============================================================================
  function getBit() {
    if (settingsForLive && settingsForLive.bitBrowserApiPort) {
      const { BitBrowserClient } = require(path.join(__dirname, 'bitbrowser.js'));
      return new BitBrowserClient('http://127.0.0.1:' + settingsForLive.bitBrowserApiPort);
    }
    return null;
  }
  function getWindowId() {
    return settingsForLive && settingsForLive.windowId ? String(settingsForLive.windowId) : '';
  }
  // 窗口状态查询（分页扫描 /browser/list，服务端每页上限 100，需翻页找目标 windowId）
  async function findWindowStatus(bit, win) {
    var pageSize = 100;
    for (var page = 0; page < 30; page++) { // 最多扫 3000 个窗口
      const resp = await bit.listBrowsers({ page: page, pageSize: pageSize });
      // BitBrowserClient.call 已解包 .data，resp 本身即 {page,pageSize,totalNum,list}
      const list = Array.isArray(resp.list) ? resp.list : (resp && resp.data && Array.isArray(resp.data.list) ? resp.data.list : []);
      const total = Number((resp.totalNum !== undefined ? resp.totalNum : (resp.data && resp.data.totalNum))) || 0;
      const w = list.find(function(x) { return x && String(x.id || x.uuid || x.seq) === String(win); });
      if (w) {
        return { status: w.status, seq: w.seq, name: w.name, open: (Number(w.status) === 1 || w.isStart === true || w.startup === true || w.started === true) };
      }
      if (list.length < pageSize || (total && (page + 1) * pageSize >= total)) break; // 到最后一页
    }
    return null;
  }
  // 窗口状态缓存（TTL 90s）：前端 20s 轮询不再每次打 /browser/list（BitBrowser 有 API 频率限制，打爆会强制退出登录）
  var windowStatusCache = {}; // { [windowId]: { at, found } }
  var WS_CACHE_TTL = 300 * 1000;
  register('GET', '/api/console/window/status', wrap(async (req, res) => {
    var qs0s = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const win = qs0s.get('windowId') ? String(qs0s.get('windowId')) : getWindowId();
    if (!win) return json(res, 200, { ok: true, open: false, windowId: null, msg: '未配置 windowId' });
    // 命中缓存直接返回（不碰 BitBrowser API）；?force=1 跳过缓存（开/关按钮点击后立即查真实状态）
    const force = qs0s.get('force') === '1';
    const cached = windowStatusCache[win];
    if (!force && cached && Date.now() - cached.at < WS_CACHE_TTL) {
      const found = cached.found;
      if (found) return json(res, 200, { ok: true, open: found.open, windowId: win, window: { status: found.status, seq: found.seq, name: found.name }, cached: true });
      return json(res, 200, { ok: true, open: false, windowId: win, window: null, note: '未在窗口列表找到（可能已删除）', cached: true });
    }
    const bit = getBit();
    if (!bit) return json(res, 501, { ok: false, open: false, windowId: win, msg: 'bitBrowserApiPort 未配置' });
    try {
      const found = await findWindowStatus(bit, win);
      windowStatusCache[win] = { at: Date.now(), found: found };
      if (found) return json(res, 200, { ok: true, open: found.open, windowId: win, window: { status: found.status, seq: found.seq, name: found.name } });
      return json(res, 200, { ok: true, open: false, windowId: win, window: null, note: '未在窗口列表找到（可能已删除）' });
    } catch (e) {
      return json(res, 200, { ok: false, open: false, windowId: win, msg: e && e.message || String(e) });
    }
  }));
  // 开/关 后清掉该窗口缓存（立刻反映新状态）
  register('POST', '/api/console/window/open', wrap(async (req, res, body) => {
    const win = (body && body.windowId) ? String(body.windowId) : getWindowId();
    if (!win) return json(res, 400, { ok: false, msg: 'windowId 缺失' });
    const bit = getBit();
    if (!bit) return json(res, 501, { ok: false, msg: 'bitBrowserApiPort 未配置' });
    try {
      const data = await bit.openBrowser({ id: win, queue: true });
      delete windowStatusCache[win];
      return json(res, 200, { ok: true, opened: true, windowId: win, data: data });
    } catch (e) {
      return json(res, 500, { ok: false, opened: false, windowId: win, msg: e && e.message || String(e) });
    }
  }));
  register('POST', '/api/console/window/close', wrap(async (req, res, body) => {
    const win = (body && body.windowId) ? String(body.windowId) : getWindowId();
    if (!win) return json(res, 400, { ok: false, msg: 'windowId 缺失' });
    const bit = getBit();
    if (!bit) return json(res, 501, { ok: false, msg: 'bitBrowserApiPort 未配置' });
    try {
      await bit.closeBrowser(win);
      delete windowStatusCache[win];
      return json(res, 200, { ok: true, closed: true, windowId: win });
    } catch (e) {
      return json(res, 500, { ok: false, closed: false, windowId: win, msg: e && e.message || String(e) });
    }
  }));


  // ============================================================================
  // 线索池 · 侦测探测（2026-11-03 用户：把 17098 主动侦测做成前端可复用）
  // POST /api/console/leads/explore
  //   body: { dims?: ['like'|'bbs'|'ashiato'|'search']（默认 all）, maxPages?: number（默认 3）, windowLabel?: string }
  //   → 对出会 17098 窗口跑 CDP 侦测 → upsertLead 灌 Lead → navigateInbox → 返回统计
  //   search 维度 = 当前找对象页（用户已设好条件），读页面条件标签 + fetchFaces
  // ============================================================================
  register('POST', '/api/console/leads/explore', wrap(async (req, res, body) => {
    if (!deepScrape || typeof deepScrape.fetchTypedLikes !== 'function') {
      return json(res, 501, { ok: false, reason: 'deepScrape-not-ready', msg: '出会侦测器未注入' });
    }
    const dims = (body && Array.isArray(body.dims) && body.dims.length) ? body.dims : ['like', 'bbs', 'ashiato', 'search'];
    const maxPages = (body && Number(body.maxPages) > 0) ? Number(body.maxPages) : 3;
    const winLabel = (body && String(body.windowLabel || '').trim()) || '17098';
    const platform = 'ichigo';
    const now = new Date().toISOString();
    const collected = []; // { sourceDim, L }

    // 灌库 helper
    const crypto = require('crypto');
    function leadIdFor(sourceDim, L, memberId) {
      const key = memberId != null && memberId !== ''
        ? String(platform) + '/m/' + memberId + '/' + sourceDim
        : String(platform) + '/n/' + (L.name || '') + '/' + L.age + '/' + (L.region || '') + '/' + sourceDim;
      return platform.toUpperCase() + '_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
    }

    const results = { like: 0, bbs: 0, ashiato: 0, search: 0, errors: [] };

    // ---- like 维度（3 Tab）----
    if (dims.indexOf('like') !== -1) {
      for (const tab of ['received', 'sent', 'mutual']) {
        try {
          const r = await deepScrape.fetchTypedLikes({ tab: tab, maxPages: maxPages, maxItems: 200 });
          if (r.ok && Array.isArray(r.likes)) {
            for (const l of r.likes) {
              collected.push({
                sourceDim: 'like',
                leadId: leadIdFor('like', l, l.memberId),
                L: {
                  name: l.name || '', age: l.age != null ? String(l.age) : null,
                  region: l.city || null, online: l.onlineIcon || null,
                  avatarUrl: l.avatarUrl || null, profileUrl: l.profileUrl || null,
                  selfIntro: l.selfIntro || null,
                  extras: { like_tab: tab, memberId: l.memberId || null, like_time: l.time || '', like_isNew: l.isNew ? 1 : 0 },
                },
              });
            }
            results.like += (r.likes || []).length;
          } else {
            results.errors.push('like-' + tab + ': ' + (r.reason || r.msg || 'no-data'));
          }
        } catch (e) { results.errors.push('like-' + tab + ': ' + (e.message || e)); }
      }
    }

    // ---- bbs 维度（翻页）----
    if (dims.indexOf('bbs') !== -1) {
      for (let p = 1; p <= Math.min(maxPages, 3); p++) {
        try {
          const r = await deepScrape.queryBbsPosts({ genre: 5, page: p, count: 20 });
          if (r.ok && Array.isArray(r.posts)) {
            for (const post of r.posts) {
              collected.push({
                sourceDim: 'bbs',
                leadId: leadIdFor('bbs', post, null),
                L: {
                  name: post.name || '', age: post.age != null ? String(post.age) : null,
                  region: post.home || null, online: post.onlineIcon ? ('online-icon' + post.onlineIcon) : null,
                  avatarUrl: post.avatarUrl || null,
                  profileUrl: (function (h) { h = String(h || ''); if (!h) return null; if (h.charAt(0) === '/') h = 'https://sp.194964.com' + h; return h; })(post.profileHref),
                  selfIntro: post.title || null,
                  extras: { bbs_views: post.views || 0, bbs_date: post.date || '', bbs_cat: post.cat || '', bbs_page: p, bbs_detailHref: (function (h) { h = String(post.detailHref || ''); if (!h) return null; if (h.charAt(0) === '/') h = 'https://sp.194964.com' + h; return h; }) },
                  
                },
              });
            }
            results.bbs += (r.posts || []).length;
          } else {
            results.errors.push('bbs-p' + p + ': ' + (r.reason || r.msg || 'no-data'));
          }
        } catch (e) { results.errors.push('bbs-p' + p + ': ' + (e.message || e)); }
      }
    }

    // ---- ashiato 维度（2 方向）----
    if (dims.indexOf('ashiato') !== -1) {
      for (const dir of ['received', 'mine']) {
        try {
          const r = await deepScrape.fetchAshiato({ direction: dir, maxPages: maxPages, maxItems: 200 });
          if (r.ok && Array.isArray(r.footmarks)) {
            for (const f of r.footmarks) {
              collected.push({
                sourceDim: 'ashiato',
                leadId: leadIdFor('ashiato', f, f.memberId || f.footmarkId),
                L: {
                  name: f.name || '', age: f.age != null ? String(f.age) : null,
                  region: f.city || null, online: f.onlineIcon ? ('online-icon' + f.onlineIcon) : null,
                  avatarUrl: f.avatarUrl || null, profileUrl: f.profileHref || null, selfIntro: f.desc || null,
                  extras: { ashiato_direction: dir, memberId: f.memberId || f.footmarkId || null, foot_time: f.time || '' },
                },
              });
            }
            results.ashiato += (r.footmarks || []).length;
          } else {
            results.errors.push('ashiato-' + dir + ': ' + (r.reason || r.msg || 'no-data'));
          }
        } catch (e) { results.errors.push('ashiato-' + dir + ': ' + (e.message || e)); }
      }
    }

    // ---- search 维度（当前找对象页，用户已设条件）----
    if (dims.indexOf('search') !== -1) {
      try {
        const faces = await deepScrape.fetchFaces({ maxItems: 50 });
        // 读当前检索条件标签
        let conditionLabel = '';
        try {
          const targets = await deepScrape.getTargets ? null : null; // getTargets 在 deepScrape 内
          // 用 liveScanner 的 http 端口；这里简化：从 faces 返回的 via / 用 CDP 读页面文本
          // 直接通过 deepScrape 无公开 readPageText，改用 settings 的 liveScanner
          if (liveScanner && typeof liveScanner.openCdpSession === 'function') {
            const session = await liveScanner.openCdpSession();
            try {
              const cond = await session.client.send('Runtime.evaluate', {
                expression: '(function(){var t=document.body?document.body.textContent:"";var m=t.match(/([^\s]+を表示中)/);return m?m[1]:"";})()',
                returnByValue: true,
              });
              conditionLabel = String((cond && cond.result && cond.result.value) || '');
            } catch (e) { conditionLabel = ''; }
            session.close();
          }
        } catch (e) { conditionLabel = ''; }

        if (faces.ok && Array.isArray(faces.members)) {
          for (const m of faces.members) {
            const prefCity = (m.pref && m.city && m.pref !== m.city) ? (m.pref + '-' + m.city) : (m.city || m.pref || '');
            collected.push({
              sourceDim: 'search',
              leadId: leadIdFor('search', m, m.memberId),
              L: {
                name: m.name || '', age: m.age ? String(m.age).replace(/歳/, '') : null,
                region: prefCity || null, online: m.iconClass || null,
                avatarUrl: m.thumb ? ('https:' + String(m.thumb).replace(/^\//, '')) : null,
                profileUrl: null, selfIntro: null,
                extras: { searchCondition: conditionLabel || null, memberId: m.memberId, certify: m.certify, type: m.type },
              },
            });
          }
          results.search = faces.members.length;
        } else {
          results.errors.push('search: ' + (faces.reason || faces.msg || 'not-on-faces-page'));
        }
      } catch (e) { results.errors.push('search: ' + (e.message || e)); }
    }

    // ---- 灌库（upsertLead 累积留痕）----
    if (!store || typeof store.upsertLead !== 'function') {
      return json(res, 501, { ok: false, reason: 'store-not-ready' });
    }
    const rawDb = store && store.db;
    if (!rawDb) return json(res, 501, { ok: false, reason: 'db-not-injected' });
    rawDb.exec('BEGIN');
    let upserted = 0;
    try {
      for (const item of collected) {
        const L = item.L;
        // upsertLead 需要 memberId 透传（稳定身份键）
        const memberId = L.extras && (L.extras.memberId || (L.extras.like_tab ? null : null));
        const input = {
          leadId: item.leadId,
          platform: platform,
          accountId: winLabel,
          name: L.name, age: L.age, region: L.region, online: L.online,
          avatarUrl: L.avatarUrl, profileUrl: L.profileUrl, selfIntro: L.selfIntro,
          sourceDim: item.sourceDim,
          memberId: memberId != null ? String(memberId) : null,
          // ②b 灌库回填 contactId(按 name 匹配 Contact, 精确关联收件箱会话)
          contactId: (function () {
            try {
              if (L.name) {
                const cRow = store.db.prepare('SELECT contactId FROM Contact WHERE displayName = ? LIMIT 1').get(String(L.name));
                if (cRow && cRow.contactId) return cRow.contactId;
              }
            } catch (_) {}
            return null;
          })(),
          extras: L.extras,
        };
        const r = store.upsertLead(input);
        if (r && r.leadId) { upserted++; autoSyncProfile(r, input); }
      }
      rawDb.exec('COMMIT');
    } catch (e) {
      try { rawDb.exec('ROLLBACK'); } catch (_) {}
      return json(res, 500, { ok: false, reason: 'db-failed', msg: e.message || e });
    }

    // ---- 返回收件箱（铁律 §1.9）----
    let backInbox = false;
    try { await deepScrape.navigateInbox(); backInbox = true; } catch (e) { results.errors.push('navigateInbox: ' + (e.message || e)); }

    let totalForWin = 0;
    try { totalForWin = rawDb.prepare('SELECT COUNT(*) n FROM Lead WHERE accountId=? AND platform=?').get(winLabel, platform).n; } catch (e) { totalForWin = -1; }

    return json(res, 200, {
      ok: true,
      windowLabel: winLabel,
      collected: collected.length,
      upserted: upserted,
      byDim: { like: results.like, bbs: results.bbs, ashiato: results.ashiato, search: results.search },
      errors: results.errors,
      backInbox: backInbox,
      totalForWindow: totalForWin,
      at: now,
    });
  }));


  // ============================================================================
  // 快乐平台 · 线索池侦测灌库（18595 窗口 · 客源 4 路 DOM 抓取）
  // POST /api/console/leads/clean-orphan { accountId?, platform? }
  // → 删"缺资料卡链接"(profileUrl 空)的线索 + 级联删资料池对应 Profile(线索池删 → 资料池随删, 用户 2026-11-10 裁定)
  register('POST', '/api/console/leads/clean-orphan', wrap(async (req, res, body) => {
    if (!store || !store.db) return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const b = body || {};
    const accountId = b.accountId || '17098';
    const platform = b.platform || 'ichigo';
    const db = store.db;
    // ① 找缺链接的 leadId
    var orphans = db.prepare(
      "SELECT leadId FROM Lead WHERE accountId=? AND platform=? AND (profileUrl IS NULL OR profileUrl='') ORDER BY updatedAt DESC LIMIT 5000"
    ).all(accountId, platform);
    var ids = (orphans || []).map(function (r) { return String(r.leadId); });
    var delLead = 0, delProfile = 0;
    if (ids.length) {
      var qm = ids.map(function () { return '?'; }).join(',');
      // ② 先删资料池(级联: 线索删了, 资料池对应删)
      delProfile = db.prepare('DELETE FROM Profile WHERE leadId IN (' + qm + ')').run.apply(null, ids).changes;
      // ③ 删线索
      delLead = db.prepare('DELETE FROM Lead WHERE leadId IN (' + qm + ')').run.apply(null, ids).changes;
    }
    // ④ 统计
    var leadLeft = db.prepare('SELECT COUNT(*) c FROM Lead WHERE accountId=? AND platform=?').get(accountId, platform).c;
    var profLeft = db.prepare('SELECT COUNT(*) c FROM Profile WHERE accountId=? AND platform=?').get(accountId, platform).c;
    return json(res, 200, {
      ok: true, deletedLead: delLead, deletedProfile: delProfile,
      leadLeft: leadLeft, profileLeft: profLeft,
      note: '已删缺链接线索 ' + delLead + ' 条 + 资料池级联删 ' + delProfile + ' 条; 现 线索 ' + leadLeft + ' / 资料池 ' + profLeft,
    });
  }));

  // POST /api/console/leads/explore-happy
  //   body: { dims?: ['like'|'search'|'bbs'|'ashiato']（默认 all）}
  //   → happyScanner.scanSource 导航 4 客源页读已渲染 DOM → upsertLead 灌 Lead
  //   走 CDP 只读，不碰 /browser/list（不触发 BitBrowser 限频）；DOM 是页面自带会话态渲染，无需手取 token
  // ============================================================================
  var HAPPY_DIM_KIND = { like: 'type', search: 'profile', bbs: 'billboard', ashiato: 'ashiato' };
  var HAPPY_DIM_LABEL = { like: '点赞', search: '检索', bbs: '帖子', ashiato: '足迹' };
  // ============================================================================
  // 007 · 第二阶段 资料池 Profile（线索池筛选选择后 → 抓取 → 资料池; 手动触发）
  //   promote: 选中 Lead 进资料池(算已沟通/来源/快照)
  //   GET /profiles: 浏览资料池(crawlStatus 未/已抓取 + communicated 已沟通 + sourceDim 来源)
  //   POST /profiles/crawl: 对选中 profileId 抓资料卡(refine-crawl 同款 deepScrape.fetchProfile)
  //   POST /profiles/refresh-comms: 刷新"已沟通"标记
  // ============================================================================
  // 算某 contactId 在收件箱的消息条数(有记录=已沟通, 我发或他发都算)
  function msgCountForContact(contactId) {
    if (!store || !store.db || !contactId) return 0;
    try {
      const r = store.db.prepare('SELECT COUNT(*) AS c FROM Message WHERE contactId = ?').get(String(contactId));
      return r ? Number(r.c || 0) : 0;
    } catch (_) { return 0; }
  }

  // POST /api/console/leads/promote { accountId?, leadIds?:[], limit? } → 选中线索进资料池
  register('POST', '/api/console/leads/promote', wrap(async (req, res, body) => {
    if (!store || typeof store.upsertLead !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const b = body || {};
    const accountId = b.accountId || '17098';
    const platform = b.platform || 'ichigo';
    // 没指定 leadIds → 默认 promote 该账号全部线索(用户"筛选选择后"通常带 leadIds; 不带=全量补登记, 幂等)
    let targets = store.listLeads({ platform: platform, accountId: accountId }, { limit: 1000 });
    if (Array.isArray(b.leadIds) && b.leadIds.length) {
      const ids = b.leadIds.map(String);
      targets = targets.filter(function (ld) { return ids.indexOf(String(ld.leadId)) !== -1; });
    }
    if (!targets.length) return json(res, 200, { ok: true, promoted: 0, total: 0, note: '该账号暂无可 promote 的线索' });
    // 回填 contactId(②b: 按 name+accountId 匹配 Contact 精确关联收件箱) + 算已沟通
    let promoted = 0;
    const skipped = [];
    for (const ld of targets) {
      let contactId = ld.contactId || null;
      if (!contactId) {
        // 灌库时没回填的, 现在按 name 匹配 Contact(弱匹配兜底)
        try {
          const cRow = store.db.prepare('SELECT contactId FROM Contact WHERE displayName = ? LIMIT 1').get(String(ld.name || ''));
          if (cRow) contactId = cRow.contactId;
        } catch (_) { contactId = null; }
      }
      const msgCount = msgCountForContact(contactId);
      const row = store.upsertProfile({
        leadId: ld.leadId,
        contactId: contactId,
        platform: ld.platform,
        accountId: ld.accountId || accountId,
        name: ld.name, gender: ld.gender, age: ld.age, region: ld.region, online: ld.online,
        avatarUrl: ld.avatarUrl, profileUrl: ld.profileUrl, selfIntro: ld.selfIntro,
        sourceDim: ld.sourceDim,
        communicated: msgCount > 0,
        msgCount: msgCount,
        extras: (function () { try { return JSON.parse(ld.extras || '{}'); } catch (_) { return {}; } })(),
      });
      if (row) promoted++;
      else skipped.push(ld.leadId);
      // 顺手回填 Lead.contactId(下次直接读, 不用再匹配)
      if (contactId && !ld.contactId) {
        try { store.db.prepare('UPDATE Lead SET contactId = ? WHERE leadId = ?').run(contactId, ld.leadId); } catch (_) {}
      }
    }
    // ② 抓"未抓取"的已沟通自动后台抓: 收集 promoted 里 communicated=true && crawlStatus!=done && 有 profileUrl
    //    → 后台呼吸节拍抓(不阻塞本请求; 后期放呼吸/编排引擎里跑, 现在先内联 setTimeout 起)
    const autoTargets = [];
    for (const ld of targets) {
      const prof = store.getProfile ? store.getProfile('P' + (function () { var c = require('crypto'); return c.createHash('sha1').update(String(ld.leadId)).digest('hex'); })()) : null;
      if (prof && prof.communicated && prof.crawlStatus !== 'done' && (ld.profileUrl || prof.profileUrl)) {
        autoTargets.push({ profileId: prof.profileId, url: ld.profileUrl || prof.profileUrl });
      }
    }
    let autoStarted = 0;
    if (autoTargets.length) {
      // 后台呼吸抓(20-40s 间隔), 上限 10 个/批(防风控); 超出部分下一轮再触发
      const batch = autoTargets.slice(0, 10);
      (async function() {
        for (let i = 0; i < batch.length; i++) {
          const it = batch[i];
          try {
            const prof = await deepScrape.fetchProfile(it.url);
            if (prof && prof.ok !== false) {
              const merged = {};
              // 全量字段拍平 + 分组 + 兴趣 + 在线 + 现居地区 + BBS(和 /profiles/crawl 一致)
              if (prof.fields && typeof prof.fields === 'object') {
                Object.keys(prof.fields).forEach(function (fk) {
                  var fv = prof.fields[fk];
                  if (fv !== undefined && fv !== null && fv !== '') merged[fk] = fv;
                });
              }
              if (prof.byGroup && typeof prof.byGroup === 'object') merged.byGroup = prof.byGroup;
              if (prof.interestIcons) {
                merged.interestIcons = prof.interestIcons;
                merged.interests = prof.interestIcons.map ? prof.interestIcons.map(function (x) { return (x && x.label) || (typeof x === 'string' ? x : (x && x.name) || String(x)); }).filter(Boolean) : prof.interestIcons;
              }
              if (prof.onlineText) merged.onlineText = prof.onlineText;
              if (prof.region || prof.pref || prof.city) {
                merged.regionFull = prof.region || ([prof.pref, prof.city].filter(Boolean).join(' '));
                if (prof.pref) merged.pref = prof.pref;
                if (prof.city) merged.city = prof.city;
              }
              if (prof.nickname) merged.nickname = prof.nickname;
              if (prof.ageNum != null) merged.ageNum = prof.ageNum;
              if (prof.avatarUrl) merged.avatarUrl = prof.avatarUrl;
              if (prof.bbsPosts && prof.bbsPosts.length) merged.bbsPosts = prof.bbsPosts.map(function (b) { return { genre: b.genre, content: b.content, time: b.time, viewCount: b.viewCount }; }).slice(0, 10);
store.markProfileCrawled(it.profileId, 'done', merged);
            } else {
              store.markProfileCrawled(it.profileId, 'failed', { crawlErr: (prof && prof.reason) || 'unknown' });
            }
          } catch (e) {
            store.markProfileCrawled(it.profileId, 'failed', { crawlErr: String(e && e.message || e) });
          }
          if (i < batch.length - 1) await new Promise(function (r) { setTimeout(r, 20000 + Math.floor(Math.random() * 20000)); });
        }
      })();
      autoStarted = batch.length;
    }
    return json(res, 200, {
      ok: true, promoted: promoted, total: targets.length,
      autoCrawling: autoStarted,
      note: '已 promote ' + promoted + ' 条进资料池（含已沟通/来源标注）。' +
        (autoStarted ? ' 其中 ' + autoStarted + ' 条已沟通未抓 → 后台呼吸抓取中(每 20-40s 一个)。' : '') +
        ' 资料池页查看。',
    });
  }));

  // GET /api/console/profiles?platform=&accountId=&crawlStatus=&communicated=&sourceDim=
  register('GET', '/api/console/profiles', wrap(async (req, res) => {
    if (!store || typeof store.listProfiles !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const rawQs = String(req.url || '').split('?')[1] || '';
    const qs = new URLSearchParams(rawQs);
    const filter = {};
    const fPlatform = qs.get('platform');
    const fAccountId = qs.get('accountId');
    const fCrawl = qs.get('crawlStatus');
    const fComms = qs.get('communicated');
    const fDim = qs.get('sourceDim');
    if (fPlatform) filter.platform = fPlatform;
    if (fAccountId) filter.accountId = fAccountId;
    if (fCrawl) filter.crawlStatus = fCrawl;
    if (fComms !== null && fComms !== '') filter.communicated = (fComms === '1' || fComms === 'true');
    if (fDim) filter.sourceDim = fDim;
    const limit = Math.min(parseInt(qs.get('limit') || '1000', 10), 5000);
    let rows = [];
    try { rows = store.listProfiles(filter, { limit: limit }); } catch (e) {
      return json(res, 500, { ok: false, reason: 'query-failed', msg: String(e && e.message || e) });
    }
    const profiles = (rows || []).map(function (r) {
      let extras = {}; try { extras = JSON.parse(r.extras || '{}'); } catch (_) { extras = {}; }
      const o = Object.assign({}, r);
      delete o.extras;
      o.extras = extras;
      o.communicated = !!r.communicated;
      return o;
    });
    // 聚合: 按 crawlStatus / sourceDim / communicated
    let agg = { total: profiles.length, crawled: 0, pending: 0, communicated: 0, bySource: {} };
    profiles.forEach(function (p) {
      if (p.crawlStatus === 'done') agg.crawled++;
      else if (p.crawlStatus === 'failed') agg.pending++;
      else agg.pending++;
      if (p.communicated) agg.communicated++;
      agg.bySource[p.sourceDim || 'unknown'] = (agg.bySource[p.sourceDim || 'unknown'] || 0) + 1;
    });
    return json(res, 200, { ok: true, count: profiles.length, profiles: profiles, agg: agg });
  }));

  // POST /api/console/profiles/crawl { accountId?, profileIds?:[] } → 对选中抓资料卡(手动触发, 呼吸节拍)
    // 资料卡后台抓取任务(呼吸节拍, 避免前端长时间等待)
  var crawlJobs = new Map();
  function startCrawlJob(accountId, toCrawl, force) {
    var jobId = 'cj_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6);
    var job = { jobId: jobId, accountId: accountId, status: 'running', total: toCrawl.length, done: 0, failed: 0, startedAt: new Date().toISOString() };
    crawlJobs.set(jobId, job);
    // 后台呼吸抓取(不阻塞请求)
    (async function() {
      for (var idx = 0; idx < toCrawl.length; idx++) {
        var p = toCrawl[idx];
        try {
          var prof = await deepScrape.fetchProfile(p.profileUrl);
          if (prof && prof.ok !== false) {
            var merged = {};
            if (prof.fields && typeof prof.fields === 'object') {
              Object.keys(prof.fields).forEach(function (fk) { var fv = prof.fields[fk]; if (fv !== undefined && fv !== null && fv !== '') merged[fk] = fv; });
              merged.fields = prof.fields;
            }
            if (prof.byGroup && typeof prof.byGroup === 'object') merged.byGroup = prof.byGroup;
            if (prof.interestIcons) {
              merged.interestIcons = prof.interestIcons;
              merged.interests = prof.interestIcons.map ? prof.interestIcons.map(function (x) { return (x && x.label) || (typeof x === 'string' ? x : (x && x.name) || String(x)); }).filter(Boolean) : prof.interestIcons;
            }
            if (prof.onlineText) merged.onlineText = prof.onlineText;
            if (prof.region || prof.pref || prof.city) {
              merged.regionFull = prof.region || ([prof.pref, prof.city].filter(Boolean).join(' '));
              if (prof.pref) merged.pref = prof.pref;
              if (prof.city) merged.city = prof.city;
            }
            if (prof.nickname) merged.nickname = prof.nickname;
            if (prof.ageNum != null) merged.ageNum = prof.ageNum;
            if (prof.avatarUrl) merged.avatarUrl = prof.avatarUrl;
            if (prof.bbsPosts && prof.bbsPosts.length) merged.bbsPosts = prof.bbsPosts.map(function (b) { return { genre: b.genre, content: b.content, time: b.time, viewCount: b.viewCount }; }).slice(0, 10);
            store.markProfileCrawled(p.profileId, 'done', merged);
            job.done++;
          } else {
            store.markProfileCrawled(p.profileId, 'failed', { crawlErr: (prof && prof.reason) || 'unknown' });
            job.failed++;
          }
        } catch (e) {
          store.markProfileCrawled(p.profileId, 'failed', { crawlErr: String(e && e.message || e) });
          job.failed++;
        }
        if (idx < toCrawl.length - 1) await new Promise(function (r) { setTimeout(r, 20000 + Math.floor(Math.random() * 20000)); });
      }
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      // 保留最近 20 个 job(防内存泄漏)
      if (crawlJobs.size > 20) { var arr = Array.from(crawlJobs.values()).sort(function(a,b){return (a.startedAt<b.startedAt?-1:1);}); crawlJobs.delete(arr[0].jobId); }
    })();
    return job;
  }

register('POST', '/api/console/profiles/crawl', wrap(async (req, res, body) => {
    if (!deepScrape || typeof deepScrape.fetchProfile !== 'function') return json(res, 501, { ok: false, reason: 'deepscrape-not-injected', msg: '出会深度抓取器未注入(17098 窗口未开?)' });
    if (!store || typeof store.getProfile !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const b = body || {};
    const accountId = b.accountId || '17098';
    let targets = store.listProfiles({ accountId: accountId }, { limit: 1000 });
    if (Array.isArray(b.profileIds) && b.profileIds.length) {
      const ids = b.profileIds.map(String);
      targets = targets.filter(function (p) { return ids.indexOf(String(p.profileId)) !== -1; });
    }
    // 只抓未完成的 + 有 profileUrl 的
    // force=true(重抓): 即使 done 也重抓(资料卡可能更新/上次抓不完整); 默认只抓未完成
    const toCrawl = b.force === true || b.force === '1' || b.force === 'true'
      ? targets.filter(function (p) { return p.profileUrl; })
      : targets.filter(function (p) { return p.profileUrl && p.crawlStatus !== 'done'; });

    // 多批/全量(>1 条) → 后台呼吸抓取, 立即返回 jobId(前端轮询 /crawl-status), 避免长时间等待
    if (toCrawl.length > 1) {
      var job = startCrawlJob(accountId, toCrawl, b.force);
      return json(res, 200, {
        ok: true, background: true, jobId: job.jobId, total: job.total,
        note: '已启动后台呼吸抓取 ' + job.total + ' 条(每 20-40s 一个), 轮询 /api/console/profiles/crawl-status?jobId=' + job.jobId + ' 看进度',
      });
    }
    if (!toCrawl.length) return json(res, 200, { ok: true, crawled: 0, total: targets.length, note: b.force ? '指定资料无 profileUrl(无资料卡链接), 无法抓' : '没有可抓的(已完成或无资料卡链接)' });
    const max = Math.min(parseInt(b.max || '5', 10), 10);
    const batch = toCrawl.slice(0, max);
    let done = 0;
    for (const p of batch) {
      try {
        const prof = await deepScrape.fetchProfile(p.profileUrl);
        if (prof && prof.ok !== false) {
          const merged = {};
          // 全量字段拍平(fields.key → 值) —— 资料卡深度信息(基本情報/見た目/大人の交際/生活/希望)
          if (prof.fields && typeof prof.fields === 'object') {
            Object.keys(prof.fields).forEach(function (fk) {
              var fv = prof.fields[fk];
              if (fv !== undefined && fv !== null && fv !== '') { merged[fk] = fv; }
            });
            merged.fields = prof.fields;  // 嵌套一份供前端 ex.fields 读(兼容 detailRows 的 F)
          }
          // 分组(byGroup) + 兴趣(enriched label) + 在线 + 现居地区 + 头像 + BBS + 昵称
          if (prof.byGroup && typeof prof.byGroup === 'object') merged.byGroup = prof.byGroup;
          if (prof.interestIcons) {
            merged.interestIcons = prof.interestIcons;
            merged.interests = prof.interestIcons.map ? prof.interestIcons.map(function (x) { return (x && x.label) || (typeof x === 'string' ? x : (x && x.name) || String(x)); }).filter(Boolean) : prof.interestIcons;
          }
          if (prof.onlineText) merged.onlineText = prof.onlineText;
          if (prof.region || prof.pref || prof.city) {
            merged.regionFull = prof.region || ([prof.pref, prof.city].filter(Boolean).join(' '));
            if (prof.pref) merged.pref = prof.pref;
            if (prof.city) merged.city = prof.city;
          }
          if (prof.nickname) merged.nickname = prof.nickname;
          if (prof.ageNum != null) merged.ageNum = prof.ageNum;
          if (prof.avatarUrl) merged.avatarUrl = prof.avatarUrl;
          if (prof.bbsPosts && prof.bbsPosts.length) merged.bbsPosts = prof.bbsPosts.map(function (b) { return { genre: b.genre, content: b.content, time: b.time, viewCount: b.viewCount }; }).slice(0, 10);
          store.markProfileCrawled(p.profileId, 'done', merged);
          done++;
        } else {
          store.markProfileCrawled(p.profileId, 'failed', { crawlErr: (prof && prof.reason) || 'unknown' });
        }
      } catch (e) {
        store.markProfileCrawled(p.profileId, 'failed', { crawlErr: String(e && e.message || e) });
      }
      // 呼吸节拍: 每个间隔 20000 + 0~20000ms 随机
      if (batch.indexOf(p) < batch.length - 1) {
        await new Promise(function (r) { setTimeout(r, 20000 + Math.floor(Math.random() * 20000)); });
      }
    }
    return json(res, 200, { ok: true, crawled: done, total: batch.length, note: '已抓 ' + done + '/' + batch.length + ' 条资料卡(呼吸节拍, 每 20-40s 一个)' });
  }));


  // GET /api/console/profiles/crawl-status?jobId= → 后台抓取任务进度
  register('GET', '/api/console/profiles/crawl-status', wrap(async (req, res) => {
    const qs = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const jobId = qs.get('jobId') || '';
    const job = jobId ? (crawlJobs.get(jobId) || null) : null;
    if (!job) {
      // 没指定 job 或 job 已清 → 返回最近一个
      var last = null;
      crawlJobs.forEach(function(v) { if (!last || v.startedAt > last.startedAt) last = v; });
      if (!last) return json(res, 200, { ok: false, reason: 'no-job', msg: '无后台抓取任务' });
      return json(res, 200, Object.assign({ ok: true }, last, { running: last.status === 'running' }));
    }
    return json(res, 200, Object.assign({ ok: true }, job, { running: job.status === 'running' }));
  }));

  // GET /api/console/profiles/inbox-live?platform=&accountId=&force=1
  // → 强制重爬收件箱(页面实际内容), 返回当前真实客户(平台收件箱全量), 清掉"已删除/测试"客户
  //   维护机制: 结构指纹 inboxVer(收件箱 DOM 关键节点数), 抓取失败/客户名全空 → pageChanged=true 提示重爬
  register('GET', '/api/console/profiles/inbox-live', wrap(async (req, res) => {
    if (!deepScrape || typeof deepScrape.mailboxOnly !== 'function') {
      return json(res, 501, { ok: false, reason: 'deepscrape-not-injected', msg: '出会深度抓取器未注入(17098 窗口未开?)' });
    }
    const b = (req.query || {});
    const force = b.force === '1' || b.force === 'true';
    // force 时强制 CDP 重爬(拿页面最新内容); 否则用缓存(快)
    let scan;
    if (force) {
      scan = await deepScrape.mailboxOnly();
    } else {
      // 非 force: 读 ichigoCache 当前收件箱(平台最近一次成功爬取的全量)
      scan = { ok: true, from: 'cache', contacts: (ichigoCache ? ichigoCache.getContacts() : []) };
    }
    if (!scan || scan.ok === false) {
      // 抓取失败 → 降级缓存 + 告警(页面可能已更新/窗口关闭)
      const cached = ichigoCache ? ichigoCache.getContacts() : [];
      return json(res, 200, {
        ok: false, reason: scan.reason || 'inbox-scrape-failed', msg: scan.msg,
        contacts: cached, from: 'cache-fallback', pageChanged: true,
        note: '收件箱重爬失败——平台页面可能已更新或窗口关闭, 请用当前缓存 ' + cached.length + ' 条, 或检查窗口后重爬',
      });
    }
    // 结构指纹: 收件箱关键客户数(维护机制——页面小更新时客户结构会变化)
    var contacts = (scan.contacts || []).map(function (c) {
      var mCount = Array.isArray(c.messages) ? c.messages.length : 0;
      // 已沟通 = 有消息历史(双向: 我发的 self / 对方发的 peer 都算)
      var peerMsgs = Array.isArray(c.messages) ? c.messages.filter(function (m) { return m && (m.role === 'peer' || m.role === 'them' || m.role === 'inbound' || m.role === 'incoming'); }).length : 0;
      var selfMsgs = Array.isArray(c.messages) ? c.messages.filter(function (m) { return m && (m.role === 'self' || m.role === 'me' || m.role === 'outbound' || m.role === 'sent'); }).length : 0;
      return {
        contactId: c.contactId, name: c.name || c.displayName, age: c.age, region: c.region,
        online: c.onlineTier, avatarUrl: c.avatarUrl, profileUrl: c.profileUrl,
        msgCount: mCount, communicated: mCount > 0, // 双向: 有任何消息历史就算已沟通
        peerMsgs: peerMsgs, selfMsgs: selfMsgs, unread: c.unread || 0,
        lastMsgTime: c.lastMsgTime || c.lastSeen,
      };
    });
    // 维护: 客户名全空 = 页面 DOM 变了(抓取表达式没匹配上) → 提示重爬/更新表达式
    var allEmpty = contacts.length && contacts.every(function (c) { return !c.name && !c.msgCount; });
    return json(res, 200, {
      ok: true, from: scan.from, count: contacts.length, contacts: contacts,
      inboxVer: 'v' + (scan.from === 'cache' ? 'cache' : 'live') + '-' + contacts.length,
      pageChanged: allEmpty,
      note: allEmpty ? '⚠ 收件箱客户名全空——平台页面可能已更新, 请重爬或更新 ichigoMailboxExpr.js 选择器' : '收件箱 ' + contacts.length + ' 客户(页面实际内容)',
    });
  }));

  // POST /api/console/profiles/sync { accountId?, platform? } → 同步"线索池 + 收件箱客户"进资料池(幂等)
  //   用户裁定(2026-11-10): 资料池 = 线索池(Lead) ∪ 收件箱客户(Conversation/Contact), 一定 >= 线索池数
  //   覆盖: ① 全部 Lead(未进 Profile 的新增/漏同步) ② 收件箱客户(contactId 在 Conversation/Contact, 未在 Profile)
  register('POST', '/api/console/profiles/sync', wrap(async (req, res, body) => {
    if (!store || typeof store.listLeads !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const b = body || {};
    const accountId = b.accountId || '17098';
    const platform = b.platform || 'ichigo';
    let syncedLead = 0, syncedInbox = 0;
    // ① 线索池全量 → 同步进资料池(autoSyncProfile 幂等: 已存在则刷新快照)
    try {
      const leads = store.listLeads({ platform: platform, accountId: accountId }, { limit: 3000 });
      const leadArr = Array.isArray(leads) ? leads : [];
      // 快路径: 查 Profile 里已有哪些 leadId, 只同步"新增"的(已有 → 快照在线索灌库时 autoSyncProfile 已建, 不重复刷)
      var existing = {};
      try {
        store.db.prepare('SELECT leadId FROM Profile WHERE accountId = ? AND leadId IS NOT NULL').all(accountId)
          .forEach(function (r) { if (r.leadId) existing[r.leadId] = 1; });
      } catch (_) {}
      leadArr.forEach(function (ld) {
        if (ld.leadId && existing[ld.leadId]) return;   // 已同步过 → 跳过(快)
        try {
          const ex = ld.extras ? (function () { try { return JSON.parse(ld.extras); } catch (_) { return {}; } })() : {};
          autoSyncProfile(ld, {
            leadId: ld.leadId, platform: platform, accountId: accountId,
            name: ld.name, gender: ld.gender, age: ld.age, region: ld.region,
            online: ld.online, avatarUrl: ld.avatarUrl, profileUrl: ld.profileUrl,
            selfIntro: ld.selfIntro, sourceDim: ld.sourceDim,
            contactId: ld.contactId || null, extras: ex,
          });
          syncedLead++;
        } catch (_) { /* 单条失败不阻断 */ }
      });    } catch (e) { /* 整体失败继续收件箱同步 */ }
    // ② 收件箱客户: 按"当前收件箱页实际客户"同步 —— 前端传入 b.inboxContacts(会话管理页真实 4 人) 最准;
    //    没传则读 ichigoCache 当前 liveSet(非归档); 剔除测试 AA_test; 双向消息历史=已沟通, 已删客户不在列表里自然不进
    var inboxNote = '';
    try {
      const inboxSrc = Array.isArray(b.inboxContacts) && b.inboxContacts.length ? b.inboxContacts : null;
      const resInbox = syncInboxProfiles(platform, accountId, inboxSrc);
      syncedInbox = resInbox.synced;
      inboxNote = resInbox.note;
    } catch (e) { /* 收件箱同步失败不影响线索池结果 */ }
    const total = store.listProfiles({ platform: platform, accountId: accountId }, { limit: 5000 }).length;
    return json(res, 200, {
      ok: true, syncedLead: syncedLead, syncedInbox: syncedInbox, total: total,
      note: '资料池已同步: 线索池 ' + syncedLead + ' 条 + 收件箱客户 ' + syncedInbox + ' 条, 现共 ' + total + ' 条' + (inboxNote ? '; ' + inboxNote : ''),
    });
  }));

  // POST /api/console/profiles/refresh-comms { accountId? } → 刷新已沟通标记
  register('POST', '/api/console/profiles/refresh-comms', wrap(async (req, res, body) => {
    if (!store || typeof store.listProfiles !== 'function') return json(res, 501, { ok: false, reason: 'store-not-ready' });
    const b = body || {};
    const rows = store.listProfiles({ accountId: b.accountId || '17098', platform: b.platform || 'ichigo' }, { limit: 1000 });
    let changed = 0;
    (rows || []).forEach(function (p) {
      if (p.contactId) { const r = store.refreshProfileComms(p.profileId); if (r) changed++; }
    });
    return json(res, 200, { ok: true, refreshed: changed, total: (rows || []).length });
  }));


  register('POST', '/api/console/leads/explore-happy', wrap(async (req, res, body) => {
    const winLabel = '18595';
    const platform = 'happymail';
    var dimsAll = ['like', 'search', 'bbs', 'ashiato'];
    const dims = (body && Array.isArray(body.dims) && body.dims.length) ? body.dims.filter(function(d) { return dimsAll.indexOf(d) !== -1; }) : dimsAll;
    const now = new Date().toISOString();

    if (!happyScanner || typeof happyScanner.scanSource !== 'function') {
      return json(res, 501, { ok: false, reason: 'happyScanner-not-ready', msg: '快乐平台扫描器未注入（服务需重启加载 happyScanner）' });
    }
    if (!store || typeof store.upsertLead !== 'function') {
      return json(res, 501, { ok: false, reason: 'store-not-ready' });
    }
    const rawDb = store.db;
    if (!rawDb) return json(res, 501, { ok: false, reason: 'db-not-injected' });

    const crypto = require('crypto');
    function leadIdFor(sourceDim, memberId, name, age, region) {
      const key = memberId
        ? platform + '/m/' + memberId + '/' + sourceDim
        : platform + '/n/' + (name || '') + '/' + (age || '') + '/' + (region || '') + '/' + sourceDim;
      return platform.toUpperCase() + '_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
    }

    // 逐维度跑 scanSource（导航 + 读 DOM）
    const collected = [];
    const byDim = { like: 0, search: 0, bbs: 0, ashiato: 0 };
    const errors = [];

    for (const dim of dims) {
      const kind = HAPPY_DIM_KIND[dim];
      let scan;
      try { scan = await happyScanner.scanSource(kind); }
      catch (e) { errors.push(dim + ': ' + (e.message || e)); continue; }
      if (!scan || scan.ok === false) {
        errors.push(dim + ': ' + (scan && (scan.reason || scan.msg) || 'no-data'));
        continue;
      }
      const data = scan.data || {};

      if (dim === 'like') {
        // EXPR_TYPE v2（实机 DOM）：tabs[] 三路，items[{name,age,region(市),avatarUrl,likeTime,detail,raw}]
        const tabs = Array.isArray(data.tabs) ? data.tabs : [];
        for (const tb of tabs) {
          const tabLabel = tb.label || tb.id || '';
          const isMutual = /マッチング|互赞|reciprocal/i.test(tabLabel);
          const isFromMe = /自分|我点赞|myself/i.test(tabLabel);
          const items = Array.isArray(tb.items) ? tb.items : [];
          for (const it of items) {
            const name = String(it.name || '').trim();
            if (!name || /すべてを選択/.test(String(it.raw || ''))) continue; // 空壳/全选行不灌
            const age = it.age || null;
            const region = it.region || null;
            const lastLogin = it.lastLogin || '';
            // 在线档 = 平台真实在线点颜色(green/yellow/gray)，缺失时回退按最后登录 24h/7d 估算
            var onlineLevel = it.onlineDot ? ('happy-' + it.onlineDot) : null;
            if (!onlineLevel) {
              var nowD = new Date();
              var lm = String(lastLogin).match(/^(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
              if (lm) {
                var ld = new Date(nowD.getFullYear(), Number(lm[1]) - 1, Number(lm[2]));
                if (ld.getTime() - nowD.getTime() > 2 * 86400000) ld = new Date(nowD.getFullYear() - 1, Number(lm[1]) - 1, Number(lm[2]));
                if (lm[3]) ld.setHours(Number(lm[3]), Number(lm[4] || 0));
                var dayDiff = (nowD.getTime() - ld.getTime()) / 86400000;
                onlineLevel = dayDiff <= 1 ? 'happy-green' : (dayDiff <= 7 ? 'happy-yellow' : 'happy-gray');
              }
            }
            collected.push({
              sourceDim: 'like',
              leadId: leadIdFor('like', null, name, age, region),
              L: {
                name: name, age: age, region: region,
                online: onlineLevel,
                avatarUrl: it.avatarUrl && !it.avatarIsDefault ? it.avatarUrl : null,
                profileUrl: null,
                selfIntro: it.detail || null,
                extras: { like_tab: isMutual ? 'mutual' : (isFromMe ? 'sent' : 'received'), like_label: tabLabel, like_time: it.likeTime || '', last_login: lastLogin || null, online_level: onlineLevel, memberId: it.memberId || null, raw: (it.raw || '').slice(0, 150) },
              },
            });
          }
        }
      } else if (dim === 'search') {
        // EXPR_PROFILE_SEARCH：读检索页 .profile_list_big_item（年龄/地区/自我介绍）
        const items = Array.isArray(data.items) ? data.items : (Array.isArray(data.members) ? data.members : []);
        for (const it of items) {
          const name = String(it.name || it.memberName || '').trim();
          if (!name || /すべてを選択|検索条件/.test(String(it.raw || ''))) continue;
          const age = it.age || it.memberAge || null;
          const region = it.region || it.memberResidence || null;
          collected.push({
            sourceDim: 'search',
            leadId: leadIdFor('search', it.memberId || null, name, age, region),
            L: {
              name: name, age: age, region: region,
              online: it.onlineDot ? ('happy-' + it.onlineDot) : (it.online ? String(it.online) : null),
              avatarUrl: it.avatarUrl && !it.avatarIsDefault ? it.avatarUrl : null,
              profileUrl: it.profileUrl || null,
              selfIntro: it.detail || it.selfIntro || it.intro || null,
              extras: { sex: it.sex || null, online_dot: it.onlineDot || null, search_time: it.likeTime || '', memberId: it.memberId || null, raw: (it.raw || '').slice(0, 150) },
            },
          });
        }
      } else if (dim === 'bbs') {
        // EXPR_BILLBOARD：keijiban.php 募集帖（.ds_billboard_item 等，字段 name/text/avatarUrl）
        const items = Array.isArray(data.items) ? data.items : [];
        for (const it of items) {
          const name = it.name || '';
          const region = it.region || null;
          const age = it.age || null;
          collected.push({
            sourceDim: 'bbs',
            leadId: leadIdFor('bbs', it.memberId || null, name, age, region),
            L: {
              name: name, age: age, region: region,
              online: it.onlineDot ? ('happy-' + it.onlineDot) : null,
              avatarUrl: it.avatarUrl && !it.avatarIsDefault ? it.avatarUrl : null,
              profileUrl: null,
              selfIntro: it.subject ? ('[募集帖] ' + it.subject).slice(0, 300) : (it.text || null),
              extras: { bbs_subject: it.subject || null, bbs_date: it.writeDate || it.footTime || null, bbs_reads: it.reads || it.footRef || null, online_dot: it.onlineDot || null, memberId: it.memberId || null, raw: (it.raw || '').slice(0, 150) },
            },
          });
        }
      } else if (dim === 'ashiato') {
        // EXPR_ASHIATO：足迹页（主动看我的人），字段 name/age/region/footTime/footRef
        const items = Array.isArray(data.items) ? data.items : [];
        for (const it of items) {
          const name = it.name || '';
          const age = it.age || null;
          const region = it.region || null;
          collected.push({
            sourceDim: 'ashiato',
            leadId: leadIdFor('ashiato', it.memberId || null, name, age, region),
            L: {
              name: name, age: age, region: region,
              online: null,
              avatarUrl: it.avatarUrl && !it.avatarIsDefault ? it.avatarUrl : null,
              profileUrl: null, selfIntro: null,
              extras: { foot_time: it.footTime || '', foot_ref: it.footRef || '', memberId: it.memberId || null, raw: (it.raw || '').slice(0, 150) },
            },
          });
        }
      }
      byDim[dim] = collected.filter(function(c) { return c.sourceDim === dim; }).length;
    }

    // 灌库（upsertLead 累积留痕）
    let upserted = 0;
    rawDb.exec('BEGIN');
    try {
      for (const item of collected) {
        const L = item.L;
        const input = {
          leadId: item.leadId, platform: platform, accountId: winLabel,
          name: L.name, age: L.age, region: L.region, online: L.online,
          avatarUrl: L.avatarUrl, profileUrl: L.profileUrl || null, selfIntro: L.selfIntro,
          sourceDim: item.sourceDim,
          memberId: L.extras && L.extras.memberId ? String(L.extras.memberId) : null,
          extras: L.extras,
        };
        const r = store.upsertLead(input);
        if (r && r.leadId) { upserted++; autoSyncProfile(r, input); }
      }
      rawDb.exec('COMMIT');
    } catch (e) {
      rawDb.exec('ROLLBACK');
      return json(res, 500, { ok: false, reason: 'db-failed', msg: String(e.message || e), windowLabel: winLabel, dims: dims });
    }

    let totalForWin = -1;
    try { totalForWin = rawDb.prepare('SELECT COUNT(*) n FROM Lead WHERE accountId=? AND platform=?').get(winLabel, platform).n; }
    catch (e) { totalForWin = -1; }

    var emptyNote = '';
    if (errors.length === 0 && collected.length === 0) {
      emptyNote = '本次没有灌入新线索（可能已有记录未变化，或当前平台侧暂无新数据）。可稍后再试。';
    }
    return json(res, 200, {
      ok: errors.length === 0 ? true : (upserted > 0 ? true : false),
      platform: platform, windowLabel: winLabel,
      collected: collected.length, upserted: upserted, byDim: byDim,
      errors: errors, totalForWindow: totalForWin, at: now, emptyNote: emptyNote,
    });
  }));

  return app;
}

module.exports = { mountConsoleRoutes };
