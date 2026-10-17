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
const os = require('os');

// 卫生项（task-1 / AGENTS §3.10）：测试 db 一律放 os.tmpdir()，不在 data/ 留文件，
// 消除 safeUnlink EBUSY 残留锁（原 data/talk_rollback_test.db）。
const TMP_DB = path.join(os.tmpdir(), 'aisay-talk-rollback-test-' + process.pid + '.db');

const { safeUnlink, onExitUnlink } = require('../.test-setup.js');
onExitUnlink([TMP_DB]);
function cleanup() {
  safeUnlink(TMP_DB);
}

let store, talkEngine, contactRB, contactNONE;
let createTalkEngine;

before(async () => {
  cleanup();
  const { createStore } = require('../server/db/store');
  createTalkEngine = require('../server/acquisition/talkEngine').createTalkEngine;
  store = createStore({ dbPath: TMP_DB });
  // 造一个真实的 Contact（触发 triggerGuide / rollbackLastTalk 时 LeadEvent 外键可命中）
  contactRB = store.upsertContact({ windowId: 'w1', platform: 'ichigo', contactKey: 'cust-RB', contact: { name: '回滚客户' } }).contactId;
  contactNONE = store.upsertContact({ windowId: 'w1', platform: 'ichigo', contactKey: 'cust-NONE', contact: { name: '无话术客户' } }).contactId;
  // 不传 sendHook：task-37 语义下 triggerGuide 恒「生成入待确认队列」（不自动发），
  // 仍会记 sentLog(blocked:false, pending:true) + abStats.trials；真发走 confirmSend。
  talkEngine = createTalkEngine({ store, sendHook: null, lineId: 'test-line' });
});
after(() => cleanup());

test('triggerGuide 产生 sentLog + abStats.trials 记账（task-37 新语义）', () => {
  const lead = talkEngine.triggerGuide({
    accountId: 'acc-test', contactId: contactRB, tier: 'hot', score: 85,
    signals: [{ signal: 'lineWillingness' }], category: 'outreach', language: 'ja', platform: 'ichigo',
    accountPersona: { tone: '友好' }, customerProfile: { contactId: contactRB, name: '回滚客户', region: '埼玉' },
  });
  // task-37：triggerGuide 不再自动发送，恒 { sent:false, pending:true } 入 pendingQueue；
  // 真发走 confirmSend（无 sendHook 时 confirmSend 视为生成成功并补记 sentLog）。
  assert.strictEqual(lead.sent, false, 'task-37：triggerGuide 不自动发，sent 恒 false');
  assert.strictEqual(lead.pending, true, '生成后应入待确认队列（pending=true）');
  assert.strictEqual(lead.leadEvent && lead.leadEvent.action, 'triggered');
  const stats = talkEngine.getAbStats();
  const v = talkEngine.variantOf(contactRB);
  assert.ok(stats[v] && stats[v].trials >= 1, '该客户所属变体 trials 应 ≥1（生成即记）');
  assert.ok(talkEngine._sentLog.length >= 1, 'sentLog 应有记录');
  const lastLog = talkEngine._sentLog[talkEngine._sentLog.length - 1];
  assert.strictEqual(lastLog.blocked, false, '通过生成记 sentLog(blocked:false, pending:true)');
  assert.strictEqual(lastLog.pending, true, 'sentLog 区分「生成未真发」靠 pending 标志');

  // 补 confirmSend 真发路径断言（task-37：真发只在 confirmSend 成功后记账）。
  // 用独立引擎（contactCS）隔离真发路径，避免污染共享 talkEngine 的
  // sentLog/abStats 状态（后续 rollback 用例依赖它；且 24h 频控额度会互串）。
  const contactCS = store.upsertContact({ windowId: 'w1', platform: 'ichigo', contactKey: 'cust-CS', contact: { name: '确认客户' } }).contactId;
  const engCS = createTalkEngine({ store, sendHook: null, lineId: 'test-line' });
  const csGen = engCS.triggerGuide({
    accountId: 'acc-cs', contactId: contactCS, tier: 'warm', score: 50,
    category: 'ai_meeting', language: 'ja', platform: 'fb',
    accountPersona: { tone: '友好' }, customerProfile: { contactId: contactCS, name: '确认客户' },
  });
  assert.strictEqual(csGen.pending, true, '生成入待确认队列');
  const cs = engCS.confirmSend({ accountId: 'acc-cs', contactId: contactCS });
  assert.strictEqual(cs.sent, true, 'confirmSend 无 sendHook 时视为真发成功');
  assert.strictEqual(cs.queueEntry.confirmed, true, '确认应标记 queueEntry.confirmed=true');
  assert.ok(engCS._sentLog.length >= 2, 'confirmSend 成功应再记一条 sentLog');
  const csLog = engCS._sentLog[engCS._sentLog.length - 1];
  assert.strictEqual(csLog.blocked, false, '真发 sentLog(blocked:false)');
  assert.notStrictEqual(csLog.pending, true, '真发记录 pending 标志应为 undefined/false（区别于生成未发）');
  const evts = store.db.prepare('SELECT action, lineOffered FROM LeadEvent WHERE contactId = ? ORDER BY rowid DESC LIMIT 1').get(contactCS);
  assert.strictEqual(evts.action, 'triggered', 'confirmSend 成功写 triggered LeadEvent');
  assert.strictEqual(evts.lineOffered, 1, 'confirmSend 成功 lineOffered=1');
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
