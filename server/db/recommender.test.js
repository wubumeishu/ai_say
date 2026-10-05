// =============================================================================
// Ai SAY M1 补强 · recommender 自检（node --test）
// 4 类样例（对齐 task-24 验收）：
//   1. hot + AI 已配置        → 走 aiService.chatCompletion，persona/画像/规则约束进 prompt
//   2. hot + AI 未配置        → 降级 talkEngine 模板兜底（source='template'，绝不卡死）
//   3. warm                  → 直接走 talkEngine 模板（不花 LLM token）
//   4. 合规闸门拦敏感词      → 命中 compliance 红线的回复被丢弃
// 附加：auditLog(action='replied') + LeadEvent(action='triggered') 落库
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const { createStore } = require('./store.js');
const { createRecommender } = require('./recommender.js');
const { createTalkEngine } = require('../acquisition/talkEngine.js');

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const DB = path.join(os.tmpdir(), 'aisay-recommender-test-' + process.pid + '.db');

function mkStore() {
  try { fs.unlinkSync(DB); } catch (e) {}
  return createStore({ dbPath: DB });
}

function makeContact(store, { displayName, nickname }) {
  const contactId = sha1('weak/fb/win1/' + (nickname || displayName) + '|' + displayName);
  const nowIso = new Date().toISOString();
  store.db.prepare(
    'INSERT OR REPLACE INTO Contact (contactId,displayName,nickname,mergedInto,firstSeen,lastSeen,lifecycle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(contactId, displayName, nickname || displayName, null, nowIso, nowIso, 'active', nowIso, nowIso);
  store.db.prepare(
    'INSERT OR REPLACE INTO ContactProfile (contactId,age,region,height,occupation,language,intent,interests,historySummary,fields,confidence,source,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(contactId, '28', '東京', null, null, 'ja', 'serious', JSON.stringify(['会', 'デート']), '', null, 0.8, 'chat', nowIso, nowIso);
  return contactId;
}

function makeRules({ blacklist = [] } = {}) {
  const rules = [];
  const nowIso = new Date().toISOString();
  if (blacklist.length) {
    rules.push({ ruleId: 'gr-blk', ruleType: 'compliance', scope: 'global', scopeKey: null,
      rule: JSON.stringify({ keywords: blacklist, deny: true }), priority: 100, status: 'active', createdAt: nowIso, updatedAt: nowIso });
  }
  return rules;
}

const TEMPLATES_DIR = path.join(__dirname, '..', 'acquisition', 'templates');

function makeRecommender(store, { aiService, blacklist = [] } = {}) {
  const talkEngine = createTalkEngine({ store, lineId: 'aisay.official', templatesDir: TEMPLATES_DIR });
  return createRecommender({ store, aiService, talkEngine });
}

// ----------------------------------------------------------- 1. hot+AI 配置 --
test('recommender: hot + AI 已配置 ⇒ LLM 生成（persona 约束生效）', async (t) => {
  const store = mkStore();
  const c = makeContact(store, { displayName: '田中', nickname: 'タナカ' });
  let capturedPrompt = null;

  // mock aiService：捕获 prompt，验证三要素 + 真实入参形状
  const aiService = {
    loadAiSettings: () => ({ enabled: true, apiKey: 'k', model: 'gpt-4o-mini' }),
    isConfigured: (s) => !!(s && s.apiKey),
    chatCompletion: async (args) => {
      capturedPrompt = args;
      assert.strictEqual(args.temperature, 0.3, 'temperature=0.3（对齐 task 要求）');
      assert.strictEqual(args.maxTokens, 300, 'maxTokens=300');
      assert.ok(Array.isArray(args.messages) && args.messages.length === 2, 'messages=[system,user]');
      assert.strictEqual(typeof args.settings, 'object', 'settings 传入（对齐 aiService.chatCompletion 签名）');
      return 'こんにちは田中さん、今度の週末どうですか？LINE: aisay.official で先约しいましょう。\nお気にならなければ、お食事でもいかがですか？';
    },
  };
  const rec = makeRecommender(store, { aiService });
  const out = await rec.recommendReply({
    conversationId: 'conv-x',
    contactId: c,
    tier: 'hot',
    accountPersona: { persona: { identity: 'サヤ', role: 'イベント案内' }, tone: '明るく親切', taboos: ['金貸し'] },
    customerProfile: { contactId: c, name: '田中', region: '東京', age: '28', intent: 'serious', interests: ['会', 'デート'] },
    governanceRules: { rules: [], denyByDefault: false },
    messages: [
      { role: 'peer', text: '今週会える？' },
      { role: 'self', text: '予定確認します' },
    ],
  });

  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.source, 'ai', 'source=ai（LLM 生成）');
  assert.ok(out.replies.length >= 1 && out.replies.length <= 3, '1-3 条回复');

  // prompt 三要素强制加载断言
  const sys = capturedPrompt.messages[0].content;
  assert.ok(sys.includes('サヤ'), 'prompt 含账号人设（persona）');
  assert.ok(sys.includes('明るく親切'), 'prompt 含人设语气（tone）');
  assert.ok(sys.includes('金貸し'), 'prompt 含人设禁忌（taboo）');
  assert.ok(sys.includes('田中'), 'prompt 含客户画像（name）');
  assert.ok(sys.includes('東京'), 'prompt 含客户画像（region）');
  assert.ok(sys.includes('serious') || sys.includes('意向'), 'prompt 含客户画像（intent）');
  assert.ok(sys.includes('今週会える') || capturedPrompt.messages[1].content.includes('今週会える'), 'prompt 含最近消息');

  // LeadEvent + auditLog
  assert.ok(out.leadEvent, 'LeadEvent 已写');
  assert.strictEqual(out.leadEvent.action, 'triggered', "LeadEvent action='triggered'（表 CHECK 约束仅 triggered/reminded/archived）");
  assert.ok(out.audit, 'auditLog 记录已写');
  assert.strictEqual(out.audit.action, 'replied', "auditLog action='replied'");

  const dbLead = store.db.prepare('SELECT * FROM LeadEvent WHERE contactId=? ORDER BY createdAt DESC LIMIT 1').get(c);
  assert.ok(dbLead, 'LeadEvent 已落库');
  const dbAudit = store.db.prepare('SELECT * FROM RecommenderAudit ORDER BY id DESC LIMIT 1').get();
  assert.ok(dbAudit, 'auditLog 已落库（RecommenderAudit）');
});

// ----------------------------------------------------------- 2. hot+AI 未配置 --
test('recommender: hot + AI 未配置 ⇒ 降级 talkEngine 模板（绝不卡死）', async () => {
  const store = mkStore();
  const c = makeContact(store, { displayName: '铃木', nickname: 'スズキ' });
  // aiService.isConfigured=false
  const aiService = {
    loadAiSettings: () => ({ enabled: false }),
    isConfigured: () => false,
    chatCompletion: async () => { throw new Error('should not be called'); },
  };
  const rec = makeRecommender(store, { aiService });
  const out = await rec.recommendReply({
    conversationId: 'conv-y',
    contactId: c,
    tier: 'hot',
    accountPersona: { persona: 'サヤ', tone: '親切' },
    customerProfile: { contactId: c, name: '铃木', region: '大阪' },
    governanceRules: { rules: [], denyByDefault: false },
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.source, 'template', '未配置 AI 时 source=template（降级）');
  assert.ok(out.replies.length >= 1, '模板兜底有回复');
  assert.match(out.note || '', /AI 未配置|aiService/, 'note 说明降级原因');
});

// ----------------------------------------------------------- 3. warm 走模板 --
test('recommender: warm ⇒ 直接模板（不花 LLM token）', async () => {
  const store = mkStore();
  const c = makeContact(store, { displayName: '佐藤', nickname: 'サトウ' });
  let called = false;
  const aiService = {
    loadAiSettings: () => ({ enabled: true, apiKey: 'k' }),
    isConfigured: () => true,
    chatCompletion: async () => { called = true; return 'should not be used'; },
  };
  const rec = makeRecommender(store, { aiService });
  const out = await rec.recommendReply({
    conversationId: 'conv-z',
    contactId: c,
    tier: 'warm',
    customerProfile: { contactId: c, name: '佐藤' },
    governanceRules: { rules: [], denyByDefault: false },
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.source, 'template', 'warm 走模板');
  assert.strictEqual(called, false, 'warm 不调用 LLM（省 token）');
  assert.ok(out.replies.length >= 1);
});

// ----------------------------------------------------------- 4. 合规闸门拦截 --
test('recommender: 合规闸门拦敏感词（compliance 红线命中即丢弃）', async () => {
  const store = mkStore();
  const c = makeContact(store, { displayName: '伊藤', nickname: 'イトウ' });
  // AI 返回含红线词 + 一条干净回复
  const aiService = {
    loadAiSettings: () => ({ enabled: true, apiKey: 'k' }),
    isConfigured: () => true,
    chatCompletion: async () =>
      '賭博サイトに招待しますよ！\n今度の週末、どうですか？',
  };
  const rec = makeRecommender(store, { aiService });
  const rules = makeRules({ blacklist: ['賭博'] });
  const out = await rec.recommendReply({
    conversationId: 'conv-w',
    contactId: c,
    tier: 'hot',
    customerProfile: { contactId: c, name: '伊藤' },
    governanceRules: { rules, denyByDefault: false },
  });
  assert.strictEqual(out.ok, true);
  const dropped = out.gated.filter((g) => !g.ok);
  assert.strictEqual(dropped.length, 1, '敏感词回复被丢弃 1 条');
  assert.match(dropped[0].reason, /compliance/, '丢弃原因=compliance 红线命中');
  assert.ok(!out.replies.some((r) => r.includes('賭博')), '红线词回复不在最终 replies');
  assert.ok(out.replies.includes('今度の週末、どうですか？'), '干净回复保留');
});

// 附加：gateReply 单元断言
test('recommender: gateReply / buildPrompt 单元', () => {
  const store = mkStore();
  const rec = makeRecommender(store, {});
  const rules = makeRules({ blacklist: ['暴力', '金融商材'] });
  assert.strictEqual(rec.gateReply('こんにちは', { rules, denyByDefault: false }).ok, true);
  assert.strictEqual(rec.gateReply('暴力な言葉です', { rules, denyByDefault: false }).ok, false);
  const { system, user } = rec.buildPrompt({
    accountPersona: { persona: 'サヤ', tone: '優しい', taboos: ['嘘'] },
    customerProfile: { name: '山田', region: '京都', intent: 'casual', age: '30' },
    governanceRules: { rules, denyByDefault: false },
    messages: [{ role: 'peer', text: 'こんにちは' }],
    tier: 'warm',
  });
  assert.ok(system.includes('サヤ'));
  assert.ok(system.includes('暴力'), '红线词进 prompt 约束');
  assert.ok(user.includes('こんにちは'));
});

test('cleanup', () => { try { fs.unlinkSync(DB); } catch (e) {} });
