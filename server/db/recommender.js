// =============================================================================
// Ai SAY M1 补强 · 推荐回复生成器（recommender.js）
// 依据：task-24 —— 推荐回复「接实」到现有 aiService，对齐 M1 验收
//       「推荐回复符合账号人设与统一规则」。
//
// 导出：createRecommender({ store, aiService, leadScoring, talkEngine, auditLog })
//
// API：
//   recommendReply({ conversationId, accountPersona, customerProfile,
//                    governanceRules, tier, messages, useLLM })
//     → { ok, replies: [1..3 条], source: 'ai'|'template', tier,
//         gated: [{text, ok, reason?}], leadEvent, note? }
//
// 设计（对齐任务要求）：
//   1. prompt 组装强制加载三要素：
//        - 账号人设：accountPersona（persona/tone/background/taboo + taboos 红线）；
//        - 客户画像：customerProfile（intent/interests/region/age/name）；
//        - 统一规则：governanceRules（compliance 红线词必须过滤，denyByDefault 语义沿用）；
//   2. tier 分流（省 token 原则）：
//        hot   → aiService.chatCompletion({settings, messages, model, temperature:0.3, maxTokens:300})
//                —— 入参形状对齐 server/aiService.js chatCompletion 真实签名；
//                aiService.isConfigured(settings)===false 或调用失败 ⇒ 降级 talkEngine 模板兜底（绝不卡死）；
//        warm/cold → 直接 talkEngine.buildTalks 模板（不走 LLM）；
//   3. 每条回复过 GovernanceRule 合规闸门（compliance 黑名单/speechBoundary 命中即丢弃，
//      全部丢弃时 source='template' 兜底并标记）；
//   4. 结果写 LeadEvent(action='triggered') + auditLog（append-only；'replied' 语义写入
//      auditLog 的 action 字段——LeadEvent 表 CHECK 约束仅 triggered/reminded/archived，
//      'replied' 无法直接入库，见 auditLog 记录）。
//
// 约束：不重写 aiService.js（只调用）；不写 DOM/UI；走单一写入路径
//      （LeadEvent 经 leadScoring.writeLeadEvent 或 store 直写，不新增写入口）。
// =============================================================================
'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------- prompt ----
/**
 * 组装 LLM prompt（三要素强制加载）
 * @returns {{ system: string, user: string }}
 */
function buildPrompt({ accountPersona, customerProfile, governanceRules, messages, tier }) {
  const persona = accountPersona || {};
  const prof = customerProfile || {};
  const rules = (governanceRules && governanceRules.rules) || [];

  // --- 人设要素 ---
  let personaBlock;
  if (persona.persona && typeof persona.persona === 'object') {
    personaBlock = '【账号人设】' + JSON.stringify(persona.persona);
  } else {
    personaBlock = '【账号人设】自称/身份：' + (persona.persona || '(未设人设，用默认亲切客服语气)');
  }
  if (persona.tone) personaBlock += '\n语气基调：' + persona.tone;
  if (persona.background) personaBlock += '\n背景：' + persona.background;
  const taboos = Array.isArray(persona.taboos) ? persona.taboos : [];
  if (taboos.length) personaBlock += '\n人设禁忌（必须遵守）：' + taboos.join('、');

  // --- 客户画像要素 ---
  const profLines = [
    prof.name ? '称呼：' + prof.name : '',
    prof.age ? '年龄：' + prof.age : '',
    prof.region ? '地区：' + prof.region : '',
    prof.intent ? '意向：' + prof.intent : '',
    Array.isArray(prof.interests) ? '兴趣：' + prof.interests.join('、') : (prof.interest ? '兴趣：' + prof.interest : ''),
    prof.lastSeen ? '最近活跃：' + prof.lastSeen : '',
  ].filter(Boolean);
  const profileBlock = profLines.length ? '【客户画像】\n' + profLines.join('\n') : '【客户画像】(无画像数据)';

  // --- 统一规则要素（compliance 红线必须过滤）---
  const redWords = [];
  for (const r of rules) {
    let spec = null;
    try { spec = r.rule ? JSON.parse(r.rule) : null; } catch (e) { spec = null; }
    if (!spec) continue;
    if (r.ruleType === 'compliance' && Array.isArray(spec.keywords)) redWords.push(...spec.keywords);
    if (r.ruleType === 'speechBoundary' && Array.isArray(spec.forbidden)) redWords.push(...spec.forbidden);
  }
  let rulesBlock = '【统一规则约束】';
  if (redWords.length) rulesBlock += '\n合规红线词（回复中出现任一词即作废）：' + redWords.join('、');
  else rulesBlock += '\n(当前无额外红线词，仍须遵守平台私信礼仪)';
  if (governanceRules && governanceRules.denyByDefault) rulesBlock += '\n注：compliance 默认拒绝（denyByDefault）——拿不准的话术宁可不发。';

  // --- 最近消息 ---
  const history = (Array.isArray(messages) ? messages : [])
    .slice(-12)
    .map((m) => ((m.role === 'self' || m.role === 'me') ? 'self' : 'peer') + ': ' + String(m.translation || m.original || m.text || ''))
    .join('\n');

  const system =
    personaBlock + '\n\n' + profileBlock + '\n\n' + rulesBlock +
    '\n\n你是该账号的自动回复助手。客户在私域对话中，请给出 1-3 条推荐回复。\n' +
    '要求：每条一行、不编号、无多余说明；贴合人设语气与客户画像；' +
    (tier === 'hot' ? '高意向客户——主动推进到留 LINE / 报价 / 见面等下一步动作；' : '按当前意向档位自然回应，不强推；') +
    '语言跟随客户最近一条消息的语言。';

  const user = '对话历史（self=我方账号, peer=客户）：\n' + (history || '(empty)') +
    '\n当前档位：' + (tier || 'warm') + '\n给出 1-3 条推荐回复。';

  return { system, user };
}

