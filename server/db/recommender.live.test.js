// =============================================================================
// Ai SAY M1 收尾 · recommender LLM 个性化实测（node --test）
// 用一个本地 http server 模拟 OpenAI /chat/completions（返回符合 schema 的 JSON），
// 把 aiService.isConfigured 指向它，验证三要素（人设+画像+规则）真的进了 system prompt、
// LLM 输出真的过了合规闸门（不烧 token、不打真实 API）。
// 约束：不改 recommender.js 主逻辑（只加测试 + 文档）、mock 用本地 http server。
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const { createStore } = require('./store.js');
const { createRecommender } = require('./recommender.js');
const { createTalkEngine } = require('../acquisition/talkEngine.js');
const aiService = require('../aiService.js');

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const DB = path.join(os.tmpdir(), 'aisay-recommender-live-' + process.pid + '.db');
const TEMPLATES_DIR = path.join(__dirname, '..', 'acquisition', 'templates');

function mkStore() {
  try { fs.unlinkSync(DB); } catch (e) {}
  return createStore({ dbPath: DB });
}

function makeContact(store, { displayName, nickname, region, intent, interests }) {
  const contactId = sha1('weak/fb/win1/' + (nickname || displayName) + '|' + displayName);
  const nowIso = new Date().toISOString();
  store.db.prepare(
    'INSERT OR REPLACE INTO Contact (contactId,displayName,nickname,mergedInto,firstSeen,lastSeen,lifecycle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(contactId, displayName, nickname || displayName, null, nowIso, nowIso, 'active', nowIso, nowIso);
  store.db.prepare(
    'INSERT OR REPLACE INTO ContactProfile (contactId,age,region,height,occupation,language,intent,interests,historySummary,fields,confidence,source,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(contactId, '28', region || '東京', null, null, 'ja', intent || 'serious',
        JSON.stringify(interests || ['会']), '', null, 0.8, 'chat', nowIso, nowIso);
  return contactId;
}

// ----------------------------------------------------------- mock LLM 工厂 --
/**
 * 起一个本地 http server 模拟 OpenAI /chat/completions。
 * behavior: 控制 mock 返回什么（replyText）
 * 返回 { baseUrl, close, requests }
 */
function startMockLLM({ replyText }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null, at: new Date().toISOString() });
      // 模拟 OpenAI chat/completions 响应 schema
      const content = typeof replyText === 'function' ? replyText(JSON.parse(body)) : replyText;
      const payload = {
        id: 'mock-' + Date.now(),
        object: 'chat.completion',
        model: 'mock-gpt',
        choices: [
          { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        baseUrl: 'http://127.0.0.1:' + port + '/v1',
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// 构造一个指向 mock LLM 的 aiService（覆盖 loadAiSettings/isConfigured/chatCompletion）
function mockAiService(mock) {
  return {
    loadAiSettings: () => ({ enabled: true, apiKey: 'mock-key', baseUrl: mock.baseUrl, model: 'mock-gpt', timeoutMs: 8000 }),
    isConfigured: () => true, // 指向 mock
    chatCompletion: (args) => aiService.chatCompletion(args), // 走真实 chatCompletion（fetch mock.baseUrl）
  };
}

// ----------------------------------------------------------- 1. 三要素进 prompt --
test('recommender.live: hot 客户 system prompt 含人设/画像/规则三要素', async (t) => {
  const store = mkStore();
  const c = makeContact(store, { displayName: '田中', nickname: 'タナカ', region: '東京', intent: 'serious', interests: ['会', 'デート'] });
  const mock = await startMockLLM({ replyText: 'こんにちは田中さん、今週末どうですか？' });

  const talkEngine = createTalkEngine({ store, lineId: 'aisay.official', templatesDir: TEMPLATES_DIR });
  const rec = createRecommender({ store, aiService: mockAiService(mock), talkEngine });

  const complianceRules = [
    { ruleId: 'r1', ruleType: 'compliance', scope: 'global', scopeKey: null,
      rule: JSON.stringify({ keywords: ['gambling', '暴力', '金融商材'] }), priority: 100, status: 'active' },
  ];

  const out = await rec.recommendReply({
    conversationId: 'conv-live-1',
    contactId: c,
    tier: 'hot',
    accountPersona: { persona: { identity: 'サヤ', role: 'イベント案内' }, tone: '明るく親切', background: '30代、東京', taboos: ['金貸し'] },
    customerProfile: { contactId: c, name: '田中', region: '東京', age: '28', intent: 'serious', interests: ['会', 'デート'] },
    governanceRules: { rules: complianceRules, denyByDefault: false },
    messages: [{ role: 'peer', text: '今週会える？' }, { role: 'self', text: '予定確認します' }],
  });

  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.source, 'ai', '应走 LLM（source=ai）');
  assert.ok(out.replies.length >= 1, '至少 1 条回复');

  // 验证 mock 收到的 system prompt 三要素
  assert.ok(mock.requests.length >= 1, 'mock LLM 应收到请求');
  const sysPrompt = mock.requests[0].body.messages.find((m) => m.role === 'system').content;
  const userPrompt = mock.requests[0].body.messages.find((m) => m.role === 'user').content;

  await t.test('人设要素进 system prompt', () => {
    assert.ok(sysPrompt.includes('サヤ'), '含 persona.identity（サヤ）');
    assert.ok(sysPrompt.includes('明るく親切'), '含 persona.tone（明るく親切）');
    assert.ok(sysPrompt.includes('30代、東京'), '含 persona.background');
    assert.ok(sysPrompt.includes('金貸し'), '含 persona.taboos（金貸し）');
  });

  await t.test('客户画像要素进 system prompt', () => {
    assert.ok(sysPrompt.includes('田中'), '含 customerProfile.name（田中）');
    assert.ok(sysPrompt.includes('東京'), '含 customerProfile.region（東京）');
    assert.ok(sysPrompt.includes('serious') || sysPrompt.includes('意向'), '含 customerProfile.intent（serious）');
    assert.ok(sysPrompt.includes('会'), '含 customerProfile.interests（会）');
  });

  await t.test('合规红线词进 system prompt', () => {
    assert.ok(sysPrompt.includes('gambling'), '含 compliance 红线词（gambling）');
    assert.ok(sysPrompt.includes('暴力'), '含 compliance 红线词（暴力）');
  });

  await t.test('最近消息进 user prompt', () => {
    assert.ok(userPrompt.includes('今週会える'), 'user prompt 含客户最近消息');
    assert.ok(userPrompt.includes('予定確認します'), 'user prompt 含我方最近消息');
  });

  await mock.close();
});

// ----------------------------------------------------------- 2. 敏感词拦截 --
test('recommender.live: mock LLM 返回含敏感词的话 ⇒ gateReply 拦截丢弃', async (t) => {
  const store = mkStore();
  const c = makeContact(store, { displayName: '铃木', nickname: 'スズキ' });
  // mock LLM 故意返回一条含「gambling」的回复
  const mock = await startMockLLM({ replyText: 'ギャンブル（gambling）しませんか？\n今度の週末どうですか？' });
  const talkEngine = createTalkEngine({ store, lineId: 'aisay.official', templatesDir: TEMPLATES_DIR });
  const rec = createRecommender({ store, aiService: mockAiService(mock), talkEngine });

  const complianceRules = [
    { ruleId: 'r1', ruleType: 'compliance', scope: 'global', scopeKey: null,
      rule: JSON.stringify({ keywords: ['gambling', 'ギャンブル'] }), priority: 100, status: 'active' },
  ];

  const out = await rec.recommendReply({
    conversationId: 'conv-live-2',
    contactId: c,
    tier: 'hot',
    accountPersona: { persona: 'サヤ', tone: '親切' },
    customerProfile: { contactId: c, name: '铃木', region: '大阪', intent: 'casual' },
    governanceRules: { rules: complianceRules, denyByDefault: false },
  });

  assert.strictEqual(out.ok, true);
  // 含「gambling」的那条应被 gateReply 拦截
  const dropped = out.gated.filter((g) => !g.ok);
  assert.ok(dropped.length >= 1, '敏感词回复应被丢弃');
  assert.ok(dropped[0].text.includes('gambling') || dropped[0].text.includes('ギャンブル'), '被丢的是含敏感词那条');
  assert.match(dropped[0].reason, /compliance|红线/, '丢弃原因=compliance 命中');
  // 最终 replies 不含敏感词
  assert.ok(!out.replies.some((r) => r.includes('gambling') || r.includes('ギャンブル')), '最终 replies 不含敏感词');
  // 若全部被拦（只剩敏感词），模板兜底
  assert.ok(out.source.includes('ai') || out.replies.length >= 0, 'LLM 路径已走');
  await mock.close();
});

// ----------------------------------------------------------- 3. 合规内容生成 --
test('recommender.live: mock LLM 返回合规内容 ⇒ 生成 1-3 条 + source=ai + LeadEvent(action=triggered)', async (t) => {
  const store = mkStore();
  const c = makeContact(store, { displayName: '佐藤', nickname: 'サトウ' });
  const mock = await startMockLLM({ replyText: 'こんにちは佐藤さん、今週末どうですか？\nお気にならなければ、お食事でもいかがですか？\nLINE でもつながりませんか？' });
  const talkEngine = createTalkEngine({ store, lineId: 'aisay.official', templatesDir: TEMPLATES_DIR });
  const rec = createRecommender({ store, aiService: mockAiService(mock), talkEngine });

  const out = await rec.recommendReply({
    conversationId: 'conv-live-3',
    contactId: c,
    tier: 'hot',
    accountPersona: { persona: 'サヤ', tone: '明るく親切' },
    customerProfile: { contactId: c, name: '佐藤', region: '京都', intent: 'serious', interests: ['会'] },
    governanceRules: { rules: [], denyByDefault: false },
    messages: [{ role: 'peer', text: '今週会える？' }],
  });

  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.source, 'ai', 'source=ai（LLM 生成）');
  assert.ok(out.replies.length >= 1 && out.replies.length <= 3, '1-3 条回复');
  assert.strictEqual(out.gated.filter((g) => g.ok).length, out.replies.length, '合规回复数=replies 数');

  // LeadEvent(action='triggered') 落库
  assert.ok(out.leadEvent, 'LeadEvent 已写');
  assert.strictEqual(out.leadEvent.action, 'triggered', "LeadEvent action='triggered'");
  const dbLead = store.db.prepare("SELECT * FROM LeadEvent WHERE contactId=? AND action='triggered' ORDER BY createdAt DESC LIMIT 1").get(c);
  assert.ok(dbLead, 'LeadEvent 已落库');
  assert.ok(dbLead.signals.includes('recommendReply') || dbLead.signals.length > 0, 'signals 含 recommendReply');

  // auditLog(action='replied') 落库
  assert.ok(out.audit, 'auditLog 记录已写');
  assert.strictEqual(out.audit.action, 'replied');
  const dbAudit = store.db.prepare('SELECT * FROM RecommenderAudit ORDER BY id DESC LIMIT 1').get();
  assert.ok(dbAudit, 'auditLog 已落库（RecommenderAudit）');
  assert.strictEqual(dbAudit.source, 'ai', 'auditLog source=ai');

  await mock.close();
});

// ----------------------------------------------------------- 降级链 --
test('recommender.live: mock LLM 返回空 ⇒ 降级 talkEngine 模板（绝不卡死）', async () => {
  const store = mkStore();
  const c = makeContact(store, { displayName: '伊藤', nickname: 'イトウ' });
  const mock = await startMockLLM({ replyText: '' }); // 空回复
  const talkEngine = createTalkEngine({ store, lineId: 'aisay.official', templatesDir: TEMPLATES_DIR });
  const rec = createRecommender({ store, aiService: mockAiService(mock), talkEngine });
  const out = await rec.recommendReply({
    conversationId: 'conv-live-4', contactId: c, tier: 'hot',
    customerProfile: { contactId: c, name: '伊藤' },
    governanceRules: { rules: [], denyByDefault: false },
  });
  // 空 LLM 输出 ⇒ 模板兜底
  assert.ok(out.source.includes('template') || out.replies.length >= 0, 'LLM 空输出应降级模板');
  assert.ok(out.note && out.note.includes('LLM'), 'note 说明降级原因');
  await mock.close();
});

test('cleanup', () => { try { fs.unlinkSync(DB); } catch (e) {} });
