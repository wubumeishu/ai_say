// =============================================================================
// Ai SAY M2 · dedup 自检（node --test）
// 5 类样例：
//   1. 强锚点相同（LINE openId 命中）⇒ 直接 merge
//   2. 强锚点命中但地区矛盾 ⇒ 降级，不 merge，进 likelySame 队列
//   3. 弱锚点（姓名+年龄+地区）相同 ⇒ 进 likelySame 队列，不自动 merge
//   4. 跨平台 LINE 绑定（phone 强锚点）⇒ merge
//   5. 回滚 ⇒ rollBackMerge 后指针恢复
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const { createStore } = require('./store.js');
const { createDedup } = require('./dedup.js');

// 卫生项（task-11 G / AGENTS §3.10）：测试 db 一律放 os.tmpdir()，不在 data/ 留文件，
// 消除 Windows 全量连跑时 EBUSY 残留 → 跨子例数据累积 → MergeEvent 多计的 fixture 残留根因。
// 与 talk-rollback / metrics-funnel 同根因同类，同先例迁移。
const DB = path.join(os.tmpdir(), 'aisay-dedup-test-' + process.pid + '.db');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// 构造一个 contact 并写入强/弱锚点
function makeContact(store, { displayName, nickname, region, age, strongAnchors = [], platform = 'テスト' }) {
  const contactId = sha1('weak/' + platform + '/test-win/' + (nickname || displayName) + '|' + displayName);
  const nowIso = new Date().toISOString();

  store.db.prepare(
    'INSERT OR IGNORE INTO Contact (contactId,displayName,nickname,mergedInto,firstSeen,lastSeen,lifecycle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(contactId, displayName, nickname || displayName, null, nowIso, nowIso, 'new', nowIso, nowIso);

  store.db.prepare(
    'INSERT OR REPLACE INTO ContactProfile (contactId,age,region,height,occupation,language,intent,interests,historySummary,fields,confidence,source,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(contactId, age || null, region || null, null, null, null, 'unknown', null, '', null, 0.5, 'profile_page', nowIso, nowIso);

  for (const a of strongAnchors) {
    store.db.prepare(
      'INSERT OR REPLACE INTO ContactAnchor (anchorId,contactId,kind,value,confidence,source,createdAt) VALUES (?,?,?,?,?,?,?)'
    ).run(sha1(contactId + '|' + a.kind + '|' + a.value), contactId, 'strong', a.value, a.confidence || 0.9, a.source || 'test', nowIso);
  }
  return contactId;
}

const { safeUnlink, onExitUnlink } = require('../../.test-setup.js');
onExitUnlink([DB]);
function cleanup() {
  safeUnlink(DB);
}

test('dedup: 5 类样例', async (t) => {
  cleanup();
  const store = createStore({ dbPath: DB });
  const dedup = createDedup({ store });

  // 1. 强锚点相同（LINE openId）⇒ 直接 merge
  await t.test('强锚点相同（LINE openId）⇒ autoMergeStrong 成功', () => {
    const c1 = makeContact(store, {
      displayName: '田中', nickname: '田中', region: '埼玉', age: '30',
      strongAnchors: [{ kind: 'line_openid', value: 'U_LINE_ABC123', confidence: 0.95 }],
    });
    const c2 = makeContact(store, {
      displayName: '田中太郎', nickname: '田中太郎', region: '埼玉', age: '30',
      strongAnchors: [{ kind: 'line_openid', value: 'U_LINE_ABC123', confidence: 0.95 }],
    });

    const result = dedup.candidateMergePairs({ contactId: c1, platform: 'テスト' }, { contactId: c2, platform: 'LINE' });
    assert.ok(result.mergeable, '应可合并');
    assert.strictEqual(result.downgraded, false, '不应降级');

    const evt = dedup.autoMergeStrong({ a: { contactId: c1 }, b: { contactId: c2 } });
    assert.ok(evt, 'autoMergeStrong 应返回 MergeEvent');
    assert.strictEqual(evt.anchorKind, 'strong');

    const c2row = store.db.prepare('SELECT * FROM Contact WHERE contactId = ?').get(c2);
    assert.strictEqual(c2row.mergedInto, c1, 'c2.mergedInto 应指向 c1');
  });

  // 2. 强锚点命中但地区矛盾 ⇒ 降级，不 merge
  await t.test('强锚点命中但地区矛盾 ⇒ 降级，不 merge', () => {
    const c1 = makeContact(store, {
      displayName: '佐藤', nickname: '佐藤', region: '東京', age: '25',
      strongAnchors: [{ kind: 'email', value: 'sato@example.com', confidence: 0.9 }],
    });
    const c2 = makeContact(store, {
      displayName: '佐藤（誤入力）', nickname: '佐藤（誤入力）', region: '大阪', age: '25',
      strongAnchors: [{ kind: 'email', value: 'sato@example.com', confidence: 0.9 }],
    });

    const result = dedup.candidateMergePairs({ contactId: c1, platform: 'テスト' }, { contactId: c2, platform: 'LINE' });
    assert.strictEqual(result.mergeable, false, '地区矛盾应不可合并');
    assert.strictEqual(result.downgraded, true, '应降级');
    assert.ok(result.reason.includes('region conflict'), 'reason 应含 region conflict');

    const queued = dedup.queueLikelySame({ a: { contactId: c1 }, b: { contactId: c2 } });
    assert.ok(queued, 'queueLikelySame 应返回队列记录');
    assert.ok(queued.reason.startsWith('queue:'), 'reason 应以 queue: 开头');

    const c2row = store.db.prepare('SELECT * FROM Contact WHERE contactId = ?').get(c2);
    assert.strictEqual(c2row.mergedInto, null, '降级后不应合并');
  });

  // 3. 弱锚点（姓名+年龄+地区）相同 ⇒ 仅入队列
  await t.test('弱锚点相同 ⇒ 仅入队列，不自动 merge', () => {
    const c1 = makeContact(store, { displayName: '高橋', nickname: '高橋', region: '埼玉', age: '28' });
    const c2 = makeContact(store, { displayName: '高橋', nickname: '高橋', region: '埼玉', age: '28' });

    const result = dedup.candidateMergePairs({ contactId: c1, platform: 'テスト' }, { contactId: c2, platform: 'テスト' });
    assert.strictEqual(result.mergeable, false, '弱锚点不可自动合并');
    assert.ok(result.reason.includes('weak fingerprint'), 'reason 应含 weak fingerprint');

    const queued = dedup.queueLikelySame({ a: { contactId: c1 }, b: { contactId: c2 } });
    assert.ok(queued, '应入队列');

    const c2row = store.db.prepare('SELECT * FROM Contact WHERE contactId = ?').get(c2);
    assert.strictEqual(c2row.mergedInto, null, '弱锚点不应合并');
  });

  // 4. 跨平台 phone 强锚点 ⇒ merge
  await t.test('跨平台 phone 强锚点 ⇒ merge（平台私信 ↔ LINE）', () => {
    const c1 = makeContact(store, {
      displayName: '鈴木', nickname: '鈴木', region: '千葉', age: '35',
      strongAnchors: [{ kind: 'phone', value: '+81-90-1234-5678', confidence: 0.95 }],
      platform: '出会',
    });
    const c2 = makeContact(store, {
      displayName: '鈴木（LINE）', nickname: '鈴木', region: '千葉', age: '35',
      strongAnchors: [{ kind: 'phone', value: '+81-90-1234-5678', confidence: 0.95 }],
      platform: 'LINE',
    });

    const result = dedup.candidateMergePairs({ contactId: c1, platform: '出会' }, { contactId: c2, platform: 'LINE' });
    assert.ok(result.mergeable, 'phone 强锚点跨平台应可合并');

    const evt = dedup.autoMergeStrong({ a: { contactId: c1 }, b: { contactId: c2 } });
    assert.ok(evt, 'autoMergeStrong 应成功');
    assert.strictEqual(evt.anchorKind, 'strong');

    const c2row = store.db.prepare('SELECT * FROM Contact WHERE contactId = ?').get(c2);
    assert.strictEqual(c2row.mergedInto, c1, '跨平台合并指针正确');
  });

  // 5. 回滚
  await t.test('回滚 ⇒ rollBackMerge 恢复指针', () => {
    const c1 = makeContact(store, {
      displayName: '回滚测试A', nickname: '回滚测试A', region: '神奈川', age: '40',
      strongAnchors: [{ kind: 'line_openid', value: 'U_ROLLBACK_001', confidence: 0.99 }],
    });
    const c2 = makeContact(store, {
      displayName: '回滚测试B', nickname: '回滚测试B', region: '神奈川', age: '40',
      strongAnchors: [{ kind: 'line_openid', value: 'U_ROLLBACK_001', confidence: 0.99 }],
    });

    const evt = dedup.autoMergeStrong({ a: { contactId: c1 }, b: { contactId: c2 } });
    assert.ok(evt, '先 merge');

    let c2row = store.db.prepare('SELECT * FROM Contact WHERE contactId = ?').get(c2);
    assert.strictEqual(c2row.mergedInto, c1, '合并后指针存在');

    const rb = dedup.rollBackMerge(evt.mergeEventId);
    assert.ok(rb, 'rollBackMerge 应返回记录');
    assert.strictEqual(rb.direction, 'rollback');
    assert.strictEqual(rb.rollbackOf, evt.mergeEventId, 'rollbackOf 指向原 merge');

    c2row = store.db.prepare('SELECT * FROM Contact WHERE contactId = ?').get(c2);
    assert.strictEqual(c2row.mergedInto, null, '回滚后指针恢复为 null');

    const events = store.db.prepare(
      "SELECT * FROM MergeEvent WHERE mergedContactId = ? OR survivorContactId = ? ORDER BY createdAt ASC"
    ).all(c2, c2);
    assert.strictEqual(events.length, 2, '应有 2 条 MergeEvent');
    assert.strictEqual(events[0].direction, 'merge');
    assert.strictEqual(events[1].direction, 'rollback');
  });

  cleanup();
});

test('dedup: scanLikelySame 返回队列', async () => {
  cleanup();
  const store = createStore({ dbPath: DB });
  const dedup = createDedup({ store });

  const c1 = makeContact(store, { displayName: '队列测试A', nickname: '队列测试A', region: '福岡', age: '22' });
  const c2 = makeContact(store, { displayName: '队列测试B', nickname: '队列测试B', region: '福岡', age: '22' });
  dedup.queueLikelySame({ a: { contactId: c1 }, b: { contactId: c2 } });

  const queued = dedup.scanLikelySame(10);
  assert.ok(queued.length >= 1, 'scanLikelySame 应返回队列');
  assert.ok(queued[0].reason.startsWith('queue:'), 'reason 应以 queue: 开头');

  cleanup();
});
