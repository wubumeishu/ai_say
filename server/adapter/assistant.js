'use strict';
// =============================================================================
// Ai SAY · 助手面板 B v1（assistant.js）
// POST /api/console/assistant 的后端：组上下文（画像+消息摘要+工具清单）→ 调 LLM →
// 返回 { reply, actions:[{type,label,payload}] }。只读/弱副作用工具直接给；强副作用
// （send_message）只生成「动作卡片」，前端渲染按钮，用户点了才走 send-live 真发。
// 铁律：LLM 永不直接发送；模型不可用 → 降级到本地摘要（不删功能）；数字只取结构化数据。
// =============================================================================
'use strict';
// =============================================================================
// Ai SAY · 助手面板 B v1 → B v1.1（assistant.js，节点 3 task-5 三端联调 · 后端部分）
// 依据：docs/plan/assistant-api-spec.md B v1.1 + aishay-uix-upgrade.md §3。
// 强制 JSON 契约 { analysis, strategy, replies:[{type,content}] } + intent 请求参数
// （analyze|reply|deflect|meet，intent→replies.type 映射 analyze→other/reply→followup/
//   deflect→deflect/meet→meet）+ parseV11 容忍（代码块/杂字/截断）失败降级 degraded + localFallback
// （铁律 2 人工兜底不删）+ 脱敏白名单（persona/tone/background 3 列，与 talkEngine L363 共用
//   maskPersonaToPrompt；客户 PII 掩码；apiKey 仅走 Authorization header 永不进 prompt/日志）
// + 三要素内存组装（§-1.3，AccountPersona+ContactProfile+最近12条 生成时组装，数字取 ageNum 数字列
//   防幻觉，铁律 4）。铁律：LLM 永不直接发送（强副作用只出 needConfirm 卡片，send-live 唯一执行路径）。
// =============================================================================

const ASSISTANT_PERSONA = '你是「Ai SAY 助手」，出会平台运营控制台的 AI 会话助手，服务运营者（用户）。用简体中文回复；引用客户消息可保留日文原文。专业、简洁、信息密度高；不确定直说，不编造。年龄/条数/时间等事实只引用系统提供的结构化数据，不得编造；数据不足时说「没有数据」并提示可先刷新。模型或数据不可用时降级为本地摘要回复，并告知用户当前是降级模式。涉及发送必须标注「发送需你确认」，你自己永不直接发送。';

const agentRegistry = require('../agents/registry');
// TOOL_WHITELIST 从 agent registry 动态生成（2026-10-25 总控）：
// 增删改 agent 只改 server/agents/registry.js，此处自动跟随，不再硬编码。
// 旧字段映射：type=label=agent.id，label/name=agent.name，sideEffect/desc 同；强副作用带 needsConfirm。
const TOOL_WHITELIST = agentRegistry.toLlmToolList().map(function (t) {
  return { type: t.type, label: t.label, sideEffect: t.sideEffect, desc: t.desc, needsConfirm: t.needsConfirm, params: t.params || [] };
});

// B v1.1 · intent → replies[].type 默认映射表（spec §3，code-reviewer 收编 b 消除枚举不对称）
const INTENT_TYPE_MAP = { analyze: 'other', reply: 'followup', deflect: 'deflect', meet: 'meet' };
const REPLY_TYPES = ['opening', 'followup', 'deflect', 'meet', 'close', 'other'];

/**
 * maskPersonaToPrompt(personaRow)：AccountPersona 行 → 可进 prompt 的白名单 3 字段（persona/tone/background）。
 * 严禁进 prompt：账号本名/真名/手机号（行内混有的 name/realName/phone 等字段一律过滤）；taboos 单独走规则引擎。
 * 与 talkEngine L363 personalize 拼 system 共用此函数（两处不各写一套，spec §5.3 统一口径）。
 * @returns {object} 仅含存在的白名单 3 字段
 */
