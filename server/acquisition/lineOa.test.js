// =============================================================================
// Ai SAY M3 · lineOa 自检（node --test）
// 用 mock fetch（内置 mockFetch）模拟 LINE API，断言：
//   1. Webhook 签名校验（正确签名放行 / 错误签名拦截 / 无 secret mock 放行）
//   2. follow 事件 → LineMember 写入 + LineBind（phone 优先 / openId 兜底）+ 欢迎语 push
//   3. 标签群发批处理（静默 30 天移出 / 敏感词拦截 / 批内 50 人切分）
//   4. 单用户 24h push ≤2（第 3 次被拦截）
//   5. unfollow → silentDays=999（静默移出标记）
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const { createStore } = require('../db/store.js');
const { createLineOa, mockFetch, DEFAULTS } = require('./lineOa.js');

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const DB = path.join(os.tmpdir(), 'aisay-lineoa-test-' + process.pid + '.db');

function mkStore() {
  try { fs.unlinkSync(DB); } catch (e) {}
  return createStore({ dbPath: DB });
}

// 构造 contact + 强锚点 phone
function makeContactWithPhone(store, { displayName, nickname, phone }) {
  const contactId = sha1('weak/fb/win1/' + (nickname || displayName) + '|' + displayName);
  const nowIso = new Date().toISOString();
  store.db.prepare(
    'INSERT OR REPLACE INTO Contact (contactId,displayName,nickname,mergedInto,firstSeen,lastSeen,lifecycle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(contactId, displayName, nickname || displayName, null, nowIso, nowIso, 'active', nowIso, nowIso);
  if (phone) {
    store.db.prepare(
      'INSERT OR REPLACE INTO ContactAnchor (anchorId,contactId,kind,value,confidence,source,createdAt) VALUES (?,?,?,?,?,?,?)'
    ).run(sha1(contactId + '|strong|' + phone), contactId, 'strong', phone, 0.95, 'test', nowIso);
  }
  return contactId;
}

test('lineOa: Webhook 签名校验', (t) => {
  const store = mkStore();
  const { sent, impl } = mockFetch();
  const oa = createLineOa({
    store, channelAccessToken: 'tok', webhookSecret: 'secret123',
    fetchImpl: impl, cfg: { welcomeText: 'こんにちは！' },
  });

  t.test('正确签名 ⇒ 放行', async () => {
    const body = JSON.stringify({ events: [] });
    const sig = crypto.createHmac('sha256', 'secret123').update(body).digest('base64');
    const out = await oa.handleWebhook({ body, headers: { 'x-line-signature': sig } });
    assert.strictEqual(out.ok, true, '正确签名应放行');
  });

  t.test('错误签名 ⇒ 拦截', async () => {
    const body = JSON.stringify({ events: [] });
    const out = await oa.handleWebhook({ body, headers: { 'x-line-signature': 'wrong' } });
    assert.strictEqual(out.ok, false, '错误签名应拦截');
    assert.strictEqual(out.reason, 'signature-mismatch');
  });

  t.test('无 secret（mock 模式）⇒ 放行', async () => {
    const oaNoSecret = createLineOa({ store, channelAccessToken: 'tok', fetchImpl: impl });
    const out = await oaNoSecret.handleWebhook({ body: JSON.stringify({ events: [] }), headers: {} });
    assert.strictEqual(out.ok, true, '无 secret mock 应放行');
  });
});

test('lineOa: follow 事件 → LineMember + LineBind + 欢迎语', (t) => {
  const store = mkStore();
  const contactId = makeContactWithPhone(store, { displayName: '田中', nickname: 'タナカ', phone: '09012345678' });
  const { sent, impl } = mockFetch();
  const oa = createLineOa({
    store, channelAccessToken: 'tok', fetchImpl: impl,
    cfg: { welcomeText: 'ようこそ！LINE: aisay.official' },
    phoneResolver: (openId) => {
      // 模拟 LINE Login 解析：U_TANAKA → phone
      return openId === 'U_TANAKA' ? '09012345678' : null;
    },
  });

  t.test('phone join key（高置信度）', async () => {
    // 先写一个已有 LineBind（模拟之前已绑过）
    oa.upsertLineMember('U_TANAKA', {});
    const bind = oa.upsertLineBind(contactId, 'U_TANAKA', 'phone', 0.95);
    assert.ok(bind, 'LineBind 应写入');

    const out = await oa.handleWebhook({
      body: JSON.stringify({ events: [{ type: 'follow', source: { userId: 'U_TANAKA' } }] }),
      headers: {},
    });
    assert.strictEqual(out.ok, true);
    const evt = out.events[0];
    assert.strictEqual(evt.type, 'follow');
    assert.strictEqual(evt.bound, true);
    assert.strictEqual(evt.joinKey, 'phone', '应有 phone join key（高置信度）');
    assert.strictEqual(evt.contactId, contactId, '应绑定到 contactId');
    assert.strictEqual(evt.welcomeSent, true, '欢迎语 push 应成功（mock）');

    // LineMember 写入
    const member = store.db.prepare('SELECT * FROM LineMember WHERE openId=?').get('U_TANAKA');
    assert.ok(member, 'LineMember 应存在');
    assert.strictEqual(member.silentDays, 0, '新 follow silentDays=0');
  });

  t.test('openId 兜底（无 phone）', async () => {
    const oaNoPhone = createLineOa({
      store, channelAccessToken: 'tok', fetchImpl: impl,
      cfg: { welcomeText: 'こんにちは！' },
    });
    oaNoPhone.upsertLineMember('U_SATO', {});
    const out = await oaNoPhone.handleWebhook({
      body: JSON.stringify({ events: [{ type: 'follow', source: { userId: 'U_SATO' } }] }),
      headers: {},
    });
    const evt = out.events[0];
    assert.strictEqual(evt.bound, true);
    assert.strictEqual(evt.joinKey, 'openId', '无 phone 时应走 openId 兜底');
  });
});

test('lineOa: 标签群发批处理', (t) => {
  const store = mkStore();
  const { sent, impl } = mockFetch();

  // 写入 60 个 LineMember（测试批 ≤50 切分）
  const openIds = [];
  for (let i = 0; i < 60; i++) {
    const oid = 'U_BATCH_' + i;
    store.db.prepare(
      'INSERT INTO LineMember (openId,displayName,region,lineTag,bindPhone,silentDays,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)'
    ).run(oid, 'user' + i, '', null, null, 0, new Date().toISOString(), new Date().toISOString());
    openIds.push(oid);
  }
  // 写 Tag 行（appliedTo = 全部 60 人）
  const nowIso = new Date().toISOString();
  store.db.prepare(
    'INSERT INTO Tag (tagId,layer,value,appliedTo,createdAt,updatedAt) VALUES (?,?,?,?,?,?)'
  ).run(sha1('tag/intent/hot'), 'intent', 'hot', JSON.stringify(openIds), nowIso, nowIso);

  // 静默 30 天：把 10 人 silentDays=35（应被移出）
  for (let i = 0; i < 10; i++) {
    store.db.prepare('UPDATE LineMember SET silentDays=35 WHERE openId=?').run('U_BATCH_' + i);
  }

  const oa = createLineOa({ store, channelAccessToken: 'tok', fetchImpl: impl });

  t.test('静默 30 天移出 + 批 50 人切分', async () => {
    const out = await oa.tagCampaign({ layer: 'intent', value: 'hot', text: '新着情報です' });
    assert.strictEqual(out.ok, true, '群发应成功');
    assert.strictEqual(out.selected, 50, '30 天静默 10 人移出，剩 50');
    assert.strictEqual(out.skipped, 10, 'skipped=10（静默）');
    assert.ok(out.alerts.some((a) => a.alert === 'silent-removed'), '应有 silent-removed 告警');
    // 批 50 人切分：50 < batchSize(50)，只发 1 批
    const multicastCalls = sent.filter((s) => s.url.includes('/multicast'));
    assert.strictEqual(multicastCalls.length, 1, '50 人 = 1 批');
  });

  t.test('敏感词拦截', async () => {
    const oaSensitive = createLineOa({
      store, channelAccessToken: 'tok', fetchImpl: impl,
      cfg: Object.assign({}, DEFAULTS, { sensitiveWords: ['賭博', '金融商材'] }),
    });
    const out = await oaSensitive.tagCampaign({ layer: 'intent', value: 'hot', text: '賭博サイトのご案内' });
    assert.strictEqual(out.ok, false, '敏感词应拦截');
    assert.strictEqual(out.reason, 'sensitive');
    assert.ok(out.alerts.some((a) => a.alert === 'sensitive-blocked'));
  });

  t.test('单用户 24h push ≤2（第 3 次被拦截）', async () => {
    const { impl: impl2 } = mockFetch();
    const oa2 = createLineOa({ store, channelAccessToken: 'tok', fetchImpl: impl2 });
    const r1 = await oa2.push('hi', { to: 'U_BATCH_0' });
    assert.strictEqual(r1.ok, true, '第 1 次 push 成功');
    const r2 = await oa2.push('hi', { to: 'U_BATCH_0' });
    assert.strictEqual(r2.ok, true, '第 2 次 push 成功');
    const r3 = await oa2.push('hi', { to: 'U_BATCH_0' });
    assert.strictEqual(r3.ok, false, '第 3 次 push 应被 24h 限频拦截');
    assert.strictEqual(r3.reason, 'per-user-24h-limit');
  });
});

test('lineOa: unfollow → silentDays=999（静默移出标记）', () => {
  const store = mkStore();
  store.db.prepare(
    'INSERT INTO LineMember (openId,displayName,region,lineTag,bindPhone,silentDays,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)'
  ).run('U_UNFOL', 'test', '', null, null, 0, new Date().toISOString(), new Date().toISOString());
  const { impl } = mockFetch();
  const oa = createLineOa({ store, channelAccessToken: 'tok', fetchImpl: impl });

  const out = oa.onUnfollow({ openId: 'U_UNFOL' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.marked, 'unfollowed');
  const row = store.db.prepare('SELECT * FROM LineMember WHERE openId=?').get('U_UNFOL');
  assert.strictEqual(row.silentDays, 999, 'unfollow 后 silentDays=999');
});

test('lineOa: getProfile / addFollowers（mock）', async (t) => {
  const store = mkStore();
  const { impl } = mockFetch();
  const oa = createLineOa({ store, channelAccessToken: 'tok', fetchImpl: impl });

  await t.test('getProfile', async () => {
    const out = await oa.getProfile('U_TEST');
    assert.strictEqual(out.ok, true);
    assert.ok(out.profile, 'profile 应存在（mock）');
  });

  await t.test('addFollowers', async () => {
    const out = await oa.addFollowers({ limit: 10 });
    assert.strictEqual(out.ok, true);
    assert.ok(Array.isArray(out.users), 'users 应为数组');
  });
});

test('cleanup', () => { try { fs.unlinkSync(DB); } catch (e) {} });
