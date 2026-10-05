// =============================================================================
// Ai SAY M3 · 自动引流话术引擎（talkEngine.js）
// 依据：docs/plan/03-acquisition.md §3（话术引擎）+ §6.3（A/B）
//
// 导出：createTalkEngine({ store, leadScoring, aiService, templatesDir })
//
// 职责（严格对齐任务边界）：
//   1. buildTalks(category, language, tier, platform, accountPersona, customerProfile, governanceRules)
//      → 按 品类×语言×意向×平台 匹配模板 + 变量填充（{name}/{region}/{interest} 等）；
//      → hot 客户可选 LLM 个性化（走 aiService.chatCompletion，失败自动规则兜底）；
//   2. 标准动作流程：引导话术(triggered) → 30min 未留 LINE 提醒(reminded, 仅 1 次) → 归档(archived)；
//      每步写 LeadEvent；
//   3. 合规闸门（统一规则优先）：生成前查 governanceRules
//      （compliance 类未命中 ⇒ denyByDefault 默认拒绝）；
//      频控：单客户 24h ≤ 2 条 / 账号级 1h ≤ 20 条 / 每分钟 cap（rateLimit 规则可覆盖）；
//      命中黑名单（compliance rule.keywords 命中）⇒ 直接拦截；
//      hot 客户默认走人工闸门（manualGates，需 approveManual 放行）；
//   4. 话术 A/B 双变体：按 contactId 哈希固定分流（同一客户体验一致），
//      样本 ≥ 200/组时双比例 z 检验裁决，统计写 store；
//   5. 不写画像抽取（消费 M1 leadScoring 的 tier/评分），不写 DOM
//      （platform send 走 adapter.send 契约：sendHook 由调用方注入），不写 UI。
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

// 默认合规频控参数（可被 governanceRules 的 rateLimit 规则覆盖）
const DEFAULT_LIMITS = {
  perCustomerPerDay: 2,   // 单客户 24h ≤ 2 条
  perAccountPerHour: 20,  // 账号级 1h ≤ 20 条
  perMinuteCap: 10,       // 每分钟全局 cap
  remindWindowMin: 30,    // 30min 未留 LINE → 提醒 1 次
  archiveAfterRemind: true,
};

// ---------------------------------------------------------------- 模板加载 --
/**
 * 模板文件：templates/{platform}/{category}.{language}.json（缺失层级向上回退）：
 *   {platform}/{category}.{language}.json
 *   → {platform}/_default.{language}.json
 *   → _default/{category}.{language}.json
 *   → _default/_default.{language}.json
 * 文件格式：{ vars: [...], variants: { A: {...}, B: {...} } }
 *   variants.X = { guide: '引导话术（含 {var} 占位符）', remind: '提醒话术', vars?: {...} }
 */
function loadTemplate(templatesDir, platform, category, language) {
  if (!templatesDir) return null;
  const p = String(platform || '_default');
  const c = String(category || '_default');
  const l = String(language || '_default');
  const candidates = [
    path.join(templatesDir, p, c + '.' + l + '.json'),
    path.join(templatesDir, p, '_default.' + l + '.json'),
    path.join(templatesDir, '_default', c + '.' + l + '.json'),
    path.join(templatesDir, '_default', '_default.' + l + '.json'),
  ];
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        return { file: f, template: raw };
      }
    } catch (err) {
      return { file: f, template: null, error: String(err.message || err) };
    }
  }
  return null;
}

/** 变量填充：{name}/{region}/{interest} 等；persona 注入语气前缀 */
function fillTemplate(text, vars, persona) {
  let out = String(text || '');
  const v = Object.assign({}, persona ? { personaTone: persona.tone || '', personaBackground: persona.background || '' } : {}, vars || {});
  out = out.replace(/\{(\w+)\}/g, (m, key) => (v[key] != null ? String(v[key]) : m));
  // 人设语气前缀：话术以人设签名/称呼开头，保证「账号人设 + 客户画像」贴合
  const greet = v.name ? (v.greeting || ('こんにちは、' + v.name + 'さん')) : '';
  if (greet && !out.startsWith(greet)) out = greet + ' ' + out;
  return out;
}

// ------------------------------------------------------------ 合规闸门 ----
/**
 * checkGate() → { ok, reason, matchedRules, blacklisted }
 *  1. compliance 规则命中（rule 内含 keywords 数组）⇒ 直接拒绝；
 *  2. denyByDefault：compliance 类存在但无 allow 命中 ⇒ 拒绝（store.getEffectiveRules 语义）；
 *  3. rateLimit 规则覆盖默认频控参数；
 *  4. 黑名单关键词（speechBoundary）命中 ⇒ 拦截。
 * rules: { rules: [...], denyByDefault }（来自 store.getEffectiveRules）
 */