function maskPersonaToPrompt(personaRow) {
  const out = {};
  if (!personaRow || typeof personaRow !== 'object') return out;
  if (personaRow.persona != null && personaRow.persona !== '') out.persona = String(personaRow.persona);
  if (personaRow.tone != null && personaRow.tone !== '') out.tone = String(personaRow.tone);
  if (personaRow.background != null && personaRow.background !== '') out.background = String(personaRow.background);
  return out;
}

/**
 * maskPiiInText(text)：客户 PII 掩码（spec §5.2，进 recentMessages 前做）。
 * 日本手机号（090/080/070 等 11 位）→ 前缀 + ****** + 尾 4 位；邮箱 → 首字符 + 掩码；邮编 → ***。
 * @returns {string} 掩码后文本
 */
function maskPiiInText(text) {
  let t = String(text || '');
  // 日本手机号：050/060/070/080/090 前缀 + 4+4 或 3+4 位（分隔符可选 空格/横线）
  t = t.replace(/0[56789]0[- ]?(\d{4})[- ]?(\d{4})/g, function(m, a, b) { return '090******' + b; });
  // 邮箱：本地段保留首字符 + 打码
  t = t.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+)/g, function(m, head, domain) {
    const dParts = domain.split('.');
    const dShort = dParts.length > 1 ? dParts[0] + '***.' + dParts[dParts.length - 1] : (domain.slice(0, 1) + '***');
    return head + '***@' + dShort;
  });
  // 日本邮编：123-4567 / 1234567
  t = t.replace(/\b\d{3}-?\d{4}\b/g, '***邮编***');
  return t;
}

// 意图 → prompt 侧重（intent 分 prompt，spec §2「后端按 intent 切换 system 侧重」）
const INTENT_PROMPT_HINT = {
  analyze: '当前意图 = 深度心理分析：analysis 字段给出客户心理/画像解读（动机/情绪/阶段），replies 恰好 2 条（侧重随 intent：两条试探）。话术按【排版规范】输出。analysis/strategy 用简体中文；replies[].content 用日文。',
  reply: '当前意图 = 高情商回复：analysis 给出对方话术的意图解读，strategy 给应对策略，replies 恰好 2 条（侧重随 intent：一保守一主动）。话术按【排版规范】输出。analysis/strategy 用简体中文；replies[].content 用日文。',
  deflect: '当前意图 = 委婉拉扯拒绝：analysis 解读对方诉求，strategy 给拉扯/拒绝策略（不硬刚、留余地），replies 恰好 2 条（侧重随 intent：一缓拒一留余地）。话术按【排版规范】输出。analysis/strategy 用简体中文；replies[].content 用日文。',
  meet: '当前意图 = 引导线下约会：analysis 判断见面成熟度，strategy 给邀约策略（自然、不突兀、给对方台阶），replies 恰好 2 条（侧重随 intent：一铺垫邀约一明确邀约）。话术按【排版规范】输出。analysis/strategy 用简体中文；replies[].content 用日文。',
};
// task-13 · 排版规范 + 人设一致性强约束（写进 system prompt，LLM 每条话术遵守）
// 排版：日文人阅读习惯——问候语独立成段 / 正文分 2-4 短段 / 段间用一个空行（\\n\\n）分隔；content 用 \\n 表示换行。
// 人设一致性：每条回复的语气/措辞/敬语层级严格贴合该 persona（不出现与年龄/性别/职业不符的措辞，tone 字段指定语感逐条遵守）。
// task-14 返工 · 语言铁律（与 LAYOUT_RULE/PERSONA_CONSISTENCY 并列，system prompt 靠前注入，优先级高于 few-shot）：
// 根因：analysis/strategy 的「简体中文」标注只在 JSON 模板注释里（非独立强指令）+ few-shot 全日文 content 语言跟随效应
// → LLM 把 analysis/strategy 污染成日文。此常量显式强约束三字段语言分离。
const LANGUAGE_RULE = '【语言铁律】analysis 和 strategy 字段必须且只能使用简体中文输出；只有 replies[].content 才是日文原文；replies[].translation 是 content 的简体中文译文。三者语言严格分离，禁止 analysis/strategy 混入日文，禁止 content 输出中文（content 永远是日文话术原文）。translation[i] 必须是 replies[i].content 的逐段对应中文译文，索引严格对齐。';
const LAYOUT_RULE = '【排版规范】每条 replies[].content 用日文原文，带正常换行与段落间隔：问候语/称呼独立成段，正文分 2-4 个短段（口语不堆砌长句），段落之间用一个空行分隔（即 content 里写 \\n\\n，单个换行写 \\n）。';
// task-15 · 条数铁律（与 L88 LANGUAGE_RULE / L89 LAYOUT_RULE 并列，system prompt 注入 L183 区）：
// replies 数组必须且只能恰好 2 条（固定 2 元素），第 1 条稳重保守 / 第 2 条主动引导，侧重随 intent 微调；
// 严禁 1 条或 3+ 条。前端 6 面板（参考回复1/翻译1/参考回复2/翻译2）按实际条数最多 2 循环成对渲染。
const REPLY_COUNT_RULE = '【条数铁律】replies 数组必须且只能恰好 2 条（固定 2 个元素）；第 1 条偏稳重保守（试探/铺垫），第 2 条偏主动引导（推进/邀约）；侧重随 intent 微调（analyze→两条试探 / reply→一保守一主动 / deflect→一缓拒一留余地 / meet→一铺垫邀约一明确邀约）；严禁 1 条或 3 条及以上。';
const PERSONA_CONSISTENCY = '【人设一致性】每条回复的语气、措辞、敬语层级必须严格贴合「账号人设」白名单字段（persona/tone/background）：不出现与人设年龄/性别/职业不符的措辞；tone 字段指定的语感（如温柔/俏皮/利落）逐条遵守；与 customer 的称呼/熟稔程度贴合当前对话阶段。' +
// task-14 · 称呼规则（用客户 displayName 称呼，尽量不用「あなた」；无客户名时温柔泛称，不强行编造）
'【称呼规则】回复中称呼客户用其名字（「当前客户」字段的 displayName/昵称，如「アルアルさん」），尽量不用「あなた」；没有客户名时用温柔的泛称（相手を呼ぶ自然な表現），不强行编造名字。' +
// task-14 · emoji/颜文字约束（适度自然 1-2 个/条，不堆砌，日文颜文字自然融入句子）
'【emoji/颜文字】回复中可适度自然穿插 emoji 或颜文字（1-2 个/条为宜，贴合语气，不堆砌；日文颜文字如 (〃▽〃) (´▽｀) 等自然融入句子）；不强制每条必有。';

