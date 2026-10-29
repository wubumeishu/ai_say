'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createUnreadPoller } = require('./unreadPoller');

// 模拟一个"快乐"scanner（unread 字段，同 happyInboxExpr）
function fakeHappyScanner() {
  let contacts = [
    { memberID: '40447426', name: 'haruki', unread: 0 },
    { memberID: '12655369', name: 'takataka', unread: 0 },
  ];
  return {
    _set: (i, v) => { contacts[i].unread = v; },
    scanInbox: async () => ({ ok: true, contacts }),
  };
}

test('unreadPoller: 首轮建基线不触发', async () => {
  let evts = [];
  const sc = fakeHappyScanner();
  const p = createUnreadPoller({ intervalMs: 999999, platforms: [{ label: 'kairaku', getScanner: () => sc }] });
  p.onUnread((e) => evts.push(e));
  await p.tick();
  assert.equal(evts.length, 0, '首轮只建基线');
  assert.equal(p.snapshot().baselineCount, 2);
});

test('unreadPoller: 未读 0→1 触发 unread-increment（delta=1）', async () => {
  let evts = [];
  const sc = fakeHappyScanner();
  const p = createUnreadPoller({ intervalMs: 999999, platforms: [{ label: 'kairaku', getScanner: () => sc }] });
  p.onUnread((e) => evts.push(e));
  await p.tick();          // 基线
  sc._set(0, 1);           // haruki 未读 0→1
  await p.tick();          // 增量
  assert.equal(evts.length, 1, '应 1 条增量事件');
  assert.equal(evts[0].memberKey, '40447426');
  assert.equal(evts[0].delta, 1);
  assert.equal(evts[0].type, 'unread-increment');
});

test('unreadPoller: 未读下降不触发（对方读了）', async () => {
  let evts = [];
  const sc = fakeHappyScanner();
  const p = createUnreadPoller({ intervalMs: 999999, platforms: [{ label: 'kairaku', getScanner: () => sc }] });
  p.onUnread((e) => evts.push(e));
  await p.tick();
  sc._set(1, 5);
  await p.tick();          // takataka 0→5 触发 1
  assert.equal(evts.length, 1);
  sc._set(1, 2);           // 5→2 下降，不触发
  await p.tick();
  assert.equal(evts.length, 1, '下降不新增事件');
});

test('unreadPoller: scanner 不可达降级（不崩）', async () => {
  const p = createUnreadPoller({ intervalMs: 999999, platforms: [{ label: 'kairaku', getScanner: () => null }] });
  let evts = [];
  p.onUnread((e) => evts.push(e));
  await p.tick();          // 应安全跳过
  assert.equal(evts.length, 0);
  assert.equal(p.snapshot().lastError, 'scanner-not-ready(kairaku)');
});

test('unreadPoller: snapshot 暴露 baselineCount + recentEvents', async () => {
  const sc = fakeHappyScanner();
  const p = createUnreadPoller({ intervalMs: 999999, platforms: [{ label: 'kairaku', getScanner: () => sc }] });
  let evts = [];
  p.onUnread((e) => evts.push(e));
  await p.tick();
  sc._set(0, 2);
  await p.tick();
  const snap = p.snapshot();
  assert.equal(snap.baselineCount, 2);
  assert.equal(snap.recentEvents.length, 1);
  assert.equal(snap.intervalMs, 999999);
});
