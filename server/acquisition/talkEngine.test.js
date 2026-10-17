// =============================================================================
// Ai SAY M3 · talkEngine 自检（node --test）
// 4 类样例（对齐任务验收，task-37 语义：triggerGuide 恒 {sent:false, pending:true}，
//   生成入 pendingQueue 不自动发；真发只走 confirmSend（成功才调 sendHook + 补记
//   sentLog/LeadEvent lineOffered=1））：
//   1. warm + 合规（allow）         → 生成话术含人设+画像变量，confirmSend 后经 adapter.send 契约发送
//   2. warm + 命中频控（24h ≥2）   → 拦截，LeadEvent 仍落库（action=triggered）
//   3. warm + 黑名单（compliance）  → 拦截，reason 含「合规闸门拒绝」
//   4. hot 客户                     → approveManual 放行后 confirmSend 真发成功（sendHook）
//   附加：归档 LeadEvent（remindIfNoLine 已提醒过 ⇒ action=archived）
// 断言：话术符合人设+画像+规则 / 频控拦截 / 合规拦截 / 归档 LeadEvent / 人工放行
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const { createStore } = require('../db/store.js');
const { createTalkEngine } = require('./talkEngine.js');

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const DB = path.join(os.tmpdir(), 'aisay-talkengine-test-' + process.pid + '.db');

function mkStore() {
  try { fs.unlinkSync(DB); } catch (e) {}
  return createStore({ dbPath: DB });
}