function createAssistant(deps) {
  deps = deps || {};
  const modelStore = deps.modelStore || null;
  const aiService = deps.aiService || null;
  const ichigoCache = deps.ichigoCache || null;

  // ---------- 上下文组装（结构化数据，防幻觉）----------
  // ---------- 三要素内存组装（终极蓝图 §-1.3：生成时才组装，落库互不污染）----------
  // AccountPersona（白名单 3 字段）+ ContactProfile（ageNum 数字列）+ 最近 12 条 Conversation
  function buildContext(contactId, history, opts) {
    opts = opts || {};
    const ctx = {
      contactId: String(contactId || ''),
      contact: null,
      profileSummary: {},
      persona: {}, // 白名单 3 字段（maskPersonaToPrompt 结果，绝不含本名/真名/手机号）
      recentMessages: [],
      tools: (Array.isArray(opts.tools) && opts.tools.length ? TOOL_WHITELIST.filter(function(t) { return opts.tools.indexOf(t.type) >= 0; }) : TOOL_WHITELIST)
        .map(function(t) { return { type: t.type, label: t.label, sideEffect: t.sideEffect, desc: t.desc }; }),
      degraded: false,
      intent: (opts.intent && INTENT_TYPE_MAP[opts.intent]) ? opts.intent : null, // 缺省/未知 = 自由问答（B v1 行为不变）
    };
    // 客户画像（ichigoCache；缺字段省略，不填 null 防 LLM 引用）
    if (ichigoCache && typeof ichigoCache.getContact === 'function' && contactId) {
      try {
        const c = ichigoCache.getContact(contactId);
        if (c) {
          // task-14 · 称呼用 displayName（结构化字段，铁律 4）；若 displayName 异常含 PII（手机号/邮箱）仍走 maskPiiInText 掩码
          ctx.contact = c.name ? maskPiiInText(String(c.name)) : null;
          // 结构化画像（铁律 4：数字取 ageNum 数字列，不靠字符串解析）
          if (c.age) ctx.profileSummary.age = c.age;
          if (c.ageNum != null) ctx.profileSummary.ageNum = c.ageNum; // 数字列（防幻觉铁律用）
          if (c.region) ctx.profileSummary.region = c.region;
          if (c.onlineTier) ctx.profileSummary.onlineTier = c.onlineTier;
          if (c.unread != null) ctx.profileSummary.unread = c.unread; // 未读数（结构化，防编造）
          if (Array.isArray(c.interests) && c.interests.length) ctx.profileSummary.interests = c.interests;
        }
      } catch (e) { console.error('[assistant.buildContext] 读客户画像失败:', e && e.message); }
    }
    // AccountPersona（白名单 3 字段；personaStore 缺省则 persona={} 不进 prompt，不构造默认值）
    if (deps.personaStore && typeof deps.personaStore.getActiveByAccount === 'function') {
      try {
        const row = deps.personaStore.getActiveByAccount(opts.accountId || 'default');
        ctx.persona = maskPersonaToPrompt(row); // 仅 persona/tone/background 3 列；本名/真名/手机号永不进
      } catch (e) { console.error('[assistant.buildContext] 读 AccountPersona 失败:', e && e.message); }
    }
    // 消息摘要（最近 N 条，截断 160 字/条 + PII 掩码，spec §5.2）
    const maxN = opts.maxMsgs || 12;
    if (Array.isArray(history) && history.length) {
      ctx.recentMessages = history.slice(-maxN).map(function(m) {
        return { role: m.role || m.direction || 'in', text: maskPiiInText(String(m.text || m.body || '')).slice(0, 160), ts: m.ts || m.timeIso || null };
      });
    }
    return ctx;
  }

  // ---------- B v1.1 强制 JSON 契约的 LLM 调用（system 增 intent 侧重 + 输出契约 + 白名单人设）----------
  async function askLLM(userMessage, context, intent) {
    // 取可用模型：modelStore.getActive() → 否则 settings.model
    let modelCfg = null;
    if (modelStore && typeof modelStore.getUsableActive === 'function') {
      try { modelCfg = modelStore.getUsableActive() || null; } catch (e) { modelCfg = null; }
    }
    if (!modelCfg && modelStore && typeof modelStore.getActive === 'function') {
      try { modelCfg = modelStore.getActive() || null; } catch (e) { modelCfg = null; }
    }
    const baseUrl = modelCfg ? modelCfg.baseUrl : null;
    const apiKey = modelCfg ? modelCfg.apiKey : null;
    const model = modelCfg ? modelCfg.model : null;
    if (!modelCfg || !baseUrl || !apiKey || !model) {
      return { degraded: true, reason: '模型未配置或不可用', reply: localFallback(userMessage, context), analysis: '', strategy: '', replies: [] };
    }
    // system prompt：persona + 人设白名单 3 字段 + intent 侧重 + 工具清单 + 强制 JSON 输出契约
    const personaWhitelist = maskPersonaToPrompt(context.persona || {}); // 二次兜底（只回传 3 字段）
    const personaPart = Object.keys(personaWhitelist).length
      ? '账号人设（白名单字段，仅身份/口吻/背景，不含本名/真名/手机号）：' + JSON.stringify(personaWhitelist) + '\n'
      : '';
    const intentPart = intent ? INTENT_PROMPT_HINT[intent] : '当前意图 = 自由问答（无 intent，B v1 行为）。\n';
    const typeHint = intent ? ('replies[].type 默认按 intent 映射：' + INTENT_TYPE_MAP[intent] + '（可混合其他 type，前端逐条按实际 type 渲染）') : 'replies[].type 从 opening/followup/deflect/meet/close/other 中选取';
    const system = ASSISTANT_PERSONA + '\n\n' +
      personaPart +
      intentPart +
      '可用工具（只能从下列 type 里出动作，强副作用仅生成卡片由用户确认，你自己永不直接发送）：\n' +
      JSON.stringify(context.tools, null, 1) +
      '\n当前客户：' + (context.contact || '(未选择)') +
      (Object.keys(context.profileSummary).length ? '\n客户画像（结构化，数字只引用此处的 ageNum/条数）：' + JSON.stringify(context.profileSummary) : '') +
      '\n最近消息（已掩码 PII，结构化摘要）：' + JSON.stringify(context.recentMessages.map(function(m) { return m.role + ': ' + m.text; }).join('\n') || '(无)') +
      '\n\n' + LANGUAGE_RULE + '\n' + REPLY_COUNT_RULE + '\n' +
      '\n【输出契约（B v1.1 强制）】只输出一个 JSON 对象，不得输出 Markdown/解释文字/代码块外的内容。结构：\n' +
      '{"analysis":"客户心理/画像解读（简体中文，可空串）","strategy":"应对策略要点（简体中文，可空串）","replies":[{"type":"' + (INTENT_TYPE_MAP[intent] || 'other') + '","content":"填入 msgInput 的日文话术原文（带正常换行段落）","translation":"该条 content 对应的简体中文译文（与 content 一一对应，可空串）"}],"actions":[{"type":"工具type","label":"按钮文案","payload":{}}]}\n' +
      'replies[].type 枚举 = ' + REPLY_TYPES.join('/') + '，' + typeHint + '。缺失/无法确定的字段给空串或空数组，不得编造。\n' +
      LAYOUT_RULE + '\n' + PERSONA_CONSISTENCY + '\n' +
      '【排版范例（脱敏，勿引用真客户数据）】content 示例："こんにちは\\n\\n最近は元気ですか？\\n\\n今度時間ができたら、ゆっくりお話ししませんか？"（问候语独立成段 + 段间空行 + 2-3 短段）；' +
      'translation 示例："你好\\n\\n最近还好吗？\\n\\n有空的话，慢慢聊聊吧？"（与 content 逐段对应）；' +
      '【task-14 称呼 + emoji 范例】content 示例："アルアルさん、こんにちは\\n\\n先日はありがとう٩(ˊωˋ*)۶\\n\\n今度ゆっくりお会いしましょう？"（客户名称呼 + 1 个颜文字 + 段间空行）；' +
      'translation 对应："アルアルさん，你好\\n\\n前几天谢谢你٩(ˊωˋ*)۶\\n\\n下次慢慢见面吧？"（客户名 + 颜文字逐段对应，emoji 进原文不转义）；' +
      '【task-14 返工 · 语言对照范例（四字段语言各自正确，强化锚定）】完整范例：' +
      '{"analysis":"客户（约 30 岁，东京）上次提到工作很忙，情绪偏谨慎，见面意愿中等——需先缓解对方压力再试探邀约。","strategy":"先共情对方的忙碌，给出轻松无压迫感的邀约台阶，观察回应强度再决定推进节奏。","replies":[{"type":"meet","content":"アルアルさん、こんにちは\\n\\n先日はお忙しい中ありがとう٩(ˊωˋ*)۶\\n\\n今度時間ができたら、ほっと一杯どう？","translation":"アルアルさん，你好\\n\\n前几天忙还谢谢你٩(ˊωˋ*)۶\\n\\n下次有空的话，轻松喝一杯？"}]}' +
      '（analysis 简体中文 + strategy 简体中文 + content 日文带换行段落 + translation 中文逐段对应——四字段语言严格分离，索引对齐）；' +
      '【task-15 条数范例（replies 恰好 2 元素 + translation 各对应）】replies 数组恒为 2 条：第 1 条稳重保守（如铺垫试探）+ 第 2 条主动引导（如推进邀约），每 1 条 content 与同索引 translation 一一对应：' +
      '[{"type":"followup","content":"先日はお忙しい中ありがとうございました\\n\\nまたゆっくりお話ししましょう","translation":"前几天百忙中谢谢\\n\\n下次再慢慢聊"},{"type":"meet","content":"今度時間ができたら、ゆっくりお会いしませんか？","translation":"下次有空的话，不慢慢见个面吗？"}]（恰好 2 元素，第 1 保守第 2 主动，translation 索引对齐）。';
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: String(userMessage || '') },
    ];
    try {
      const controller = new AbortController();
      const timer = setTimeout(function() { controller.abort(); }, 60000);
      const res = await fetch(String(baseUrl).replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + String(apiKey).trim() },
        body: JSON.stringify({ model: model, messages: messages, temperature: 0.3 }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) return { degraded: true, reason: 'LLM HTTP ' + res.status, reply: localFallback(userMessage, context), analysis: '', strategy: '', replies: [] };
      const parsed = JSON.parse(text);
      let content = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
      content = String(content || '').trim();
      // B v1.1：LLM 按契约输出单一 JSON 对象 → parseV11 提取 analysis/strategy/replies（容忍代码块/杂字/截断）
      // task-14 返工 · 语言铁律：analysis/strategy 简体中文（LANGUAGE_RULE 强约束 + few-shot 对照锚定），
      //   只有 content 日文 + translation 中文；degraded 路径 reply=localFallback（中文摘要），replies=[]，语言铁律天然守住
      // task-15 · 条数铁律降级兜底：degraded 无 LLM 数据时 replies=[]（空数组不强造 2 条假话术，前端 6 面板按实际 0 条渲染）
      const parsedV11 = parseV11(content);
      if (!parsedV11.ok) {
        // 非标准 JSON（杂字/截断/非 JSON/缺字段）→ degraded + localFallback（spec §6，铁律 2 人工兜底不删）
        return { degraded: true, reason: 'LLM 非标准 JSON，降级本地摘要: ' + parsedV11.err, reply: localFallback(userMessage, context), analysis: '', strategy: '', replies: [] };
      }
      return {
        degraded: false,
        reply: parsedV11.reply || '', // v1.1 起 reply 可为空串（正文并入 analysis/strategy），旧前端仍读 reply 不破坏
        analysis: parsedV11.analysis,
        strategy: parsedV11.strategy,
        replies: parsedV11.replies,
        raw: parsed,
      };
    } catch (e) {
      return { degraded: true, reason: 'LLM 调用失败：' + (e && e.message), reply: localFallback(userMessage, context), analysis: '', strategy: '', replies: [] };
    }
  }

  // ---------- 降级本地摘要（模型不可用时不删功能）----------
  function localFallback(userMessage, context) {
    const msgs = context.recentMessages || [];
    const out = [];
    out.push('（当前为降级模式：模型不可用或非标准 JSON，以下为本地摘要）');
    if (context.contact) out.push('客户：' + context.contact);
    if (context.profileSummary && context.profileSummary.ageNum != null) out.push('年龄（结构化）：' + context.profileSummary.ageNum + ' 岁');
    if (msgs.length) {
      out.push('最近 ' + msgs.length + ' 条消息：');
      msgs.slice(-5).forEach(function(m) { out.push('  [' + m.role + '] ' + m.text); });
    } else {
      out.push('暂无消息数据（可先刷新收件箱）。');
    }
    out.push('建议动作：' + TOOL_WHITELIST.filter(function(t) { return t.sideEffect !== 'strong'; }).map(function(t) { return t.label; }).join('、'));
    return out.join('\n');
  }

  // ---------- 解析 LLM 输出里的动作卡片（容忍 JSON 块 / 纯文本）----------
  function parseActions(reply, context) {
    const actions = [];
    // 尝试抓 ```json [...] ``` 或裸 [ {...} ] 动作数组
    const m = String(reply || '').match(/\[\s*\{[\s\S]*?\}\s*\]/);
    if (m) {
      try {
        const arr = JSON.parse(m[0]);
        if (Array.isArray(arr)) arr.forEach(function(a) {
          const type = String(a.type || a.action || '');
          const known = TOOL_WHITELIST.find(function(t) { return t.type === type; });
          if (!known) return;
          const card = { type: known.type, label: a.label || known.label, payload: a.payload || a.args || {}, sideEffect: known.sideEffect };
          if (known.sideEffect === 'strong') card.needConfirm = true; // 发送类必须用户确认
          actions.push(card);
        });
      } catch (e) { console.warn('[assistant.parseActions] 动作 JSON 解析失败（actions=[] 静默，正文照回）:', e && e.message); }
    }
    return actions;
  }

  // ---------- B v1.1 parseV11：容忍 json 代码块/前后杂字/截断（spec §3「容忍 json 代码块包裹与前后空白」）----------
  /** @returns {object} { ok, analysis?, strategy?, replies?, reply?, err? } */
  function parseV11(text) {
    let t2 = String(text || '').trim();
    if (!t2) return { ok: false, err: '空输出' };
    // 容忍 ```json ... ``` / ``` ... ``` 代码块包裹（取首块）
    const codeBlock = t2.match(/`{3}(?:json)?\s*([\s\S]*?)`{3}/i);
    if (codeBlock && codeBlock[1]) t2 = codeBlock[1].trim();
    // 容忍前后杂字：从首个 { 到末个 } 截取（截断无 } 则补全再试）
    const firstBrace = t2.indexOf('{');
    if (firstBrace !== -1) {
      const lastBrace = t2.lastIndexOf('}');
      t2 = lastBrace > firstBrace ? t2.slice(firstBrace, lastBrace + 1) : t2.slice(firstBrace);
    }
    // 纯文本无任何 { 结构 → spec §6「非标准 JSON/非 JSON」判定失败（触发 degraded + localFallback）
    if (t2.indexOf('{') === -1) return { ok: false, err: '纯文本无 JSON 结构（非标准 JSON，触发 degraded）' };
    try {
      const obj = JSON.parse(t2);
      return Object.assign({ ok: true }, normalizeV11(obj));
    } catch (e1) {
      // 截断容错（spec「截断」容忍边界）：补右括号 → 仍失败则逐对补 "k":"v" → 仍失败降级
      let openCount = (t2.match(/{/g) || []).length;
      let closeCount = (t2.match(/}/g) || []).length;
      let repaired = t2;
      for (let i = 0; i < openCount - closeCount; i++) repaired += '}';
      try {
        return Object.assign({ ok: true }, normalizeV11(JSON.parse(repaired)));
      } catch (e1b) {
        // 截断在数组元素中间（如 [{"type":"meet","content":"c"}] 缺右 ]）：补 ] 后再补 }
        try {
          const openBracket = (repaired.match(/\[/g) || []).length;
          const closeBracket = (repaired.match(/\]/g) || []).length;
          let repaired2 = repaired;
          for (let i = 0; i < openBracket - closeBracket; i++) repaired2 += ']';
          openCount = (repaired2.match(/{/g) || []).length;
          closeCount = (repaired2.match(/}/g) || []).length;
          for (let i = 0; i < openCount - closeCount; i++) repaired2 += '}';
          return Object.assign({ ok: true }, normalizeV11(JSON.parse(repaired2)));
        } catch (e1c) {
          // 最后兜底：截取最后一个完整 "analysis"/"strategy" 字符串值构造最小对象（保 analysis 不丢）
          const aM = t2.match(/"analysis"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          const sM = t2.match(/"strategy"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          const rM = t2.match(/"replies"\s*:\s*\[([\s\S]*)/);
          const minObj = { analysis: aM ? aM[1] : '', strategy: sM ? sM[1] : '' };
          if (rM && rM[1]) {
            minObj.replies = rM[1].split('\},').map(function(chunk) {
              const cM = chunk.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
              const tM = chunk.match(/"type"\s*:\s*"([A-Za-z]+)"/);
              return { type: tM ? tM[1] : 'other', content: cM ? cM[1] : '' };
            }).filter(function(r) { return r.content; });
          }
          return Object.assign({ ok: true }, normalizeV11(minObj));
        }
      }
    }
  }

  /** 归一化 LLM JSON → { analysis, strategy, replies, reply }（未知 type 按 other，缺字段给空串/空数组） */
  function normalizeV11(obj) {
    const analysis = obj && typeof obj.analysis === 'string' ? obj.analysis : '';
    const strategy = obj && typeof obj.strategy === 'string' ? obj.strategy : '';
    const rawReplies = Array.isArray(obj && obj.replies) ? obj.replies.map(function(r) {
      if (!r || typeof r !== 'object') return null;
      let type = String(r.type || 'other');
      if (REPLY_TYPES.indexOf(type) < 0) type = 'other'; // 未知 type 一律 other（spec §3 前端未知 type 按 other 渲染）
      const content = String(r.content || '');
      // task-13 · translation 字段（简体中文译文，与 content 一一对应；容忍缺失 → ''，旧响应无 translation 前端自然降级不渲染，双向兼容 §3.4 不破）
      let translation = String(r.translation || '');
      if (translation) translation = maskPiiInText(translation); // 脱敏红线：译文若引客户 PII（手机号/邮箱/真名）也掩码（别只掩 content）
      return { type: type, content: content, translation: translation };
    }).filter(function(r) { return r && r.content; }) : [];
    // task-15 · 条数铁律防御截断：>2 条取前 2（LLM 偶发多输出时截断，前端 6 面板最多 2 成对渲染）；
    //   <2 条保留实际条数不强造（1 条就 1 条，避免假数据）——契约固定 2 条是 Prompt 强约束，解析层只做上限防御
    const replies = rawReplies.length > 2 ? rawReplies.slice(0, 2) : rawReplies;
    const reply = obj && typeof obj.reply === 'string' ? obj.reply : '';
    return { analysis: analysis, strategy: strategy, replies: replies, reply: reply };
  }

  // ---------- 对外主入口 ----------
  // B v1.1：请求体新增 intent（缺省/未知 = null → 自由问答，B v1 行为不变；向后兼容矩阵 §3.4）
  async function chat(opts) {
    opts = opts || {};
    const message = String(opts.message || '').trim();
    if (!message) return { ok: false, reason: 'empty-message', msg: '缺少 message' };
    const history = Array.isArray(opts.history) ? opts.history : [];
    const intent = (opts.intent && INTENT_TYPE_MAP[opts.intent]) ? opts.intent : null; // intent 校验（缺省/未知 = null）
    const context = buildContext(opts.contactId, history, Object.assign({}, opts, { intent: intent }));
    const llm = await askLLM(message, context, intent);
    const actions = parseActions(llm.reply, context);
    return {
      ok: true,
      degraded: !!llm.degraded,
      reason: llm.reason || '',
      reply: llm.reply || '',
      // ---- B v1.1 扩展字段（缺省空串/空数组，旧前端不渲染 = 零破坏）----
      analysis: llm.analysis || '',
      strategy: llm.strategy || '',
      replies: Array.isArray(llm.replies) ? llm.replies : [],
      intent: intent, // 回显（旧前端忽略新字段 = 兼容矩阵 §3.4）
      actions: actions,
      contact: context.contact,
      fetchedAt: new Date().toISOString(),
    };
  }

  return {
    chat: chat,
    buildContext: buildContext,
    parseActions: parseActions,
    parseV11: parseV11,             // B v1.1 导出（供测试直查容忍边界）
    normalizeV11: normalizeV11,    // 导出（测试）
    maskPersonaToPrompt: maskPersonaToPrompt, // 脱敏白名单（与 talkEngine L363 共用，测试）
    maskPiiInText: maskPiiInText, // PII 掩码（测试）
    TOOL_WHITELIST: TOOL_WHITELIST,
    INTENT_TYPE_MAP: INTENT_TYPE_MAP,
  };
}

// 导出脱敏工具供 talkEngine 共用（spec §5.3 统一口径，两处不各写一套）
module.exports = { createAssistant: createAssistant, maskPersonaToPrompt: maskPersonaToPrompt, maskPiiInText: maskPiiInText, INTENT_TYPE_MAP: INTENT_TYPE_MAP };
