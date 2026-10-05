// FB / WhatsApp 骨架适配器自检（node --test）。
// 运行：node --test server/adapter/fb-wa-skeleton.test.js
// 断言：createAdapter 返回对应子类 + 4 方法都是 function
//       + 骨架 selector 可被 probeRule 探测（mock cdp 命中/不命中两样本，不命中触发 onLocatorMiss）。

const test = require('node:test');
const assert = require('node:assert');

const { createAdapter } = require('./platformAdapter');
const { FacebookAdapter } = require('./facebook');
const { WhatsAppAdapter } = require('./whatsapp');

// ---- mock cdp：控制 probeRule 命中/不命中 ----
function mockCdp({ hitCount = 1, totalSelectors = 3 } = {}) {
  // buildProbeJs 生成的脚本是 IIFE，返回值是对象数组。
  // 我们无法直接解析脚本，所以用一个简化策略：
  // mock cdp.evaluate 直接返回一个符合 probe 结果形状的数组，
  // 让 probeRule 按 hits/total 计算并触发告警。
  const fakeProbe = () => Array.from({ length: totalSelectors }, (_, i) => ({
    css: ".fake", text: "", cssHits: i < hitCount ? 1 : 0, textHit: i < hitCount,
    sample: "x", href: "", ok: i < hitCount
  }));
  return {
    evaluate: async () => ({ value: fakeProbe() })
  };
}

test('facebook: createAdapter 返回 FacebookAdapter 且 4 方法都是 function', () => {
  const a = createAdapter('facebook', { cdp: mockCdp(), targetId: null, locatorConfig: {} });
  assert.ok(a instanceof FacebookAdapter, 'createAdapter(facebook) 应返回 FacebookAdapter');
  assert.strictEqual(a.platform, 'facebook');
  for (const m of ['scanProfile', 'scanMessages', 'navigate', 'send']) {
    assert.strictEqual(typeof a[m], 'function', 'facebook.' + m + ' 应为 function');
  }
  // 骨架 locatorConfig 带 minHits/missThreshold
  assert.ok(a.locatorConfig.rules, 'facebook 应有 rules');
  assert.ok(a.locatorConfig.rules.chatBubble, 'facebook 应有 chatBubble rule');
  assert.ok(Number.isFinite(a.locatorConfig.rules.chatBubble.minHits), 'chatBubble 应有 minHits');
});

test('whatsapp: createAdapter 返回 WhatsAppAdapter 且 4 方法都是 function', () => {
  const a = createAdapter('whatsapp', { cdp: mockCdp(), targetId: null, locatorConfig: {} });
  assert.ok(a instanceof WhatsAppAdapter, 'createAdapter(whatsapp) 应返回 WhatsAppAdapter');
  assert.strictEqual(a.platform, 'whatsapp');
  for (const m of ['scanProfile', 'scanMessages', 'navigate', 'send']) {
    assert.strictEqual(typeof a[m], 'function', 'whatsapp.' + m + ' 应为 function');
  }
  assert.ok(a.locatorConfig.rules.chatBubble, 'whatsapp 应有 chatBubble rule');
  assert.ok(Number.isFinite(a.locatorConfig.rules.chatBubble.minHits), 'chatBubble 应有 minHits');
});

test('probeRule 命中样本：locatorStats.hits > 0 且不触发 onLocatorMiss', async () => {
  let missFired = 0;
  const a = createAdapter('facebook', {
    cdp: mockCdp({ hitCount: 3, totalSelectors: 3 }),
    targetId: null,
    locatorConfig: {},
    emit: (type, payload) => { if (type === 'onLocatorMiss') missFired += 1; }
  });
  // 让 probeRule 探测 chatBubble（minHits=1）
  const out = await a.probeRule('chatBubble');
  assert.ok(Array.isArray(out), 'probeRule 应返回数组');
  const stat = a.locatorStats.get('chatBubble');
  assert.ok(stat, 'locatorStats 应有 chatBubble');
  assert.ok(stat.hits > 0, '命中样本 hits 应 > 0（实际 ' + stat.hits + '）');
  assert.strictEqual(missFired, 0, '命中样本不应触发 onLocatorMiss');
  assert.strictEqual(a.locatorMissCount, 0, '命中样本 locatorMissCount 应为 0');
});

test('probeRule 不命中样本：locatorStats.hits === 0 且触发 onLocatorMiss', async () => {
  let missFired = 0;
  const missPayload = [];
  const a = createAdapter('whatsapp', {
    cdp: mockCdp({ hitCount: 0, totalSelectors: 3 }),
    targetId: null,
    locatorConfig: {},
    emit: (type, payload) => { if (type === 'onLocatorMiss') { missFired += 1; missPayload.push(payload); } }
  });
  const out = await a.probeRule('chatBubble');
  assert.ok(Array.isArray(out), 'probeRule 应返回数组');
  const stat = a.locatorStats.get('chatBubble');
  assert.strictEqual(stat.hits, 0, '不命中样本 hits 应为 0');
  assert.strictEqual(missFired, 1, '不命中样本应触发 1 次 onLocatorMiss');
  assert.strictEqual(a.locatorMissCount, 1, '不命中样本 locatorMissCount 应为 1');
  assert.ok(missPayload.length === 1, 'onLocatorMiss 应带 payload');
  assert.strictEqual(missPayload[0].platform, 'whatsapp', 'payload.platform 应为 whatsapp');
  assert.strictEqual(missPayload[0].ruleId, 'chatBubble', 'payload.ruleId 应为 chatBubble');
});