// ---------------------------------------------------------------- 合规闸门 --
/**
 * 对单条回复跑 GovernanceRule 闸门（compliance 红线 / speechBoundary）
 * → { ok, reason }
 */
function gateReply(text, governanceRules) {
  const rules = (governanceRules && governanceRules.rules) || [];
  const lower = String(text || '').toLowerCase();
  for (const r of rules) {
    let spec = null;
    try { spec = r.rule ? JSON.parse(r.rule) : null; } catch (e) { spec = null; }
    if (!spec) continue;
    if (r.ruleType === 'compliance') {
      const kws = Array.isArray(spec.keywords) ? spec.keywords : [];
      const hit = kws.filter((k) => lower.includes(String(k).toLowerCase()));
      if (hit.length) return { ok: false, reason: 'compliance 红线命中: ' + hit.join(',') };
    }
    if (r.ruleType === 'speechBoundary') {
      const forbidden = Array.isArray(spec.forbidden) ? spec.forbidden : [];
      const hit = forbidden.filter((k) => lower.includes(String(k).toLowerCase()));
      if (hit.length) return { ok: false, reason: 'speechBoundary 禁止词: ' + hit.join(',') };
      if (typeof spec.maxLen === 'number' && String(text || '').length > spec.maxLen) {
        return { ok: false, reason: '超长（>' + spec.maxLen + '）' };
      }
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------- 拆分 ----
/** LLM 输出 → 1-3 条回复（按行拆分，去编号，过滤空行） */
function splitReplies(raw, max = 3) {
  const lines = String(raw || '')
    .split('\n')
    .map((s) => s.replace(/^\s*\d+[.、)）]\s*/, '').replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);
  return lines.slice(0, max);
}

// ================================================================ 引擎 ====
function createRecommender(opts = {}) {
  const store = opts.store || null;
  const aiService = opts.aiService || null;
  const leadScoring = opts.leadScoring || null;
  const talkEngine = opts.talkEngine || null;
  const auditLog = Array.isArray(opts.auditLog) ? opts.auditLog : [];
  const nowIso = opts.nowIso || (() => new Date().toISOString());

  /** 写 auditLog（append-only；action='replied' 的完整记录在此） */
  function audit(entry) {
    const rec = Object.assign({ ts: nowIso() }, entry, { action: entry.action || 'replied' });
    auditLog.push(rec);
    // 可选：落库（RecommenderAudit 表不存在时惰性建；失败不阻断）
    if (store && store.db) {
      try {
        store.db.exec(
          'CREATE TABLE IF NOT EXISTS RecommenderAudit (' +
          '  id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
          '  conversationId TEXT, contactId TEXT, tier TEXT, source TEXT, ' +
          '  replyCount INTEGER, gated INTEGER, note TEXT, ts TEXT NOT NULL)'
        );
        store.db.prepare(
          'INSERT INTO RecommenderAudit (conversationId,contactId,tier,source,replyCount,gated,note,ts) VALUES (?,?,?,?,?,?,?,?)'
        ).run(
          rec.conversationId || null, rec.contactId || null, rec.tier || '',
          rec.source || '', rec.replyCount != null ? rec.replyCount : 0,
          rec.gated != null ? rec.gated : 0, rec.note || '', rec.ts
        );
      } catch (e) { /* 表创建失败不阻断主流程 */ }
    }
    return rec;
  }

  /** 写 LeadEvent（单一写入路径：leadScoring.writeLeadEvent → 无则 store 直写） */
  function writeLeadEvent(evt) {
    if (leadScoring && typeof leadScoring.writeLeadEvent === 'function') {
      const out = leadScoring.writeLeadEvent(Object.assign({ action: 'triggered' }, evt));
      return Object.assign({}, out, { via: 'leadScoring' });
    }
    if (store && store.db) {
      const now = nowIso();
      const id = crypto.createHash('sha1').update('lead/reply/' + (evt.contactId || '') + '/' + now + '/' + Math.random()).digest('hex');
      store.db.prepare(
        'INSERT OR IGNORE INTO LeadEvent (leadEventId,contactId,score,tier,signals,action,lineOffered,lineAdded,createdAt) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run(id, evt.contactId || '', evt.score || 0, evt.tier || 'warm',
        JSON.stringify(evt.signals || []), 'triggered', 0, 0, now);
      return Object.assign({ leadEventId: id }, evt, { via: 'db' });
    }
    return Object.assign({ via: 'noop' }, evt);
  }

  /** 兜底：talkEngine 模板（warm/cold 直走；hot 降级也用） */
  function templateReplies({ conversationId, accountPersona, customerProfile, governanceRules, tier }) {
    if (!talkEngine || typeof talkEngine.buildTalks !== 'function') return [];
    const t = talkEngine.buildTalks(
      'outreach', 'ja', tier || 'warm', 'platform_dm',
      accountPersona, customerProfile, governanceRules
    );
    const out = [];
    if (t.texts && t.texts.guide) out.push(t.texts.guide);
    if (t.texts && t.texts.remind) out.push(t.texts.remind);
    return out.slice(0, 3);
  }

  /**
   * recommendReply({ conversationId, accountPersona, customerProfile,
   *                  governanceRules, tier, messages, useLLM })
   * → { ok, replies, source: 'ai'|'template'|'none', tier,
   *     gated: [{text,ok,reason?}], leadEvent, audit, note? }
   */
  async function recommendReply(ctx = {}) {
    ctx = ctx || {};
    const tier = ctx.tier || 'warm';
    const governanceRules = ctx.governanceRules || { rules: [], denyByDefault: false };
    const candidate = [];
    let source = 'none';
    let note = '';

    // ---- hot：LLM（对齐 aiService.chatCompletion 真实入参形状）----
    if (tier === 'hot') {
      const useLLM = ctx.useLLM !== false &&
        aiService && typeof aiService.chatCompletion === 'function';
      if (useLLM) {
        try {
          const settings = aiService.loadAiSettings ? aiService.loadAiSettings() : {};
          const configured = aiService.isConfigured ? aiService.isConfigured(settings) : false;
          if (configured) {
            const { system, user } = buildPrompt({
              accountPersona: ctx.accountPersona,
              customerProfile: ctx.customerProfile,
              governanceRules,
              messages: ctx.messages,
              tier,
            });
            const out = await aiService.chatCompletion({
              settings,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
              model: ctx.model,          // 缺省由 aiService 用 settings.model/visionModel
              temperature: 0.3,
              maxTokens: 300,
            });
            const lines = splitReplies(out, 3);
            if (lines.length) { candidate.push(...lines); source = 'ai'; }
            else { note = 'LLM 输出为空，降级模板'; }
          } else {
            note = 'AI 未配置（isConfigured=false），降级 talkEngine 模板';
          }
        } catch (e) {
          note = 'LLM 调用失败（' + e.message + '），降级 talkEngine 模板';
        }
      } else {
        note = 'aiService 未注入，hot 走模板兜底';
      }
    }

    // ---- 全档位兜底 / warm/cold 模板直出 ----
    if (candidate.length === 0) {
      const tpl = templateReplies(ctx);
      candidate.push(...tpl);
      if (source === 'none') source = 'template';
      else source = 'ai+template';
    }

    // ---- 合规闸门：逐条过滤（compliance 红线命中即丢弃）----
    const gated = candidate.map((text) => {
      const g = gateReply(text, governanceRules);
      return g.ok ? { text, ok: true } : { text, ok: false, reason: g.reason };
    });
    const replies = gated.filter((g) => g.ok).map((g) => g.text);

    // 全被闸门拦：模板兜底再试一次（若还没用模板）
    if (replies.length === 0 && source.indexOf('template') === -1) {
      const tpl = templateReplies(ctx);
      const retried = tpl.map((text) => {
        const g = gateReply(text, governanceRules);
        return { text, ok: g.ok, reason: g.ok ? undefined : g.reason };
      });
      gated.push(...retried);
      const kept = retried.filter((g) => g.ok).map((g) => g.text);
      if (kept.length) {
        replies.push(...kept);
        source = source === 'none' ? 'template' : source + '+template';
      }
    }

    // ---- LeadEvent(action='triggered') + auditLog(action='replied') ----
    const contactId = (ctx.customerProfile && ctx.customerProfile.contactId) || ctx.contactId || '';
    const leadEvent = contactId
      ? writeLeadEvent({
          contactId, tier,
          // task-36 修 Bug：score 必传（LeadEvent.score INTEGER NOT NULL，缺省会绑定 undefined 抛错被吞）
          score: ({ hot: 80, warm: 50, cold: 20 })[tier] || 50,
          signals: [{ signal: 'recommendReply', source, gated: gated.filter((g) => !g.ok).length, replyCount: replies.length }],
          action: 'triggered',
        })
      : null;
    const auditRec = audit({
      conversationId: ctx.conversationId || null,
      contactId: contactId || null,
      tier: tier,
      source: source,
      replyCount: replies.length,
      gated: gated.filter((g) => !g.ok).length,
      note: note,
    });

    return {
      ok: true,
      replies: replies,
      source,
      tier,
      gated,
      leadEvent,
      audit: auditRec,
      note: note || undefined,
    };
  }

  return { recommendReply, buildPrompt, gateReply, splitReplies, auditLog };
}

module.exports = { createRecommender };
