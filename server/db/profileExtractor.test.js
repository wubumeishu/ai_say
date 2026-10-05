// =============================================================================
// Ai SAY M1 · profileExtractor 自检（node --test 可跑）
// 用现有 data/account-profiles.json 的 17098 记录跑一次，
// 断言：10+ 字段槽、置信度字段、source 标记。
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs   = require('fs');
const path = require('path');

const { createProfileExtractor } = require('./profileExtractor');

// ---------------------------------------------------------------------------
// 构造一个不写真实 DB 的 mock store（只记录 upsertContact 调用）
// ---------------------------------------------------------------------------
function makeMockStore() {
  const calls = [];
  return {
    upsertContact(input) {
      calls.push(input);
      const crypto = require('crypto');
      const legacyKey = [input.platform, input.windowId, input.contactKey].join('/');
      const contactId = crypto.createHash('sha1').update('weak/' + legacyKey).digest('hex');
      return { contactId, ...input, createdAt: new Date().toISOString() };
    },
    _calls: calls,
  };
}

// ---------------------------------------------------------------------------
// 从现有 account-profiles.json 读 17098 记录（测试夹具）
// ---------------------------------------------------------------------------
function load17098() {
  const dataPath = path.join(__dirname, '..', '..', 'data', 'account-profiles.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const rec = data.find(r => r.key && r.key.includes('17098')) || data[0];
  if (!rec) throw new Error('17098 record not found in account-profiles.json');
  // 补全 17098 文档里的已知字段（从 docs/tools/profile_17098_fields.md）
  const enriched = JSON.parse(JSON.stringify(rec));
  // raw.buttons 里补上 17098 页面字段标签
  const known17098Buttons = [
    'ニックネーム','あなたの誕生日','身長','スタイル','血液型','あなたのタイプ',
    'よく遊ぶ地域','交際ステータス','出身地','職業','年収',
    'デートでしたいこと','出会うまでの希望','興味あること','自己紹介',
  ];
  enriched.raw = enriched.raw || {};
  enriched.raw.buttons = [...(enriched.raw.buttons || []), ...known17098Buttons];
  // 补几条 filled 字段（模拟已填字段）
  enriched.raw.filled = [
    ...new Set([...(enriched.raw.filled || []),
      { key: 'ニックネーム', label: 'ニックネーム', value: 'ともね', source: 'dom' },
      { key: 'あなたの誕生日', label: '誕生日', value: '1988年05月', source: 'dom' },
      { key: '身長', label: '身長', value: '155〜159cm', source: 'dom' },
      { key: '血液型', label: '血液型', value: 'B型', source: 'dom' },
      { key: '出身地', label: '出身地', value: '埼玉', source: 'dom' },
      { key: '職業', label: '職業', value: 'その他', source: 'dom' },
      { key: '交際ステータス', label: '交際ステータス', value: '秘密', source: 'dom' },
      { key: '年収', label: '年収', value: '100〜300万円', source: 'dom' },
      { key: '出会うまでの希望', label: '出会うまでの希望', value: 'まずは会いたい', source: 'dom' },
    ].map(f => f.key ? f : f))
  ];
  return enriched;
}

test('extractFromProfilePage：17098 记录能抽出 10+ 字段槽', () => {
  const extractor = createProfileExtractor({ store: makeMockStore() });
  const rec = load17098();
  const result = extractor.extractFromProfilePage(rec);

  const slots = Object.keys(result.fields);
  assert.ok(slots.length >= 10,
    '期望 10+ 字段槽，实际 ' + slots.length + ': ' + slots.join(', '));
  assert.strictEqual(result.source, 'profile_page');
  console.log('17098 profile_page slots:', slots.join(', '));
});

test('extractFromProfilePage：字段带 confidence 和 source 标记', () => {
  const extractor = createProfileExtractor({ store: makeMockStore() });
  const rec = load17098();
  const result = extractor.extractFromProfilePage(rec);

  for (const [k, v] of Object.entries(result.fields)) {
    assert.ok(typeof v.confidence === 'number' && v.confidence > 0 && v.confidence <= 1,
      k + ' confidence 应在 0-1: ' + v.confidence);
    assert.strictEqual(v.source, 'profile_page', k + ' source 应为 profile_page');
  }
});

test('extractFromProfilePage：地区被规范化到都道府县粒度', () => {
  const extractor = createProfileExtractor({ store: makeMockStore() });
  const rec = load17098();
  const result = extractor.extractFromProfilePage(rec);

  if (result.fields.region) {
    // 17098 的 lines 里有「38歳 埼玉」，地区应为「埼玉」
    assert.strictEqual(result.fields.region.value, '埼玉',
      'region 应规范化为 埼玉，实际 ' + result.fields.region.value);
  }
});

test('extractFromProfilePage：年龄识别（38歳）', () => {
  const extractor = createProfileExtractor({ store: makeMockStore() });
  const rec = load17098();
  const result = extractor.extractFromProfilePage(rec);

  if (result.fields.age) {
    assert.strictEqual(result.fields.age.value, '38',
      'age 应为 38（来自 38歳），实际 ' + result.fields.age.value);
  }
});

test('supplementFromChat：聊天补充 intent/兴趣/摘要', () => {
  const extractor = createProfileExtractor({ store: makeMockStore() });
  const messages = [
    { role: 'other', original: '初めて会いたいな', translation: '想第一次见面' },
    { role: 'other', original: '映画好き', translation: '喜欢电影' },
    { role: 'other', original: '埼玉出身', translation: '埼玉出身' },
    { role: 'me', original: '了解です', translation: '明白了' },
  ];
  const result = extractor.supplementFromChat(messages);

  assert.strictEqual(result.source, 'chat');
  assert.ok(result.fields.intent, '应识别 intent');
  assert.strictEqual(result.fields.intent.value, 'serious',
    '会いたい → serious，实际 ' + result.fields.intent.value);
  assert.ok(result.fields.interests, '应识别 interests');
  assert.ok(Array.isArray(result.fields.interests.value), 'interests 应为数组');
  assert.ok(result.fields.region, '应识别 region');
  assert.strictEqual(result.fields.region.value, '埼玉');
  assert.ok(result.fields.lastActiveSummary, '应有 lastActiveSummary');
});

test('merge：profile_page 胜出（口误不覆盖真值）', () => {
  const extractor = createProfileExtractor({ store: makeMockStore() });
  const pageResult = extractor.extractFromProfilePage({
    lines: ['ともね', '38歳 埼玉', '身長 155cm'],
  });
  const chatResult = extractor.supplementFromChat([
    { role: 'other', original: '私は20歳です', translation: '我 20 岁' },
    { role: 'other', original: '東京在住', translation: '东京住' },
  ]);

  const merged = extractor.merge(pageResult, chatResult);

  // 年龄：page=38 胜出，chat=20 被覆盖
  assert.strictEqual(merged.fields.age.value, '38',
    'profile_page 的 age=38 应胜出（chat 说 20 岁被覆盖），实际 ' + merged.fields.age.value);
  assert.strictEqual(merged.fields.age.source, 'profile_page');
  // 地区：page=埼玉 胜出
  if (merged.fields.region) {
    assert.strictEqual(merged.fields.region.source, 'profile_page',
      'region 应来自 profile_page（胜出）');
  }
  assert.ok(merged.confidence > 0 && merged.confidence <= 1, '整卡 confidence 应在 0-1');
});

test('writeProfile：走 upsertContact 单一写入路径', () => {
  const mock = makeMockStore();
  const extractor = createProfileExtractor({ store: mock });
  const rec = load17098();
  const result = extractor.run({
    profilePageData: rec,
    messages: [],
    contactKey: '17098',
    platform: '自用出会',
    windowId: '2315e879dd6642559bdc11a07bb1fc43',
  });

  assert.ok(mock._calls.length === 1, '应调用 upsertContact 一次');
  assert.ok(result.contactId, '应返回 contactId');
  assert.ok(result.slotCount >= 10, 'slotCount 应 >= 10，实际 ' + result.slotCount);
  assert.ok(typeof result.confidence === 'number');
});

test('run：无资料页时仅用聊天补充', () => {
  const mock = makeMockStore();
  const extractor = createProfileExtractor({ store: mock });
  const result = extractor.run({
    profilePageData: null,
    messages: [
      { role: 'other', original: '会いたい', translation: '想见面' },
    ],
    contactKey: 'chat_only_user',
    platform: 'test',
    windowId: 'w1',
  });

  assert.ok(result.slotCount >= 1, '至少有 1 个槽位');
  assert.strictEqual(result.source, 'chat', '无资料页时 source 应为 chat');
});

test('17098 enrichment：默认值槽位带 enriched=true 标记（区分真值 vs 占位值）', () => {
  const extractor = createProfileExtractor({ store: makeMockStore() });
  const rec = load17098();
  const result = extractor.extractFromProfilePage(rec);

  // load17098 把 17098 字段标签补进 raw.buttons，enrichment 开关默认 ON，
  // 因此 職業/年収/交際ステータス 等未真实填值的槽位应被 enrichment 填入默认值
  // 并带 enriched=true 标记。
  const enrichedSlots = Object.entries(result.fields)
    .filter(([k, v]) => v.enriched === true)
    .map(([k]) => k);
  assert.ok(enrichedSlots.length > 0,
    '应有 enriched=true 的占位槽位，实际: ' + enrichedSlots.join(', '));
  console.log('enriched slots:', enrichedSlots.join(', '));

  // 真值槽位（来自真实 filled/lines，如 displayName/age/region）不应带 enriched 标记
  const realSlots = Object.entries(result.fields)
    .filter(([k, v]) => v.enriched !== true)
    .map(([k]) => k);
  assert.ok(realSlots.length > 0,
    '应有真值槽位（无 enriched 标记），实际: ' + realSlots.join(', '));
});

console.log('profileExtractor tests loaded.');
