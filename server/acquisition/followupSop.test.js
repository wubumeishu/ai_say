'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decideNext, buildTalks, generate, TEMPLATES } = require('./followupSop');

test('followupSop: stage=1 3天没回 → nudge（软推进ライン）', () => {
  const d = decideNext({ stage: 1, daysSinceLast: 3 });
  assert.equal(d.reason, 'sop-3day-line');
  assert.equal(d.action.kind, 'nudge');
});

test('followupSop: stage=2 推過ライン 3天没回应 → understand（理解退路）', () => {
  const d = decideNext({ stage: 2, daysSinceLast: 3 });
  assert.equal(d.reason, 'sop-line-no-response');
  assert.equal(d.action.kind, 'understand');
});

test('followupSop: stage=5 冷却 → 不触发', () => {
  const d = decideNext({ stage: 5, daysSinceLast: 10 });
  assert.equal(d.action, null);
  assert.equal(d.reason, 'sop-cooldown');
});

test('followupSop: stage=1 2天没回 → care（先关心）', () => {
  const d = decideNext({ stage: 1, daysSinceLast: 2 });
  assert.equal(d.action.kind, 'care');
});

test('followupSop: stage=0 破冰期 → 不触发', () => {
  const d = decideNext({ stage: 0, daysSinceLast: 5 });
  assert.equal(d.action, null);
});

test('followupSop: nudge 话术含 ライン 且不含 LINE 品牌', () => {
  const t = buildTalks('nudge', { name: 'haruki' });
  assert.ok(t.ja.includes('ライン'), '应含 ライン');
  assert.ok(!/LINE/.test(t.ja), '不应含 LINE 品牌');
  assert.ok(t.ja.split(String.fromCharCode(10)).length >= 3, '应保留换行');
});

test('followupSop: understand 话术含"在这里聊天也没问题"语义', () => {
  const t = buildTalks('understand', { name: 'haruki' });
  assert.ok(t.ja.length > 20);
});

test('followupSop: generate 组合入口出 3 类话术 + recommended', () => {
  const g = generate({ stage: 1, daysSinceLast: 3, name: 'haruki' });
  assert.deepEqual(g.talks.map(x => x.kind), ['care', 'nudge', 'understand']);
  assert.equal(g.recommended.kind, 'nudge');
});

test('followupSop: TEMPLATES 四类齐全', () => {
  assert.deepEqual(Object.keys(TEMPLATES).sort(), ['care', 'meet', 'nudge', 'understand']);
});