function checkGate({ text, rules, limits, persona }) {
  rules = rules || { rules: [], denyByDefault: false };
  limits = limits || {}; // task-36：rateLimit 规则 Object.assign(limits, spec) 需 limits 为对象
  const matched = [];
  let blocked = false;
  let reason = '';

  // 1) compliance 命中判定：rule.keywords 命中 ⇒ 该条话术直接拦截（合规红线）
  for (const r of rules.rules) {
    let spec = null;
    if (r.rule) { try { spec = JSON.parse(r.rule); } catch (e) { spec = null; } }
    spec = spec || {};
    const kws = Array.isArray(spec.keywords) ? spec.keywords : [];
    const lower = String(text || '').toLowerCase();
    const hitKw = kws.filter((k) => lower.includes(String(k).toLowerCase()));
    if (r.ruleType === 'compliance') {
      if (hitKw.length) {
        blocked = true;
        reason = 'compliance 规则命中黑名单词: ' + hitKw.join(',');
        matched.push({ ruleId: r.ruleId, ruleType: r.ruleType, hitKw });
      } else if (spec.allow === true && hitKw.length === 0) {
        matched.push({ ruleId: r.ruleId, ruleType: r.ruleType, allow: true });
      }
    } else if (r.ruleType === 'speechBoundary') {
      // 话术边界：maxLen / forbidden
      if (typeof spec.maxLen === 'number' && String(text || '').length > spec.maxLen) {
        blocked = true; reason = 'speechBoundary: 超长（>' + spec.maxLen + '）'; matched.push({ ruleId: r.ruleId });
      }
      const forbidden = Array.isArray(spec.forbidden) ? spec.forbidden : [];
      const fHit = forbidden.filter((k) => lower.includes(String(k).toLowerCase()));
      if (fHit.length) { blocked = true; reason = 'speechBoundary 命中禁止词: ' + fHit.join(','); matched.push({ ruleId: r.ruleId, fHit }); }
    } else if (r.ruleType === 'rateLimit') {
      // 覆盖默认频控：spec = { perCustomerPerDay, perAccountPerHour, perMinuteCap }
      Object.assign(limits, spec);
      matched.push({ ruleId: r.ruleId, overridden: spec });
    }
  }
  // 2) denyByDefault：存在 compliance 类规则但没有任一 allow 命中 ⇒ 默认拒绝
  const hasCompliance = rules.rules.some((r) => r.ruleType === 'compliance');
  if (!blocked && hasCompliance && rules.denyByDefault) {
    const allowed = matched.some((m) => m.allow);
    if (!allowed) { blocked = true; reason = 'denyByDefault: compliance 未命中 allow 规则，默认拒绝'; }
  }
  return { ok: !blocked, reason: blocked ? reason : '', matched };
}

// ------------------------------------------------------------ A/B 分流 ----
/** 按 contactId 哈希固定分流：同一客户永远同一组 */
function variantOf(contactId) {
  return sha1(String(contactId || 'anon') + '|ab') % 2 === 0 ? 'A' : 'B';
}

/** 双比例 z 检验（样本 ≥200/组 时裁决）；返回 { decided, winner, z, p } */
function zTest(a, b, minSample = 200) {
  const n1 = a.trials || 0, n2 = b.trials || 0;
  if (n1 < minSample || n2 < minSample) return { decided: false, reason: '样本不足' };
  const p1 = (a.conversions || 0) / n1, p2 = (b.conversions || 0) / n2;
  const p = ((a.conversions || 0) + (b.conversions || 0)) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return { decided: false, reason: '零方差' };
  const z = Math.abs(p1 - p2) / se;
  // 正态近似：|z| > 1.96 ⇒ p < 0.05
  const decided = z > 1.96;
  return { decided, z: Math.round(z * 100) / 100, winner: p1 > p2 ? 'A' : 'B', p: Math.max(0, 1 - Math.min(1, z / 1.96)) };
}

