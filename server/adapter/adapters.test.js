// 适配器自检：断言 4 平台 createAdapter 都返回对应子类 + 4 方法都是 function + mock 返回 ok:true。
// 运行：node server/adapter/adapters.test.js

const assert = require('assert');

const { createAdapter, registry } = require('./platformAdapter');
const { IchigoAdapter } = require('./ichigo194964');
const { LineAdapter } = require('./line');
const { FacebookAdapter } = require('./facebook');
const { WhatsAppAdapter } = require('./whatsapp');

// 4 平台注册映射
const PLATFORMS = [
  { id: 'ichigo194964', cls: IchigoAdapter, label: '出会/Pappy/イククル (17098)' },
  { id: 'line',         cls: LineAdapter,     label: 'LINE OA (占位)' },
  { id: 'facebook',     cls: FacebookAdapter, label: 'Facebook (占位)' },
  { id: 'whatsapp',     cls: WhatsAppAdapter, label: 'WhatsApp (占位)' }
];

// 4 方法契约名（基类提供）
const METHODS = ['scanProfile', 'scanMessages', 'navigate', 'send'];

async function main() {
  let passed = 0, failed = 0;
  const stubCdp = {
    // 最小 DevToolsClient 桩：createAdapter 只要求 cdp 存在，这里不实际连
    evaluate: async () => ({ value: null }),
  };

  for (const p of PLATFORMS) {
    const a = createAdapter(p.id, { cdp: stubCdp, targetId: null, locatorConfig: {} });
    assert.ok(a instanceof p.cls, p.id + ' 未返回 ' + p.cls.name + '（实际 ' + (a.constructor && a.constructor.name) + '）');
    assert.strictEqual(a.platform, p.id.toLowerCase(), p.id + ' .platform 标识不符');
    assert.strictEqual(a.cdp, stubCdp, p.id + ' 未注入 cdp');

    // 4 方法都是 function
    for (const m of METHODS) {
      assert.strictEqual(typeof a[m], 'function', p.id + '.' + m + ' 不是 function');
    }

    // mock 返回 ok:true（FB/WA/LINE 全 mock；ichigo 的 scanProfile 走基类探测，需要真实页 → 跳过 ok 断言，仅验证方法可调用）
    if (p.cls === FacebookAdapter || p.cls === WhatsAppAdapter || p.cls === LineAdapter) {
      const sp = await a.scanProfile();
      assert.strictEqual(sp.ok, true, p.id + '.scanProfile ok 应为 true');
      assert.ok(typeof sp.accountPersona === 'object', p.id + ' accountPersona.identity 应为对象');
      const sm = await a.scanMessages('test-conv');
      assert.strictEqual(sm.ok, true, p.id + '.scanMessages ok 应为 true');
      assert.strictEqual(sm.conversationId, 'test-conv', p.id + '.scanMessages conversationId 未透传');
      // navigate：LINE 是纯 mock（基类 navigate 被覆写，返回 ok:true mock）；FB/WA 骨架版 navigate 走基类，
      // '#test' 非 http/非 / 开头 → 查 actions['#test'] 查无 → ok:false（骨架未定义该 action，符合 100% 告警预期）
      const nv = await a.navigate('#test');
      if (p.cls === LineAdapter) {
        assert.strictEqual(nv.ok, true, 'LINE.navigate mock 应 ok:true');
      } else {
        assert.strictEqual(nv.ok, false, p.id + '.navigate 未定义 action 应 ok:false（骨架）');
        assert.strictEqual(nv.reason, 'action-miss', p.id + '.navigate 原因应为 action-miss');
      }
      const sd = await a.send('hello', { to: 'x', mock: true });
      assert.strictEqual(sd.ok, true, p.id + '.send(mock) ok 应为 true');
      assert.strictEqual(sd.mock, true, p.id + '.send(mock) mock 应为 true');
      // FB/WA 骨架版：scanProfile/scanMessages 已走基类探测（非纯 mock），断言 ok:true + probe/rows 结构；
      // navigate('#test') 走基类：'#test' 非 http/非 / 开头 → 查 actions，查无 → ok:false（骨架无该 action）
      if (p.cls === LineAdapter) {
        assert.strictEqual(sp.mock, true, 'LINE.scanProfile 仍为纯 mock 应 ok');
        assert.strictEqual(sm.mock, true, 'LINE.scanMessages 仍为纯 mock 应 ok');
      } else {
        assert.ok(sp.probe !== undefined || sp.accountPersona, p.id + '.scanProfile 骨架版应返回 accountPersona');
        assert.ok(Array.isArray(sm.messages) || Array.isArray(sm.rows), p.id + '.scanMessages 骨架版应返回 messages/rows');
      }
      passed += 1; console.log('  [PASS] ' + p.label);
    } else {
      // ichigo：验证 4 方法可调用 + 基类默认 scanProfile 返回 ok:true（probe 可能空，但契约成立）
      const sp = await a.scanProfile();
      assert.strictEqual(sp.ok, true, 'ichigo.scanProfile ok 应为 true');
      assert.ok(Array.isArray(sp.probe), 'ichigo.scanProfile probe 应为数组');
      const sm = await a.scanMessages('ichigo-conv');
      assert.strictEqual(sm.ok, true, 'ichigo.scanMessages ok 应为 true');
      const nv = await a.navigate('');
      assert.strictEqual(nv.ok, false, 'ichigo.navigate 空目标应 ok:false');
      assert.strictEqual(nv.reason, 'empty-target');
      const sd = await a.send('test', { mock: true });
      assert.strictEqual(sd.ok, true, 'ichigo.send(mock) ok 应为 true');
      assert.strictEqual(sd.mock, true, 'ichigo.send(mock) mock 应为 true');
      passed += 1; console.log('  [PASS] ' + p.label);
    }
  }

  // registry 断言：4 平台都注册
  assert.ok(registry['ichigo194964'], 'registry 缺 ichigo194964');
  assert.ok(registry['line'], 'registry 缺 line');
  assert.ok(registry['facebook'], 'registry 缺 facebook');
  assert.ok(registry['whatsapp'], 'registry 缺 whatsapp');

  console.log('adapters.test: ' + passed + '/4 平台通过, ' + failed + ' 失败');
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });