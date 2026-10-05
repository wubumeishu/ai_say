// Ai SAY M1 - leadScoring.test.js (node --test)
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createLeadScoring } = require('./leadScoring');

// 不写真实 DB 的 mock store（只记录 writeLeadEvent 调用）
function makeMockStore() {
  const events = [];
  return {
    upsertLeadEvent: (evt) => { events.push(evt); return evt; },
    _events: events,
  };
}

// ---------------------------------------------------------------------------
// 构造 3 类样例
// ---------------------------------------------------------------------------

const hotCustomer = {
  contactId: 'c_hot',
  messages: [
    { role: 'other', original: '料金はいくらですか', translation: '费用多少', timeIso: '2026-10-01T10:00:00Z' },
    { role: 'other', original: 'ラインで会いたい', translation: '想在LINE见面', timeIso: '2026-10-01T10:03:00Z' },
    { role: 'other', original: '本気で結婚したい', translation: '认真想结婚', timeIso: '2026-10-01T10:05:00Z' },
  ],
};

const normalCustomer = {
  contactId: 'c_normal',
  messages: [
    { role: 'other', original: 'こんにちは', translation: '你好', timeIso: '2026-10-01T10:00:00Z' },
    { role: 'other', original: '映画好き', translation: '喜欢电影', timeIso: '2026-10-01T10:30:00Z' },
  ],
};

const silentCustomer = {
  contactId: 'c_silent',
  silentDays: 15,
  messages: [
    { role: 'other', original: '久しぶり', translation: '好久不见', timeIso: '2026-10-01T10:00:00Z' },
  ],
};

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

test('hot 客户：评分 >= 70 → tier=hot', () => {
  const store = makeMockStore();
  const engine = createLeadScoring({ store });
  const result = engine.scoreConversation(hotCustomer.messages, { contactId: hotCustomer.contactId });

  assert.ok(result.score >= 70, 'hot 客户分数应 >= 70，实际 ' + result.score);
  assert.strictEqual(result.tier, 'hot', 'tier 应为 hot，实际 ' + result.tier);
  assert.ok(result.signals.length > 0, '应有 signals');
  const signalNames = result.signals.map(s => s.signal);
  assert.ok(signalNames.includes('lineWillingness'), '应命中 lineWillingness');
  assert.ok(signalNames.includes('priceInquiry'), '应命中 priceInquiry');
  assert.ok(signalNames.includes('keywordHit'), '应命中 keywordHit');
});

test('普通客户：tier 在 warm 或 cold 范围', () => {
  const store = makeMockStore();
  const engine = createLeadScoring({ store });
  const result = engine.scoreConversation(normalCustomer.messages, { contactId: normalCustomer.contactId });

  assert.ok(result.score < 70, '普通客户分数应 < 70（非 hot），实际 ' + result.score);
  assert.ok(['warm','cold'].includes(result.tier), 'tier 应为 warm 或 cold，实际 ' + result.tier);
});

test('沉默客户：触发 reactivation 信号（silentDays>7）', () => {
  const store = makeMockStore();
  const engine = createLeadScoring({ store });
  const result = engine.scoreConversation(silentCustomer.messages, { contactId: silentCustomer.contactId, silentDays: silentCustomer.silentDays });

  const reactivation = result.signals.find(s => s.signal === 'reactivation');
  assert.ok(reactivation, '应命中 reactivation 信号（silentDays=15）');
  assert.strictEqual(reactivation.silentDays, 15);
});

test('writeLeadEvent：走 store.upsertLeadEvent 单一写入路径', () => {
  const store = makeMockStore();
  const engine = createLeadScoring({ store });
  const evt = engine.writeLeadEvent({
    contactId: 'c_test', score: 50, tier: 'warm', signals: [{signal:'test',weight:10}],
  });

  assert.strictEqual(store._events.length, 1, '应调用 upsertLeadEvent 一次');
  assert.strictEqual(store._events[0].contactId, 'c_test');
  assert.strictEqual(store._events[0].score, 50);
  assert.strictEqual(store._events[0].tier, 'warm');
});

test('run：评分 + 写 LeadEvent 一站式', async () => {
  const store = makeMockStore();
  const engine = createLeadScoring({ store });
  const result = await engine.run({
    messages: hotCustomer.messages,
    conversationMeta: { contactId: hotCustomer.contactId },
  });

  assert.strictEqual(result.contactId, hotCustomer.contactId);
  assert.strictEqual(result.tier, 'hot');
  assert.ok(result.leadEvent, '应返回 leadEvent');
  assert.ok(result.leadEvent.leadEventId, 'leadEvent 应有 leadEventId');
  assert.strictEqual(store._events.length, 1, '应写 1 条 LeadEvent');
});

test('LLM 降级：aiService 不可用时回退规则分（不卡死）', async () => {
  const store = makeMockStore();
  const engine = createLeadScoring({ store, aiService: null });
  const result = await engine.scoreConversationWithLLM(hotCustomer.messages, { contactId: 'c_x' });

  assert.strictEqual(result.llmUsed, false, '无 aiService 时 llmUsed 应为 false');
  assert.ok(result.score >= 70, '仍应返回规则分 >= 70');
  assert.strictEqual(result.tier, 'hot');
});

test('LLM 降级：aiService.chatCompletion 失败时回退规则分', async () => {
  const store = makeMockStore();
  const fakeAi = {
    chatCompletion: async () => { throw new Error('API timeout'); },
  };
  const engine = createLeadScoring({ store, aiService: fakeAi });
  const result = await engine.scoreConversationWithLLM(hotCustomer.messages, { contactId: 'c_y' });

  assert.strictEqual(result.llmUsed, false, 'LLM 失败时 llmUsed 应为 false');
  assert.ok(result.llmNote.includes('failed'), 'llmNote 应含 failed 说明');
  assert.ok(result.score >= 70, '回退后仍应有规则分');
});

test('scoreToTier 边界值', () => {
  const store = makeMockStore();
  const engine = createLeadScoring({ store });
  assert.strictEqual(engine._scoreToTier(70), 'hot');
  assert.strictEqual(engine._scoreToTier(69), 'warm');
  assert.strictEqual(engine._scoreToTier(40), 'warm');
  assert.strictEqual(engine._scoreToTier(39), 'cold');
  assert.strictEqual(engine._scoreToTier(0), 'cold');
  assert.strictEqual(engine._scoreToTier(100), 'hot');
});