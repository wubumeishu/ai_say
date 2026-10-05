// =============================================================================
// Ai SAY M5 task-25 · 话术回滚自检（node --test）
// 断言：talkEngine.rollbackLastTalk(contactId)
//   1. 读取最近一条 sentLog（已发话术）；
//   2. 写 LeadEvent(action='archived', signals 含 rollbackLastTalk)；
//   3. TalkAbStat 版本回退 1 次（trials/conversions 减 1，下限 0）；
//   4. abStats.winner 行置 reDecide（让下次 recordConversion 重新裁决模板版本）。
// =============================================================================
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(__dirname, '..', 'data', 'talk_rollback_test.db');

const { safeUnlink, onExitUnlink } = require('../.test-setup.js');
onExitUnlink([TMP_DB]);
function cleanup() {
  safeUnlink(TMP_DB);
}

let store, talkEngine, contactRB, contactNONE;

before(async () => {
  cleanup();
  const { createStore } = require('../server/db/store');
  const { createTalkEngine } = require('../server/acquisition/talkEngine');
  store = createStore({ dbPath: TMP_DB });
  // 造一个真实的 Contact（触发 triggerGuide / rollbackLastTalk 时 LeadEvent 外键可命中）
  contactRB = store.upsertContact({ windowId: 'w1', platform: 'ichigo', contactKey: 'cust-RB', contact: { name: '回滚客户' } }).contactId;
  contactNONE = store.upsertContact({ windowId: 'w1', platform: 'ichigo', contactKey: 'cust-NONE', contact: { name: '无话术客户' } }).contactId;
  // 不传 sendHook：triggerGuide 视为「生成成功」，会记 sentLog + abStats.trials
  talkEngine = createTalkEngine({ store, sendHook: null, lineId: 'test-line' });
});
after(() => cleanup());

test('triggerGuide 产生 sentLog + abStats.trials 记账', () => {
  const lead = talkEngine.triggerGuide({
    accountId: 'acc-test', contactId: contactRB, tier: 'hot', score: 85,
    signals: [{ signal: 'lineWillingness' }], category: 'outreach', language: 'ja', platform: 'ichigo',
    accountPersona: { tone: '友好' }, customerProfile: { contactId: contactRB, name: '回滚客户', region: '埼玉' },
  });
  assert.strictEqual(lead.sent, true, '无 sendHook 时应视为生成成功');
  assert.strictEqual(lead.leadEvent && lead.leadEvent.action, 'triggered');
  const stats = talkEngine.getAbStats();
  const v = talkEngine.variantOf(contactRB);
  assert.ok(stats[v] && stats[v].trials >= 1, '该客户所属变体 trials 应 ≥1');
  assert.ok(talkEngine._sentLog.length >= 1, 'sentLog 应有记录');
});

test('rollbackLastTalk 写 LeadEvent(action=archived) 且 TalkAbStat 版本回退', () => {
  const beforeStats = talkEngine.getAbStats();
  const v = talkEngine.variantOf(contactRB);
  const trialsBefore = (beforeStats[v] || {}).trials || 0;

  const r = talkEngine.rollbackLastTalk(contactRB);
  assert.strictEqual(r.rolledBack, true, '有已发话术时 rolledBack=true');
  assert.ok(r.previousTemplateVersion, '应返回上一版模板版本');
  // 1. LeadEvent 落库：最近一条 = archived + signals 标注 rollbackLastTalk
  const leadEvents = store.db.prepare('SELECT * FROM LeadEvent WHERE contactId = ? ORDER BY rowid DESC LIMIT 1').get(contactRB);
  assert.strictEqual(leadEvents.action, 'archived', '回滚后最新 LeadEvent action=archived');
  let signals = [];
  try { signals = JSON.parse(leadEvents.signals || '[]'); } catch (_) {}
  assert.ok(signals.some((s) => s && s.signal === 'rollbackLastTalk'), 'signals 应标注 rollbackLastTalk');

  // 2. TalkAbStat 版本回退：trials 减 1（下限 0）
  const afterStats = talkEngine.getAbStats();
  const target = r.rolledBackVariant;
  assert.strictEqual((afterStats[target] || {}).trials, Math.max(0, trialsBefore - 1), '版本回退后 trials 应减 1');

  // 3. winner 行 reDecide（让下次 recordConversion 重新裁决）
  assert.ok(afterStats.winner && afterStats.winner.reDecide, 'winner 行应置 reDecide 标记');
});

test('无已发话术时 rollbackLastTalk 仍写 archived LeadEvent 且 rolledBack=false', () => {
  const r = talkEngine.rollbackLastTalk(contactNONE);
  assert.strictEqual(r.rolledBack, false, '无已发话术时 rolledBack=false');
  const leadEvents = store.db.prepare('SELECT * FROM LeadEvent WHERE contactId = ? ORDER BY rowid DESC LIMIT 1').get(contactNONE);
  assert.strictEqual(leadEvents.action, 'archived', '即使无已发话术也写 archived LeadEvent（100% 事件覆盖）');
});

test('POST /api/console/rules/rollback 指定 contactId 走 rollbackLastTalk 分支', async () => {
  const { mountConsoleRoutes } = require('../server/consoleRoutes');
  const { createDedup } = require('../server/db/dedup');
  const dedup = createDedup({ store });
  const fakeApp = { _routes: [], get(p, h) { this._routes.push({ method: 'GET', p, h }); }, post(p, h) { this._routes.push({ method: 'POST', p, h }); } };
  mountConsoleRoutes(fakeApp, { store, talkEngine, dedup, adapters: null });
  const r = fakeApp._routes.find((x) => x.method === 'POST' && x.p === '/api/console/rules/rollback');
  assert.ok(r, 'rollback 路由应注册');
  const req = { method: 'POST', url: '/api/console/rules/rollback', params: {} };
  const res = { _code: 0, _body: null, writeHead(c) { this._code = c; }, end(b) { this._body = b; } };
  req.__body = { contactId: contactRB };
  await r.h(req, res);
  const out = JSON.parse(res._body || '{}');
  assert.strictEqual(out.ok, true, '应 200 ok');
  assert.strictEqual(out.data.rolledBack, true, '指定 contactId 走 rollbackLastTalk 分支');
});