function makeContact(store, { displayName, nickname, platform = 'fb' }) {
  const contactId = sha1('weak/' + platform + '/win1/' + (nickname || displayName) + '|' + displayName);
  const nowIso = new Date().toISOString();
  store.db.prepare(
    'INSERT OR REPLACE INTO Contact (contactId,displayName,nickname,mergedInto,firstSeen,lastSeen,lifecycle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(contactId, displayName, nickname || displayName, null, nowIso, nowIso, 'active', nowIso, nowIso);
  store.db.prepare(
    'INSERT OR REPLACE INTO ContactProfile (contactId,age,region,height,occupation,language,intent,interests,historySummary,fields,confidence,source,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(contactId, '28', '東京', null, null, 'ja', 'serious', JSON.stringify(['会']), '', null, 0.8, 'chat', nowIso, nowIso);
  return contactId;
}

function makeRules({ blacklist = [], allowAll = false, rateLimit = null } = {}) {
  const rules = [];
  const nowIso = new Date().toISOString();
  if (blacklist.length) {
    rules.push({ ruleId: 'gr-blk-1', ruleType: 'compliance', scope: 'global', scopeKey: null,
      rule: JSON.stringify({ keywords: blacklist, deny: true }), priority: 100, status: 'active', createdAt: nowIso, updatedAt: nowIso });
  }
  if (allowAll) {
    rules.push({ ruleId: 'gr-allow-1', ruleType: 'compliance', scope: 'global', scopeKey: null,
      rule: JSON.stringify({ allow: true }), priority: 90, status: 'active', createdAt: nowIso, updatedAt: nowIso });
  }
  if (rateLimit) {
    rules.push({ ruleId: 'gr-rate-1', ruleType: 'rateLimit', scope: 'global', scopeKey: null,
      rule: JSON.stringify(rateLimit), priority: 80, status: 'active', createdAt: nowIso, updatedAt: nowIso });
  }
  return rules;
}

test('talkEngine: 4 类样例 + 归档', (t) => {
  const store = mkStore();

  const cWarm  = makeContact(store, { displayName: '田中', nickname: 'タナカ' });
  const cHot   = makeContact(store, { displayName: '热点', nickname: 'ホツ' });
  const cBlack = makeContact(store, { displayName: '他方', nickname: 'ソゴウ' });

  const persona = { accountId: 'acc-x', persona: 'サヤ', tone: '明るく親切', background: 'イベント案内' };
  const profileFor = (cid, name) => ({ contactId: cid, displayName: name, name, region: '東京', interest: '会', to: 'fb:' + name });

  let adapterOut = null;
  const engine = createTalkEngine({
    store,
    lineId: 'aisay.official',
    sendHook: (payload) => { adapterOut = payload; return { ok: true, via: 'adapter.send-mock' }; },
  });

  const ctxBase = { accountId: 'acc-x', category: 'ai_meeting', language: 'ja', platform: 'fb', accountPersona: persona };

  // 1. warm + 合规 allow ⇒ 生成话术含人设+画像（task-37：生成入待确认队列，不自动发；
  //    真发走 confirmSend，成功才调 sendHook（adapter.send 契约）+ 补记 sentLog/LeadEvent）
  t.test('warm + 合规（allow）⇒ 生成话术含画像变量，confirmSend 后经 adapter.send 发送', () => {
    const rules = makeRules({ allowAll: true });
    const out = engine.triggerGuide(Object.assign({}, ctxBase, {
      contactId: cWarm, tier: 'warm', score: 55,
      signals: [{ signal: 'priceInquiry' }],
      customerProfile: profileFor(cWarm, '田中'),
      governanceRules: { rules, denyByDefault: false },
    }));
    // task-37：triggerGuide 恒 sent=false + pending=true（生成入待确认队列，不自动发）
    assert.strictEqual(out.sent, false, 'task-37：triggerGuide 不自动发');
    assert.strictEqual(out.pending, true, '生成入待确认队列');
    assert.strictEqual(out.leadEvent.action, 'triggered', 'LeadEvent=triggered');
    assert.strictEqual(out.leadEvent.lineOffered, 0, 'pending 态 lineOffered=0（未确认发送）');
    assert.ok(out.queueEntry, '生成话术应入 pendingQueue');
    // 真发走 confirmSend：无 sendHook 失败时视为成功，才补记 sentLog + LeadEvent(lineOffered=1)
    adapterOut = null;
    const cs = engine.confirmSend({ accountId: ctxBase.accountId, contactId: cWarm });
    assert.strictEqual(cs.sent, true, 'confirmSend 成功（sendHook mock ok:true）');
    assert.ok(adapterOut, '真发应走 sendHook（adapter.send 契约）');
    assert.ok(adapterOut.text.includes('田中'), '话术应含客户名（画像变量填充）');
    assert.ok(adapterOut.text.includes('aisay.official'), '话术应含 LINE ID');
    const evts = store.db.prepare('SELECT action, lineOffered FROM LeadEvent WHERE contactId = ? ORDER BY rowid DESC LIMIT 1').get(cWarm);
    assert.strictEqual(evts.action, 'triggered', 'confirmSend 后最新 LeadEvent=triggered');
    assert.strictEqual(evts.lineOffered, 1, 'confirmSend 成功 lineOffered=1');
  });

  // 2. warm + 频控（同客户 24h 第 3 条）⇒ 拦截 + LeadEvent 落库
  t.test('命中频控（单客户 24h ≥2）⇒ 拦截 + LeadEvent 仍落库', () => {
    const rules = makeRules({ allowAll: true });
    // 24h 生成额度=2。样例 1 的 triggerGuide 记 1 条生成 + confirmSend 真发 1 条 = 共 2 条
    // 计入 24h 生成额度（task-31 口径：生成数含 confirmSend 真发）。本样例第 1 次
    // triggerGuide 时 perDay=2，已用尽额度 ⇒ 直接命中 24h≤2 频控拦截（实测 2026-10-06
    // task-4 诊断确认）。task-37 语义：triggerGuide 恒 sent=false + pending=true，
    // 区分拦截 vs 放行靠 reason（拦截才有 reason）。
    const second = engine.triggerGuide(Object.assign({}, ctxBase, {
      contactId: cWarm, tier: 'warm', score: 55,
      customerProfile: profileFor(cWarm, '田中'),
      governanceRules: { rules, denyByDefault: false },
    }));
    assert.strictEqual(second.sent, false, 'task-37：第 2 条恒 sent=false（不自动发）');
    assert.match(second.reason, /频控/, '第 2 条命中 24h≤2 频控拦截（样例 1 已用尽额度）');
    assert.strictEqual(second.leadEvent.action, 'triggered', '被拦截也写 LeadEvent（100%）');
    assert.strictEqual(second.leadEvent.lineOffered, 0, 'lineOffered=0');
    // 第 3 次触发同样命中频控（perDay=3 仍 ≥2），验证拦截的稳定性
    const third = engine.triggerGuide(Object.assign({}, ctxBase, {
      contactId: cWarm, tier: 'warm', score: 55,
      customerProfile: profileFor(cWarm, '田中'),
      governanceRules: { rules, denyByDefault: false },
    }));
    assert.strictEqual(third.sent, false, '第 3 条恒 sent=false（task-37 不自动发）');
    assert.match(third.reason, /频控/, '第 3 条仍命中频控（额度持续用尽）');
    assert.strictEqual(third.leadEvent.action, 'triggered', '被拦截也写 LeadEvent（100%）');
    assert.strictEqual(third.leadEvent.lineOffered, 0, 'lineOffered=0');
  });

  // 3. warm + 黑名单（compliance 命中）⇒ 拦截
  t.test('warm + 黑名单命中 ⇒ 拦截，reason 含合规拒绝', () => {
    const rules = makeRules({ blacklist: ['aisay.official'] });
    const out = engine.triggerGuide(Object.assign({}, ctxBase, {
      contactId: cBlack, tier: 'warm', score: 50,
      customerProfile: profileFor(cBlack, '他方'),
      governanceRules: { rules, denyByDefault: false },
      auto: true,
    }));
    assert.strictEqual(out.sent, false, '命中黑名单应拦截');
    assert.match(out.reason, /合规闸门拒绝/, 'reason 标明合规拒绝');
    assert.strictEqual(out.leadEvent.action, 'triggered', 'LeadEvent 仍落库');
  });

  // 4. hot + 人工闸门（auto 模式不自动发；approveManual 后放行）
  t.test('hot 客户：approveManual 人工放行 + confirmSend 真发（task-37 语义）', () => {
    const rules = makeRules({ allowAll: true });
    // task-37 后 triggerGuide 不再有「人工闸门拦截」分支（hot 也恒生成入待确认队列）；
    // 人工闸门的语义 = 该客户需 approveManual 放行后才允许 confirmSend 真发。
    const gen = engine.triggerGuide(Object.assign({}, ctxBase, {
      contactId: cHot, tier: 'hot', score: 90,
      customerProfile: profileFor(cHot, '热点'),
      governanceRules: { rules, denyByDefault: false },
    }));
    assert.strictEqual(gen.sent, false, 'task-37：hot 客户 triggerGuide 也不自动发');
    assert.strictEqual(gen.pending, true, '生成入待确认队列');
    assert.strictEqual(gen.leadEvent.action, 'triggered', 'LeadEvent 仍落库');
    // talk.needsManual：hot 且无 manualBypass ⇒ 需人工放行（buildTalks 输出标记）
    assert.strictEqual(gen.talk.needsManual, true, 'hot 客户 talk.needsManual=true（人工闸门标记）');

    const appr = engine.approveManual({ accountId: ctxBase.accountId, contactId: cHot });
    assert.strictEqual(appr.approved, true, '人工放行成功');

    adapterOut = null;
    const cs = engine.confirmSend({ accountId: ctxBase.accountId, contactId: cHot });
    assert.strictEqual(cs.sent, true, '人工放行后 confirmSend 真发成功（sendHook mock）');
    assert.ok(adapterOut, '真发应走 sendHook（adapter.send 契约）');
  });

  // 附加：归档 LeadEvent
  t.test('remindIfNoLine：已提醒过 ⇒ 直接归档（action=archived）', () => {
    const out = engine.remindIfNoLine(Object.assign({}, ctxBase, {
      contactId: cWarm, tier: 'warm', alreadyReminded: true,
      customerProfile: profileFor(cWarm, '田中'),
    }));
    assert.strictEqual(out.reminded, false, '不应重复提醒');
    assert.strictEqual(out.leadEvent.action, 'archived', '归档 LeadEvent');
  });

  // A/B 分流固定性
  t.test('A/B 分流固定性（同一客户永远同一组）', () => {
    const v1 = engine.variantOf(cWarm);
    const v2 = engine.variantOf(cWarm);
    assert.strictEqual(v1, v2, '同一客户分流固定');
    assert.ok(['A', 'B'].includes(v1));
    // 不同客户可能不同组
    const v3 = engine.variantOf(cHot);
    assert.ok(['A', 'B'].includes(v3));
  });
});

test('talkEngine: 模板匹配（会×日语×hot 样例）', () => {
  const store = mkStore();
  const engine = createTalkEngine({ store, lineId: 'aisay.official' });
  const persona = { persona: 'サヤ', tone: '明るく親切', background: 'イベント案内' };
  const talk = engine.buildTalks('ai_meeting', 'ja', 'hot', 'fb', persona,
    { contactId: 'c-x', name: '田中', region: '東京', interest: '会' },
    { rules: [], denyByDefault: false });
  assert.ok(talk.texts.guide.includes('田中'), '变量填充 {name}');
  assert.ok(talk.texts.guide.includes('aisay.official'), '变量填充 {lineId}');
  assert.strictEqual(talk.fallback, false, '应命中 templates/ai_meeting/ja.json');
  assert.ok(['A', 'B'].includes(talk.variant), 'A/B 变体');
});

test('talkEngine: 30min 未留 LINE 提醒（remind）', () => {
  const store = mkStore();
  const c = makeContact(store, { displayName: '提醒', nickname: 'レインド' });
  const persona = { persona: 'サヤ', tone: '親切' };
  const engine = createTalkEngine({ store, lineId: 'aisay.official',
    sendHook: () => ({ ok: true, via: 'mock' }) });
  const out = engine.remindIfNoLine({
    accountId: 'acc-x', contactId: c, tier: 'warm', alreadyReminded: false,
    category: 'ai_meeting', language: 'ja', platform: 'fb',
    accountPersona: persona, customerProfile: { contactId: c, name: '提醒' },
    governanceRules: { rules: [], denyByDefault: false },
  });
  assert.strictEqual(out.reminded, true, '未提醒过应发提醒');
  assert.strictEqual(out.leadEvent.action, 'reminded', 'LeadEvent=reminded');
});

test('cleanup', () => { try { fs.unlinkSync(DB); } catch (e) {} });
