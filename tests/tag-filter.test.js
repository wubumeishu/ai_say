// =============================================================================
// Ai SAY M5 task-32 · 标签筛选 + 引流漏斗自检（node --test）
// 造 Tag（5 层）+ Contact + LeadEvent + LineMember/LineBind，断言：
//   1. /api/console/tags 各层分布正确（value + contactCount）；
//   2. /api/console/customers?tag=intent:hot 只返回 hot 客户；
//   3. 每个客户的 funnelCurrentLayer 当前层正确。
// 约束：不改 M0 schema（Tag 表已存在，只读 + customers 端点扩展 tag 参数）。
// =============================================================================
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

const TMP_DB = path.join(__dirname, '..', 'data', 'tag_filter_test.db');
function cleanup() { try { fs.unlinkSync(TMP_DB); } catch (_) {} }

let store, talkEngine, dedup, fakeApp, db;
const NOW = () => new Date().toISOString();

before(async () => {
  cleanup();
  const { createStore } = require('../server/db/store');
  const { createDedup } = require('../server/db/dedup');
  const { createTalkEngine } = require('../server/acquisition/talkEngine');
  const { mountConsoleRoutes } = require('../server/consoleRoutes');

  store = createStore({ dbPath: TMP_DB });
  db = store.db;
  dedup = createDedup({ store });
  talkEngine = createTalkEngine({ store, sendHook: null, lineId: 'test-line' });
  fakeApp = { _routes: [], get(p, h) { this._routes.push({ method: 'GET', p, h }); }, post(p, h) { this._routes.push({ method: 'POST', p, h }); } };
  mountConsoleRoutes(fakeApp, { store, talkEngine, dedup, adapters: null });

  // 造 4 个客户：
  //   t-hot1 : intent=hot, 有会话, LeadEvent tier=hot lineOffered=1（已引流）
  //   t-hot2 : intent=hot, 有会话, LeadEvent tier=hot（未引流）
  //   t-warm : intent=warm, 有会话, LeadEvent tier=warm
  //   t-cold : intent=cold, 有会话, 无 LeadEvent
  const plan = [
    { key: 't-hot1', intent: 'hot', tier: 'hot', offered: 1, lineAdded: 0, source: 'ichigo', status: 'active', category: '出会い', bound: false },
    { key: 't-hot2', intent: 'hot', tier: 'hot', offered: 0, lineAdded: 0, source: 'fb', status: 'active', category: '出会い', bound: false },
    { key: 't-warm', intent: 'warm', tier: 'warm', offered: 0, lineAdded: 0, source: 'ichigo', status: 'silent', category: '恋愛', bound: false },
    { key: 't-cold', intent: 'cold', tier: 'cold', offered: 0, lineAdded: 0, source: 'wa', status: 'churned', category: '交友', bound: false },
  ];
  const ids = {};
  for (const p of plan) {
    const c = store.upsertContact({ windowId: 'w1', platform: p.source === 'fb' ? 'fb' : 'ichigo', contactKey: p.key, contact: { name: '客户' + p.key } });
    ids[p.key] = c.contactId;
    store.upsertConversation({
      windowId: 'w1', platform: p.source === 'fb' ? 'fb' : 'ichigo', contactKey: p.key,
      contactName: p.key, contact: { name: '客户' + p.key },
      messages: [{ role: 'other', original: 'hi ' + p.key, index: 0 }],
    });
    if (p.tier !== 'none') {
      db.prepare('INSERT INTO LeadEvent (leadEventId, contactId, score, tier, signals, action, lineOffered, lineAdded, createdAt) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(p.key + '-lead', c.contactId, 80, p.tier, '[]', 'triggered', p.offered, p.lineAdded, NOW());
    }
    // 标签：intent + source + status + category 四值各一
    db.prepare('INSERT INTO Tag (tagId, layer, value, appliedTo, createdAt, updatedAt) VALUES (?,?,?,?,?,?)')
      .run(p.key + '-intent', 'intent', p.intent, JSON.stringify([c.contactId]), NOW(), NOW());
    db.prepare('INSERT INTO Tag (tagId, layer, value, appliedTo, createdAt, updatedAt) VALUES (?,?,?,?,?,?)')
      .run(p.key + '-source', 'source', p.source, JSON.stringify([c.contactId]), NOW(), NOW());
    db.prepare('INSERT INTO Tag (tagId, layer, value, appliedTo, createdAt, updatedAt) VALUES (?,?,?,?,?,?)')
      .run(p.key + '-status', 'status', p.status, JSON.stringify([c.contactId]), NOW(), NOW());
    db.prepare('INSERT INTO Tag (tagId, layer, value, appliedTo, createdAt, updatedAt) VALUES (?,?,?,?,?,?)')
      .run(p.key + '-cat', 'category', p.category, JSON.stringify([c.contactId]), NOW(), NOW());
  }
  // 绑定 1 名 LineMember（t-hot1）
  db.prepare('INSERT INTO LineMember (openId, displayName, region, silentDays, createdAt, updatedAt) VALUES (?,?,?,?,?,?)')
    .run('open-hot1', '客户 t-hot1', '', 0, NOW(), NOW());
  db.prepare('INSERT INTO LineBind (bindId, contactId, openId, joinKey, confidence, createdAt) VALUES (?,?,?,?,?,?)')
    .run(ids['t-hot1'] + '-bind', ids['t-hot1'], 'open-hot1', 'phone', 0.9, NOW());
  // 更新 t-hot1 lineAdded=1（留 LINE）+ 绑定
  db.prepare('UPDATE LeadEvent SET lineAdded = 1 WHERE contactId = ?').run(ids['t-hot1']);

  store.__ids = ids;
});
after(() => cleanup());

function invoke(pathname, query = {}) {
  const r = fakeApp._routes.find((x) => x.method === 'GET' && x.p === pathname);
  assert.ok(r, 'route registered: ' + pathname);
  const qs = new URLSearchParams(query).toString();
  return new Promise((resolve) => {
    const req = { method: 'GET', url: '/' + pathname.split('/')[1] + '?' + qs, params: {} };
    const res = { _code: 0, _body: null, writeHead(c) { this._code = c; }, end(b) { this._body = b; } };
    r.h(req, res).then(() => resolve({ code: res._code, body: JSON.parse(res._body || '{}') }));
  });
}

test('/api/console/tags 各层分布正确', async () => {
  const out = await invoke('/api/console/tags');
  assert.strictEqual(out.code, 200);
  assert.strictEqual(out.body.ok, true);
  const byLayer = {};
  out.body.data.forEach((l) => { byLayer[l.layer] = l; });
  // intent: hot=2, warm=1, cold=1
  const intent = byLayer.intent.values;
  const intentMap = {};
  intent.forEach((v) => { intentMap[v.value] = v.contactCount; });
  assert.strictEqual(intentMap.hot, 2, 'intent hot=2');
  assert.strictEqual(intentMap.warm, 1, 'intent warm=1');
  assert.strictEqual(intentMap.cold, 1, 'intent cold=1');
  // source: ichigo=2, fb=1, wa=1
  const srcMap = {};
  byLayer.source.values.forEach((v) => { srcMap[v.value] = v.contactCount; });
  assert.strictEqual(srcMap.ichigo, 2, 'source ichigo=2');
  assert.strictEqual(srcMap.fb, 1, 'source fb=1');
  // 5 层都在
  assert.strictEqual(out.body.data.length, 5, '应有 5 层');
});

test('/api/console/customers?tag=intent:hot 只返回 hot 客户 + funnel 当前层', async () => {
  const out = await invoke('/api/console/customers', { tag: 'intent:hot' });
  assert.strictEqual(out.code, 200);
  assert.strictEqual(out.body.ok, true);
  assert.deepStrictEqual(out.body.tag, { layer: 'intent', value: 'hot' });
  const keys = out.body.data.map((c) => c.nickname).sort();
  assert.deepStrictEqual(keys, ['t-hot1', 't-hot2'], '只应返回 2 个 hot 客户');
  // funnel 当前层：t-hot1 已绑定（lineAdded+LineBind）→ bound；t-hot2 仅 hot → hot
  const byName = {};
  out.body.data.forEach((c) => { byName[c.nickname] = c; });
  assert.strictEqual(byName['t-hot1'].funnelCurrentLayer.stage, 'bound', 't-hot1 应已绑定');
  assert.strictEqual(byName['t-hot1'].funnelCurrentLayer.progress, 1, 'bound progress=1');
  assert.strictEqual(byName['t-hot2'].funnelCurrentLayer.stage, 'hot', 't-hot2 应为 hot');
});

test('/api/console/customers?tag=intent:warm 返回 warm 客户 + 未引流（scored 层）', async () => {
  const out = await invoke('/api/console/customers', { tag: 'intent:warm' });
  assert.strictEqual(out.body.data.length, 1, 'warm 仅 1 客户');
  assert.strictEqual(out.body.data[0].nickname, 't-warm');
  // t-warm 有 LeadEvent(warm) 但未引流/未留LINE/未绑定 → 最深为 scored（非 hot）
  assert.strictEqual(out.body.data[0].funnelCurrentLayer.stage, 'scored', 't-warm 未引流应停在 scored');
});

test('无命中标签返回空 + tag 回显', async () => {
  const out = await invoke('/api/console/customers', { tag: 'intent:nonexistent' });
  assert.strictEqual(out.code, 200);
  assert.strictEqual(out.body.data.length, 0, '不存在的标签值应返回空');
  assert.deepStrictEqual(out.body.tag, { layer: 'intent', value: 'nonexistent' });
});