// ------------------------------------------------------------ 引擎主体 ----
function createTalkEngine(opts = {}) {
  const store = opts.store || null;
  const leadScoring = opts.leadScoring || null;
  const aiService = opts.aiService || null;
  const templatesDir = opts.templatesDir || path.join(__dirname, 'templates');
  const sendHook = typeof opts.sendHook === 'function' ? opts.sendHook : null; // 平台侧发送走 adapter.send 契约
  const nowIso = () => (opts.now || (() => new Date().toISOString()))();

  // A/B 统计内存缓存（持久化到 store.db 的 TalkAbStat 行不存在时退化为内存；M3 验收用）
  const abStats = opts.abStats || {};

  // ------------------------------------------------------------- 频控账本 --
  const sentLog = opts.sentLog || []; // { accountId, contactId, ts, kind, templateVersion }
  // 合规闸门拦截账本（getAuditSummary 用）：{ ts, reason, kind: 'compliance'|'rateLimit'|'blacklist' }
  const gateBlockLog = opts.gateBlockLog || [];
  // 待确认话术队列（task-37：老板点「确认发送」前话术只生成不自动发）
  const pendingQueue = opts.pendingQueue || []; // { accountId, contactId, tier, text, talk, ts, confirmed, confirmedAt }

  function withinRateLimit({ accountId, contactId }) {
    const limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {});
    const t = Date.parse(nowIso());
    const dayAgo = t - 24 * 3600 * 1000;
    const hourAgo = t - 3600 * 1000;
    const minAgo = t - 60 * 1000;
    // task-31 口径：单客户 24h 按「生成话术条数」计（含被合规/人工拦截的 blocked 条），防绕过
    const perDay = sentLog.filter((s) => s.contactId === contactId && s.ts >= dayAgo && s.accountId === accountId).length;
    // 账号级 1h / 每分钟 cap 仍按实际发送成功条数（blocked 不计入真实发送压力）
    const perHour = sentLog.filter((s) => s.accountId === accountId && !s.blocked && s.ts >= hourAgo).length;
    const perMin = sentLog.filter((s) => s.accountId === accountId && !s.blocked && s.ts >= minAgo).length;
    if (perDay >= limits.perCustomerPerDay) return { ok: false, reason: '单客户 24h 已生成 ' + perDay + ' 条（≥' + limits.perCustomerPerDay + '，含被合规/人工拦截的）' };
    if (perHour >= limits.perAccountPerHour) return { ok: false, reason: '账号级 1h 已发 ' + perHour + ' 条（≥' + limits.perAccountPerHour + '）' };
    if (perMin >= limits.perMinuteCap) return { ok: false, reason: '每分钟 cap ' + limits.perMinuteCap + ' 已用尽' };
    return { ok: true };
  }

  function logSent(entry) {
    sentLog.push(Object.assign({ ts: Date.parse(nowIso()) }, entry));
  }
  function logGateBlock(reason) {
    // kind 判定（顺序安全 + task-37 收紧）：
    //   频控 reason 恒带 triggerGuide 拼的「频控: 」前缀（含 24h/1h/每分钟 cap）→ 命中即 rateLimit；
    //   合规/黑名单 reason 命中「黑名单|compliance|红线|denyByDefault|合规闸门」→ blacklist；
    //   其余合规类 → compliance。
    const raw = String(reason || '');
    let kind;
    if (/^频控:|每分钟 cap|账号级 1h|单客户 24h 已生成/i.test(raw)) kind = 'rateLimit';
    else if (/黑名单|denyByDefault|合规闸门|红线|compliance/i.test(raw)) kind = 'blacklist';
    else kind = 'compliance';
    gateBlockLog.push({ ts: Date.parse(nowIso()), reason: raw, kind });
  }

  // --------------------------------------------------- 待确认话术队列（task-37） --
  /**
   * pushPending：话术生成后记入待确认队列（老板点「确认发送」前不自动发）。
   * entry: { accountId, contactId, tier, text, talk, gateBlocked, reason }
   */
  function pushPending(entry) {
    pendingQueue.push(Object.assign({ ts: Date.parse(nowIso()), confirmed: false, confirmedAt: null }, entry));
  }
  function lastPending() {
    return pendingQueue.length ? pendingQueue[pendingQueue.length - 1] : null;
  }
  function getPendingQueue(limit) {
    const n = limit || 50;
    return pendingQueue.slice(-n);
  }

  /**
   * confirmSend(ctx)：老板在控制台点「确认发送」后调用，经合规闸门 + 频控才真发。
   * ctx: { accountId, contactId, text, talk?, tier? }
   * 返回 { sent: bool, reason, queueEntry }
   *  - text 缺省时取该 contactId 最近一条 pending 话术（老板确认默认最新那条）
   *  - 合规闸门/频控仍要过（保留安全防线）；过了才调 sendHook 真发 + 写 LeadEvent(lineOffered=1) + 记 sentLog(blocked=false)
   */
  function confirmSend(ctx = {}) {
    const contactId = String(ctx.contactId || '');
    if (!contactId) throw new Error('confirmSend: contactId required');
    const accountId = ctx.accountId || '';
    // 找待确认队列里该客户最近一条未确认的（或 ctx.text 指定）
    let entry = ctx.text
      ? pendingQueue.find((p) => p.contactId === contactId && p.text === ctx.text && !p.confirmed)
      : pendingQueue.filter((p) => p.contactId === contactId && !p.confirmed).pop();
    if (!entry) entry = { accountId, contactId, text: ctx.text || '', talk: ctx.talk, tier: ctx.tier || 'warm', gateBlocked: false, reason: '', ts: Date.parse(nowIso()), confirmed: false, confirmedAt: null };
    const gateRules = ctx.governanceRules || entry.governanceRules || { rules: [], denyByDefault: false };
    // task-36 修 Bug：checkGate 需要 limits（rateLimit 规则走 Object.assign(limits, spec)，缺省会崩）
      const gate = checkGate({ text: entry.text, rules: gateRules, limits: ctx.limits || entry.limits || {} });
    if (!gate.ok) {
      entry.confirmed = false; // 保持待确认（老板可改写后重发）
      logGateBlock('确认发送被合规闸门拒绝: ' + gate.reason);
      return { sent: false, reason: '合规闸门拒绝: ' + gate.reason, queueEntry: entry };
    }
    const rl = withinRateLimit({ accountId: entry.accountId || accountId, contactId });
    if (!rl.ok) {
      logGateBlock('确认发送被频控拦截: ' + rl.reason);
      return { sent: false, reason: '频控: ' + rl.reason, queueEntry: entry };
    }
    // 通过合规 + 频控 ⇒ 真发
    let sent = false, reason = '';
    if (sendHook) {
      const out = sendHook({
        accountId: entry.accountId || accountId,
        contactId,
        to: entry.to || '',
        text: entry.text,
        platform: (entry.talk && entry.talk.platform) || '',
        templateVersion: (entry.talk && entry.talk.templateVersion) || '',
        variant: (entry.talk && entry.talk.variant) || '',
        kind: 'guide',
      });
      if (out && out.ok === false) { reason = 'adapter.send 失败: ' + (out.reason || 'unknown'); }
      else sent = true;
    } else {
      sent = true; // 无 sendHook 时视为「生成成功」，由调用方经 adapter.send 契约实际发送
    }
    if (sent) {
      entry.confirmed = true;
      entry.confirmedAt = nowIso();
      logSent({ accountId: entry.accountId || accountId, contactId, kind: 'guide', blocked: false });
      writeLeadEvent({
        contactId, score: 0, tier: entry.tier || 'warm',
        signals: [{ signal: 'confirmSend', confirmed: true, text: entry.text ? entry.text.slice(0, 40) : '' }],
        action: 'triggered', lineOffered: 1, lineAdded: 0,
      });
      return { sent: true, reason: '', queueEntry: entry };
    }
    // adapter 发送失败：保持 pending（老板可重试）
    return { sent: false, reason: reason || 'adapter.send 失败', queueEntry: entry };
  }


  // ------------------------------------------------- LeadEvent 落库 --------
  function writeLeadEvent(evt) {
    if (store && typeof store.upsertLeadEvent === 'function') {
      store.upsertLeadEvent(evt);
      return Object.assign({ via: 'store' }, evt);
    }
    if (leadScoring && typeof leadScoring.writeLeadEvent === 'function') {
      const out = leadScoring.writeLeadEvent(evt);
      return Object.assign({}, out, { via: 'leadScoring' });
    }
    // 兜底：直接写 db（M3 自检环境）
    if (store && store.db) {
      const now = nowIso();
      const leadEventId = sha1('lead/' + evt.contactId + '/' + now + '/' + (evt.action || 'triggered') + Math.random());
      store.db.prepare(
        'INSERT OR IGNORE INTO LeadEvent (leadEventId,contactId,score,tier,signals,action,lineOffered,lineAdded,createdAt) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run(leadEventId, evt.contactId, evt.score || 0, evt.tier || 'cold',
        JSON.stringify(evt.signals || []), evt.action || 'triggered',
        evt.lineOffered ? 1 : 0, evt.lineAdded ? 1 : 0, now);
      return Object.assign({ leadEventId }, evt, { via: 'db' });
    }
    return Object.assign({ via: 'noop' }, evt);
  }

  // -------------------------------------------------- 模板匹配 + 填充 -----
  function buildTalks(category, language, tier, platform, accountPersona, customerProfile, governanceRules) {
    governanceRules = governanceRules || (store && store.getEffectiveRules
      ? store.getEffectiveRules({ platform, accountId: accountPersona ? accountPersona.accountId : undefined })
      : { rules: [], denyByDefault: false });

    const hit = loadTemplate(templatesDir, platform, category, language) || { template: null };
    let tpl = hit.template || null;
    const fallback = !tpl;
    if (fallback) {
      // 模板缺失：用内置兜底模板（保证引擎始终可用，话术标记 fallback）
      tpl = buildFallbackTemplate(language);
    }
    const variants = (tpl.variants || { A: {}, B: {} });
    const variant = variantOf(customerProfile && customerProfile.contactId);
    const vars = buildVars(accountPersona, customerProfile, tier, language);
    const text = fillTemplate((variants[variant] && variants[variant][tier]) || (variants[variant] && variants[variant].guide) || tpl.fallback, vars, accountPersona);
    const limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {});
    const gate = checkGate({ text, rules: governanceRules, limits });
    return {
      _rules: governanceRules,
      texts: {
        guide: text,
        remind: fillTemplate((variants[variant] && variants[variant].remind) || '', vars, accountPersona),
      },
      variant,
      tier,
      platform: String(platform || ''),
      category: String(category || ''),
      language: String(language || ''),
      templateVersion: sha1(hit.file || 'fallback'),
      fallback,
      vars,
      gate,
      limits,
      needsManual: tier === 'hot' ? !gate.manualBypass : false,
    };
  }

  /** hot 客户 LLM 个性化（可选）：失败自动规则兜底，不阻断流程 */
  async function personalize(talk, context) {
    if (talk.tier !== 'hot' || !aiService || typeof aiService.chatCompletion !== 'function') {
      return Object.assign({}, talk, { personalized: false, note: 'no-llm-or-not-hot' });
    }
    try {
      const system = '你是账号「' + (talk.vars.personaName || talk.vars.name || 'AI SAY') + '」（语气：' + (talk.vars.personaTone || '友好') + '）。' +
        '客户画像：' + JSON.stringify(context || {}) + '。请用该人设与画像，改写引导话术，保留 LINE ID 与核心卖点，不超过 200 字，直接输出话术。';
      const out = await aiService.chatCompletion({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: '当前模板话术：' + talk.texts.guide },
        ],
      });
      const clean = String(out || '').trim();
      if (!clean) throw new Error('LLM empty');
      const reGate = checkGate({ text: clean, rules: talk._rules || { rules: [], denyByDefault: false }, limits: talk.limits });
      if (!reGate.ok) return Object.assign({}, talk, { personalized: false, note: 'LLM 话术过闸失败，保留模板: ' + reGate.reason });
      return Object.assign({}, talk, { texts: Object.assign({}, talk.texts, { guide: clean }), personalized: true, gate: reGate });
    } catch (err) {
      return Object.assign({}, talk, { personalized: false, note: 'LLM 失败规则兜底: ' + err.message });
    }
  }

  // --------------------------------------------- 标准动作流程 --------------
  /**
   * triggerGuide(ctx) → 引导话术 + LeadEvent(action='triggered')
   * ctx: { accountId, contactId, tier, score, signals, category, language, platform,
   *        accountPersona, customerProfile, context, useLLM }
   * 返回 { sent: bool, reason, talk, leadEvent }；合规/频控不通过时 sent=false，
   * 但 LeadEvent 仍落库（lineOffered=0），保证 LeadEvent 100%（M3 验收）。
   */
  function triggerGuide(ctx = {}) {
    const contactId = String(ctx.contactId || '');
    if (!contactId) throw new Error('triggerGuide: contactId required');
    const tier = ctx.tier || 'cold';
    const talk = buildTalks(ctx.category, ctx.language, tier, ctx.platform, ctx.accountPersona, ctx.customerProfile, ctx.governanceRules);
    const gateRules = ctx.governanceRules || { rules: [], denyByDefault: false };
    const gate = checkGate({ text: talk.texts.guide, rules: gateRules, limits: talk.limits });
    // 生成计数（task-31 口径）：先查 24h 历史生成额度（不含本次），再决定是否记本次
    const rl = withinRateLimit({ accountId: ctx.accountId, contactId });
    let sent = false, reason = '';

    // task-31 口径：单客户 24h 按「生成话术条数」计（含被合规/人工拦截的），防绕过。
    // gate 拦截 / 人工 hold 也记 sentLog（blocked=true），withinRateLimit 按生成数计。
    // task-37：移除 auto=true 自动发路径。话术只生成，不自动发送（老板要求人工确认）。
    // 生成后记入 pendingQueue（待确认话术），LeadEvent 写 triggered 但 lineOffered=0（pending 状态）。
    // 实际发送走 confirmSend(ctx)（老板在控制台点「确认发送」才调）。
    if (!gate.ok) {
      reason = '合规闸门拒绝: ' + gate.reason;
      logGateBlock(reason);
      logSent({ accountId: ctx.accountId, contactId, kind: 'guide', blocked: true, templateVersion: talk.templateVersion, variant: talk.variant });
      // 合规拦截：进 pendingQueue（老板可改写后确认发送）
      pushPending({ accountId: ctx.accountId, contactId, tier, text: talk.texts.guide, talk, gateBlocked: true, reason });
    }
    else if (!rl.ok) {
      reason = '频控: ' + rl.reason;
      logGateBlock(reason);
      logSent({ accountId: ctx.accountId, contactId, kind: 'guide', blocked: true, templateVersion: talk.templateVersion, variant: talk.variant });
      // 频控拦截：进 pendingQueue（等额度释放后老板可确认）
      pushPending({ accountId: ctx.accountId, contactId, tier, text: talk.texts.guide, talk, gateBlocked: true, reason });
    }
    else {
      // 合规+频控通过：生成话术，进待确认队列（不自动发）
      // task-37：生成成功即记 sentLog(blocked:false)，rollbackLastTalk 依赖它读上一版
      logSent({ accountId: ctx.accountId, contactId, kind: 'guide', blocked: false, pending: true, templateVersion: talk.templateVersion, variant: talk.variant });
      pushPending({ accountId: ctx.accountId, contactId, tier, text: talk.texts.guide, talk, gateBlocked: false, reason: '' });
      // A/B 记账：trials++（生成即计数）
      const st = abStats[talk.variant] || (abStats[talk.variant] = { trials: 0, conversions: 0 });
      st.trials += 1;
      persistAbStat(talk.variant, st);
    }

    // task-37：triggered 但 sent 标 pending（未确认发送）。lineOffered=0 表示还在待确认队列。
    // confirmSend 成功后再写一条 LeadEvent(action='triggered', lineOffered=1)。
    const leadEvent = writeLeadEvent({
      contactId, score: ctx.score || 0, tier,
      signals: (ctx.signals || []).concat([{ signal: 'talkEngine', gateOk: gate.ok, pending: true, reason: reason || 'generated-pending', variant: talk.variant }]),
      action: 'triggered', lineOffered: 0, lineAdded: 0,
    });
    return { sent: false, pending: true, reason, talk, leadEvent, queueEntry: lastPending() };
  }

  /**
   * remindIfNoLine(ctx) → 30min 未留 LINE 提醒 1 次 + LeadEvent(action='reminded')
   * 已提醒过的客户直接归档（不重复提醒，频控友好）
   */
  function remindIfNoLine(ctx = {}) {
    const contactId = String(ctx.contactId || '');
    if (!contactId) throw new Error('remindIfNoLine: contactId required');
    if (ctx.lineAdded) {
      return { reminded: false, reason: '客户已留 LINE，无需提醒', leadEvent: writeLeadEvent({ contactId, tier: ctx.tier || 'warm', action: 'archived', lineAdded: 1 }) };
    }
    if (ctx.alreadyReminded) {
      return { reminded: false, reason: '已提醒过 1 次（上限），直接归档', leadEvent: writeLeadEvent({ contactId, tier: ctx.tier || 'warm', action: 'archived' }) };
    }
    const rl = withinRateLimit({ accountId: ctx.accountId, contactId });
    const talk = buildTalks(ctx.category, ctx.language, ctx.tier || 'warm', ctx.platform, ctx.accountPersona, ctx.customerProfile, ctx.governanceRules);
    const gate = checkGate({ text: talk.texts.remind, rules: ctx.governanceRules || { rules: [], denyByDefault: false }, limits: talk.limits });
    let reminded = false;
    if (!gate.ok) { /* 闸门拒绝：不重发，直接归档 */ }
    else if (!rl.ok) { /* 频控：同上 */ }
    else {
      if (sendHook) {
        const out = sendHook({ accountId: ctx.accountId, contactId, text: talk.texts.remind, platform: talk.platform, kind: 'remind', variant: talk.variant, templateVersion: talk.templateVersion });
        if (out && out.ok === false) { /* 失败不算 reminded */ }
        else reminded = true;
      } else {
        reminded = true;
      }
      if (reminded) {
        logSent({ accountId: ctx.accountId, contactId, kind: 'remind', variant: talk.variant, templateVersion: talk.templateVersion });
        const st = abStats[talk.variant] || (abStats[talk.variant] = { trials: 0, conversions: 0 });
        st.trials += 1;
        persistAbStat(talk.variant, st);
      }
    }
    const leadEvent = writeLeadEvent({ contactId, tier: ctx.tier || 'warm', action: 'reminded', lineOffered: reminded ? 1 : 0 });
    return { reminded, reason: reminded ? 'sent-remind' : gate.reason || rl.reason || '', talk, leadEvent };
  }

  /** archive(ctx) → LeadEvent(action='archived')，标准流程终点 */
  function archive(ctx = {}) {
    const contactId = String(ctx.contactId || '');
    if (!contactId) throw new Error('archive: contactId required');
    return { archived: true, leadEvent: writeLeadEvent({ contactId, tier: ctx.tier || 'cold', action: 'archived', lineAdded: ctx.lineAdded ? 1 : 0 }) };
  }

  /** hot 客户人工闸门放行：返回放行标记，调用方据此重发 guide */
  function approveManual(ctx = {}) {
    const contactId = String(ctx.contactId || '');
    if (!contactId) throw new Error('approveManual: contactId required');
    const rl = withinRateLimit({ accountId: ctx.accountId, contactId });
    if (!rl.ok) return { approved: false, reason: rl.reason };
    return { approved: true, auto: false };
  }

  /**
   * recordConversion(contactId, ok) → A/B 记账 + 样本 ≥200/组 时 z 检验裁决，
   * 胜出变体写 store（TalkAbStat 表不存在则写 GovernanceRule 审计行 / 内存）
   */
  function recordConversion(contactId, ok, ctx = {}) {
    const v = variantOf(contactId);
    const st = abStats[v] || (abStats[v] = { trials: 0, conversions: 0 });
    if (ok) st.conversions += 1;
    persistAbStat(v, st);
    const b = abStats[v === 'A' ? 'B' : 'A'] || { trials: 0, conversions: 0 };
    const verdict = zTest(st, b, 200);
    const out = { variant: v, verdict };
    if (verdict.decided) {
      out.winner = verdict.winner;
      out.rollout = verdict.winner;
      persistAbStat('winner', { winner: verdict.winner, z: verdict.z, at: nowIso() });
      // 裁决落库：走 store（若提供 writeTalkAbStat）
      if (store && typeof store.writeTalkAbStat === 'function') store.writeTalkAbStat(Object.assign({ winner: verdict.winner }, verdict));
    }
    return out;
  }

  function persistAbStat(variant, st) {
    if (store && store.db) {
      try {
        store.db.exec('CREATE TABLE IF NOT EXISTS TalkAbStat (variant TEXT PRIMARY KEY, trials INTEGER NOT NULL DEFAULT 0, conversions INTEGER NOT NULL DEFAULT 0, winner TEXT, updatedAt TEXT NOT NULL)');
        store.db.prepare(
          'INSERT INTO TalkAbStat (variant,trials,conversions,updatedAt) VALUES (?,?,?,?) ' +
          'ON CONFLICT(variant) DO UPDATE SET trials=excluded.trials, conversions=excluded.conversions, updatedAt=excluded.updatedAt'
        ).run(variant, st.trials || 0, st.conversions || 0, nowIso());
      } catch (e) { /* 表创建失败不阻断 */ }
    }
  }

  // 内置兜底模板（语言自适应）
  function buildFallbackTemplate(language) {
    const ja = /ja|日本語/.test(String(language || ''));
    const base = ja
      ? {
          A: { guide: 'LINE: {lineId} でフォローいただくと、日程調整がスムーズです。よろしければ？', remind: '先ほどお送りした LINE（{lineId}）へのフォロー、まだでしたらお願いします！' },
          B: { guide: '次回からがより早く届くよう、LINE（{lineId}）でもつながりませんか？', remind: 'LINE（{lineId}）のほう、お時間があったらフォローをお願いします。' },
        }
      : {
          A: { guide: 'For faster updates, add us on LINE: {lineId} — I will share details there.', remind: 'Quick reminder about LINE ({lineId}) — would love to connect!' },
          B: { guide: 'Want faster replies? Find me on LINE: {lineId}', remind: 'Still up for a quick chat on LINE ({lineId})?' },
        };
    return { vars: ['name', 'region', 'interest', 'lineId', 'greeting'], variants: base };
  }

  function buildVars(persona, profile, tier, language) {
    profile = profile || {};
    persona = persona || {};
    const p = (store && profile.contactId && store.db) ? (safeGetProfile(store.db, profile.contactId) || {}) : {};
    return {
      name: profile.name || profile.displayName || p.displayName || '',
      region: profile.region || p.region || '',
      interest: profile.interest || (Array.isArray(p.interests) ? p.interests[0] : '') || '',
      lineId: opts.lineId || profile.lineId || 'aisay.official',
      personaName: persona.persona || persona.nickname || 'aisay',
      personaTone: persona.tone || '',
      tier,
    };
  }

  function safeGetProfile(db, contactId) {
    try { return db.prepare('SELECT * FROM ContactProfile WHERE contactId = ?').get(contactId) || {}; } catch (e) { return {}; }
  }

  /**
   * rollbackLastTalk(contactId, ctx)
   * → 读该客户最近一条已发话术（sentLog），写 LeadEvent(action='archived') 标记回滚，
   *   并把该客户所属 A/B 变体（TalkAbStat）的 trials/conversions 回退 1 次（版本回退到上一版）。
   * 返回 { rolledBack, previousTemplateVersion, currentTemplateVersion, leadEvent, talkAbStat }
   *
   * 设计约束（task-25 边界）：
   *   - 不修改 M0 store schema；TalkAbStat 是 talkEngine 自建的轻量表（persistAbStat 已 CREATE IF NOT EXISTS）；
   *   - 回退语义：把胜出变体（abStats['winner']）的 trials/conversions 减 1（撤销一次记录），
   *     让下次 recordConversion 时 z 检验能重新裁决（即「回到上一版模板」）；
   *   - LeadEvent(action='archived', signals 标注 rollback=true) 保证 M3 的 100% 事件覆盖。
   */
  function rollbackLastTalk(contactId, ctx = {}) {
    const cid = String(contactId || '');
    if (!cid) throw new Error('rollbackLastTalk: contactId required');

    // 1. 找该客户最近一条 sentLog（即上一版话术）
    const sent = Array.isArray(opts.sentLog) ? opts.sentLog : sentLog;
    const last = sent.slice().reverse().find((s) => s && s.contactId === cid) || null;
    const previousTemplateVersion = last ? last.templateVersion : null;

    // 2. 写 LeadEvent(action='archived', signals 标注 rollback)
    const leadEvent = writeLeadEvent({
      contactId: cid,
      tier: ctx.tier || (last ? last.tier : 'cold'),
      signals: Array.isArray(ctx.signals)
        ? ctx.signals.concat([{ signal: 'rollbackLastTalk', templateVersion: previousTemplateVersion }])
        : [{ signal: 'rollbackLastTalk', templateVersion: previousTemplateVersion }],
      action: 'archived',
      lineOffered: 0,
      lineAdded: last && last.kind === 'remind' ? 1 : 0,
    });

    // 3. 把该客户的 TalkAbStat 版本回退 1 次（trials/conversions 减 1，下限 0）
    //    语义：撤销最近一次该客户参与的 A/B 记账，让 z 检验重新裁决 → 回到上一版模板
    const v = variantOf(cid);
    const targetVariant = (abStats['winner'] && abStats['winner'].winner) ? abStats['winner'].winner : v;
    const st = abStats[targetVariant] || (abStats[targetVariant] = { trials: 0, conversions: 0 });
    st.trials = Math.max(0, (st.trials || 0) - 1);
    st.conversions = Math.max(0, (st.conversions || 0) - 1);
    // 清除裁决标记（winner 行重置），让下次 recordConversion 重新跑 z 检验
    if (abStats['winner']) { abStats['winner'].decided = false; abStats['winner'].winner = null; abStats['winner'].reDecide = nowIso(); }
    else { abStats['winner'] = { winner: null, reDecide: nowIso() }; }
    persistAbStat(targetVariant, st);
    // 同时回退 winner 行（标记「需重新裁决」；落库 TalkAbStat + 内存 abStats 同步）
    persistAbStat('winner', abStats['winner']);

    const currentTemplateVersion = last ? last.templateVersion : null; // 未换模板，版本相同但统计已回退
    // 本地统计快照（getAbStats 是导出对象属性，在闭体内直接用 deep clone 避免 TDZ）
    const snapshot = JSON.parse(JSON.stringify(abStats));
    return {
      rolledBack: Boolean(last),
      previousTemplateVersion,
      currentTemplateVersion,
      rolledBackVariant: targetVariant,
      talkAbStat: snapshot,
      leadEvent,
    };
  }

  /**
   * getAuditSummary(limit) → 只读聚合（M5 合规审计视图用）：
   *   { recentSent: 最近 N 条 sentLog, gateBlocks: 拦截计数按 reason 分类, abStats }
   * reason 分类：compliance（合规红线）/ rateLimit（频控）/ blacklist（黑名单命中）
   */
  function getAuditSummary(limit = 50) {
    const n = Math.max(1, Math.min(Number(limit) || 50, 500));
    const recentSent = sentLog.slice(-n).map((s) => ({
      accountId: s.accountId, contactId: s.contactId, ts: s.ts, kind: s.kind,
      templateVersion: s.templateVersion, variant: s.variant,
    }));
    // 拦截计数按 reason 归类
    const byReason = {};
    let total = 0;
    for (const b of gateBlockLog) {
      total += 1;
      const key = b.kind || 'other';
      byReason[key] = (byReason[key] || 0) + 1;
    }
    return {
      totalSent: sentLog.filter((s) => !s.blocked).length,
      totalGenerated: sentLog.length,
      totalBlocked: total,
      byReason,                       // { compliance: n, rateLimit: n, blacklist: n }
      recentGateBlocks: gateBlockLog.slice(-n),
      recentSent,
      abStats: JSON.parse(JSON.stringify(abStats)),
    };
  }

  return {
    DEFAULT_LIMITS,
    buildTalks,
    triggerGuide,
    remindIfNoLine,
    archive,
    approveManual,
    personalize,
    recordConversion,
    variantOf,
    zTest,
    withinRateLimit,
    getAbStats: () => JSON.parse(JSON.stringify(abStats)),
    rollbackLastTalk,
    getAuditSummary,
    confirmSend,
    getPendingQueue,
    _sentLog: sentLog,
    _gateBlockLog: gateBlockLog,
    _pendingQueue: pendingQueue,
  };
}

module.exports = { createTalkEngine, DEFAULT_LIMITS };
