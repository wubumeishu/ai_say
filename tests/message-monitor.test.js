// =============================================================================
// Ai SAY Phase 3 task-6 · 消息监控 onMessage 空转 复现 + 修复验收（node --test）
//
// 背景（AGENTS.md §3.3.4）：app.js startMonitor(browserId, wsUrl, opts) 的
//   opts.onMessage 来自 HTTP body（POST /api/monitor 的 JSON），函数无法经
//   JSON 序列化 ⇒ 运行时恒 undefined。MessageMonitor.extractMessages 里
//   this.onMessage({...}) 对 undefined 调用 ⇒ 每次轮询到新消息行都抛
//   TypeError，被 poll() 的 catch 吞掉（「没报错但没效果」的空转）。
//
// 本文件：修复前先复现（t1/t2 当前为红），task-6 放行修复后全绿。
//   t1: 模拟 HTTP 轨构造（onMessage 缺省）→ extractMessages 不得抛错（修复后安全降级）；
//   t2: 服务侧进程内 sink 注册（修复后新增 API）→ 消息可被进程内消费者拿到（消除空转）；
//   t3: 用户显式传 onMessage → 行为不变（回归）；
//   t4: 消息缓冲上限 + 已读去重（回归）。
// 约束：不碰 CDP（mock devtoolsClient）；不用 DB；无空 catch。
// =============================================================================
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { MessageMonitor } = require('../server/messageMonitor');

function mockClient(text) {
  // 模拟 CDP evaluate：永远返回同一段页面文本（含一条新消息）
  return { evaluate: async () => ({ value: text }) };
}

function mkMonitor({ onMessage, sinks }) {
  return new MessageMonitor({
    devtoolsClient: mockClient('新消息：今晚見たい！'),
    browserId: 'win-test',
    pollInterval: 1000,
    onMessage, // 缺省 = undefined，模拟 HTTP body 序列化的丢失
    logger: { warn() {}, error() {} },
    sinks,    // task-6 修复后的进程内 sink 注册（当前 MessageMonitor 尚未支持）
  });
}

test('task-6 复现 t1: HTTP 轨构造（onMessage 缺省）extractMessages 不得抛错（空转复现）', () => {
  const m = mkMonitor({}); // onMessage === undefined
  // 当前行为：extractMessages 内 this.onMessage(...) 抛 TypeError（空转根源）。
  // 修复后：onMessage 缺省时安全降级为进程内 sink / no-op，不抛。
  assert.doesNotThrow(() => {
    m.extractMessages('新消息：今晚見たい！');
  }, 'onMessage 缺省不应抛错（HTTP body 序列化丢失函数是已知坑 §3.3.4）');
});

test('task-6 修复 t2: 进程内 sink 注册后消息可被消费者拿到（消除空转）', () => {
  const got = [];
  const sinks = { register: (fn) => { got.push(fn); } }; // 修复后 MessageMonitor 会调用 register
  const m = mkMonitor({ sinks });
  // 修复后 API：monitor.onMessage = sinkFn 或 sinkRegistry（见 task-6 设计）
  // 这里断言「新消息行触发了至少一次 sink 回调」
  let delivered = 0;
  const sink = (evt) => { delivered += 1; assert.strictEqual(evt.text, '新消息：今晚見たい！'); };
  if (m.registerSink && typeof m.registerSink === 'function') {
    m.registerSink(sink);
    m.extractMessages('新消息：今晚見たい！');
    assert.strictEqual(delivered, 1, 'sink 应收到新消息 1 次（去重后）');
  } else {
    throw new Error('task-6 未修复：MessageMonitor 尚无进程内 sink API（registerSink），onMessage 恒 undefined ⇒ 空转');
  }
});

test('task-6 回归 t3: 用户显式 onMessage 行为不变', () => {
  let called = 0;
  const m = mkMonitor({ onMessage: (evt) => { called += 1; } });
  m.extractMessages('hello line');
  assert.strictEqual(called, 1, '显式 onMessage 应被调用');
  m.extractMessages('hello line'); // 重复行去重
  assert.strictEqual(called, 1, '已见行不重复分发');
});

test('task-6 回归 t4: 消息缓冲上限 + poll() 吞错语义保持', async () => {
  const client = mockClient('新消息：今晚見たい！');
  // 打回修复：_appendBufferMessage 只在 profileStore 存在时执行（messageMonitor.js L78），
  // 不传 profileStore 则 messageBuffer 恒空，裁剪语义是假绿。传最小桩打开 hook 分支
  //（profileStore 桩提供 upsertContact 防止 supplementProfileHook 走 require 路径）。
  const m = new MessageMonitor({
    devtoolsClient: client,
    browserId: 'win-test',
    pollInterval: 1000,
    onMessage: () => {},
    logger: { warn() {}, error() {} },
    profileStore: { upsertContact() { return {}; } }, // 最小桩：打开 messageBuffer 分支
    profileMeta: { contactKey: 'ck', platform: 'ichigo', windowId: 'w' },
  });
  // 灌 45 行新消息（> 40 上限）
  for (let i = 0; i < 45; i++) m.extractMessages('line-' + i);
  assert.strictEqual(m.messageBuffer.length, 40, '缓冲应恰好裁到 40（实际 ' + m.messageBuffer.length + '）');
  assert.ok(m.messageBuffer.length > 0, '裁剪语义真验证：缓冲非空');
  // poll()：client 抛错时仅 warn，不冒泡（现有语义保持）——直接改写 mock client 对象（与 monitor 共享引用）
  client.evaluate = async () => { throw new Error('cdp-down'); };
  await assert.doesNotReject(() => m.poll(), 'poll 内部吞 CDP 错误（现状语义）');
});
