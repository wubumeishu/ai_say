'use strict';
// =============================================================================
// Ai SAY · 助手面板 B v1（assistant.js）
// POST /api/console/assistant 的后端：组上下文（画像+消息摘要+工具清单）→ 调 LLM →
// 返回 { reply, actions:[{type,label,payload}] }。只读/弱副作用工具直接给；强副作用
// （send_message）只生成「动作卡片」，前端渲染按钮，用户点了才走 send-live 真发。
// 铁律：LLM 永不直接发送；模型不可用 → 降级到本地摘要（不删功能）；数字只取结构化数据。
// =============================================================================
const { createRequire } = require('module');

const ASSISTANT_PERSONA = '你是「Ai SAY 助手」，出会平台运营控制台的 AI 会话助手，服务运营者（用户）。用简体中文回复；引用客户消息可保留日文原文。专业、简洁、信息密度高；不确定直说，不编造。年龄/条数/时间等事实只引用系统提供的结构化数据，不得编造；数据不足时说「没有数据」并提示可先刷新。模型或数据不可用时降级为本地摘要回复，并告知用户当前是降级模式。涉及发送必须标注「发送需你确认」，你自己永不直接发送。';

const TOOL_WHITELIST = [
  { type: 'get_customer', label: '读客户画像', sideEffect: 'none', desc: '读当前客户画像 + 最近消息摘要' },
  { type: 'list_customers', label: '列客户', sideEffect: 'none', desc: '列出/筛选客户（未读/在线/地区/年龄）' },
  { type: 'search_customers', label: '搜客户', sideEffect: 'none', desc: '按条件筛选客户' },
  { type: 'generate_replies', label: '生成话术', sideEffect: 'none', desc: '生成推荐话术（只生成，不发送）' },
  { type: 'translate', label: '翻译', sideEffect: 'none', desc: '日⇄中翻译' },
  { type: 'fill_draft', label: '填入输入框', sideEffect: 'weak', desc: '把话术填入消息输入框（用户自行点发送）' },
  { type: 'mark_read', label: '标记已读', sideEffect: 'weak', desc: '控制台内部操作' },
  { type: 'switch_customer', label: '切客户', sideEffect: 'weak', desc: '控制台内部操作' },
  { type: 'send_message', label: '发送消息', sideEffect: 'strong', desc: '必须由用户在动作卡片上点确认后才执行，走 send-live' },
];

function createAssistant(deps) {
  deps = deps || {};
  const modelStore = deps.modelStore || null;
  const aiService = deps.aiService || null;
  const ichigoCache = deps.ichigoCache || null;

  // ---------- 上下文组装（结构化数据，防幻觉）----------
  function buildContext(contactId, history, opts) {
    opts = opts || {};
    const ctx = {
      contactId: String(contactId || ''),
      contact: null,
      profileSummary: {},
      recentMessages: [],
      tools: TOOL_WHITELIST.map(function(t) { return { type: t.type, label: t.label, sideEffect: t.sideEffect, desc: t.desc }; }),
      degraded: false,
    };
    // 客户画像（ichigoCache）
    if (ichigoCache && typeof ichigoCache.getContact === 'function' && contactId) {
      try { const c = ichigoCache.getContact(contactId); ctx.contact = c ? c.name : null; } catch (e) {}
    }
    // 消息摘要（最近 N 条，截断防超长）
    const maxN = opts.maxMsgs || 12;
    if (Array.isArray(history) && history.length) {
      ctx.recentMessages = history.slice(-maxN).map(function(m) {
        return { role: m.role || m.direction || 'in', text: String(m.text || m.body || '').slice(0, 160), ts: m.ts || m.timeIso || null };
      });
    }
    return ctx;
  }

  // ---------- 调 LLM（带工具清单 + 人设），失败降级 ----------
  async function askLLM(userMessage, context) {
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
      return { degraded: true, reason: '模型未配置或不可用', reply: localFallback(userMessage, context) };
    }
    const system = ASSISTANT_PERSONA + '\n\n可用工具（只能从下列 type 里出动作，强副作用仅生成卡片由用户确认）：\n' +
      JSON.stringify(context.tools, null, 1) +
      '\n当前客户：' + (context.contact || '(未选择)') +
      '\n最近消息（结构化摘要）：' + JSON.stringify(context.recentMessages.map(function(m) { return m.role + ': ' + m.text; }).join('\n') || '(无)');
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
      if (!res.ok) return { degraded: true, reason: 'LLM HTTP ' + res.status, reply: localFallback(userMessage, context) };
      const parsed = JSON.parse(text);
      let content = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
      content = String(content || '').trim();
      return { degraded: false, reply: content, raw: parsed };
    } catch (e) {
      return { degraded: true, reason: 'LLM 调用失败：' + (e && e.message), reply: localFallback(userMessage, context) };
    }
  }

  // ---------- 降级本地摘要（模型不可用时不删功能）----------
  function localFallback(userMessage, context) {
    const msgs = context.recentMessages || [];
    const out = [];
    out.push('（当前为降级模式：模型不可用，以下为本地摘要）');
    if (context.contact) out.push('客户：' + context.contact);
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
      } catch (e) { /* 解析失败就只回正文，不出动作 */ }
    }
    return actions;
  }

  // ---------- 对外主入口 ----------
  async function chat(opts) {
    opts = opts || {};
    const message = String(opts.message || '').trim();
    if (!message) return { ok: false, reason: 'empty-message', msg: '缺少 message' };
    const history = Array.isArray(opts.history) ? opts.history : [];
    const context = buildContext(opts.contactId, history, opts);
    const llm = await askLLM(message, context);
    const actions = parseActions(llm.reply, context);
    return {
      ok: true,
      degraded: !!llm.degraded,
      reason: llm.reason || '',
      reply: llm.reply || '',
      actions: actions,
      contact: context.contact,
      fetchedAt: new Date().toISOString(),
    };
  }

  return { chat: chat, buildContext: buildContext, parseActions: parseActions, TOOL_WHITELIST: TOOL_WHITELIST };
}

module.exports = { createAssistant: createAssistant };
