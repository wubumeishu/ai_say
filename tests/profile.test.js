const test = require('node:test');
const assert = require('node:assert');
const { createApp, looksLikeProfileUrl } = require('../server/app');
const {
  summarizeProfile,
  planPatch,
  inferStatusLabel,
  isUnfilled,
  normalizeText,
  normalizeLines
} = require('../server/profileInspector');
const {
  buildProfileScanJs,
  buildNavigateProfileJs,
  detectProfilePage,
  detectNextLevelPages,
  parseBottomNav
} = require('../server/profileScan');

test('looksLikeProfileUrl 识别资料页 URL', () => {
  assert.strictEqual(looksLikeProfileUrl('https://sp.194964.com/sns/snsmypage/show_profile.html'), true);
  assert.strictEqual(looksLikeProfileUrl('https://example.com/mypage'), true);
  assert.strictEqual(looksLikeProfileUrl('https://example.com/mail/inbox'), false);
});

test('looksLikeProfileUrl 支持自定义关键词', () => {
  assert.strictEqual(looksLikeProfileUrl('https://example.com/account-edit', ['account-edit']), true);
  assert.strictEqual(looksLikeProfileUrl('https://example.com/other', ['account-edit']), false);
});

test('normalizeText 压缩空白', () => {
  assert.strictEqual(normalizeText('  a   b \n c '), 'a b c');
});

test('normalizeLines 过滤空行', () => {
  assert.deepStrictEqual(normalizeLines([' a', '', ' b ', null, ' c ']), ['a', 'b', 'c']);
});

test('isUnfilled 识别常见未填写文案', () => {
  assert.strictEqual(isUnfilled(''), true);
  assert.strictEqual(isUnfilled('未入力です'), true);
  assert.strictEqual(isUnfilled('未設定'), true);
  assert.strictEqual(isUnfilled('ともね'), false);
});

test('inferStatusLabel 输出中文状态', () => {
  assert.strictEqual(inferStatusLabel('未設定'), '未填写');
  assert.strictEqual(inferStatusLabel('B型'), '已填写');
});

test('summarizeProfile 输出字段 / 未填写 / 已填写 列表', () => {
  const profile = summarizeProfile({
    source: 'devtools-profile-scan',
    page: { url: 'https://example.com/profile', title: 'Profile', readyState: 'complete' },
    lines: ['a', '', 'b'],
    buttons: ['Save'],
    controls: [
      { tag: 'input', type: 'text', name: 'nickname', id: 'nickname', label: 'ニックネーム', group: '基本', value: 'ともね', readonly: false, disabled: false },
      { tag: 'select', type: 'select', name: 'blood', id: 'blood', label: '血液型', group: '基本', value: '', hasOptions: true, optionsText: 'A型 | B型', readonly: false, disabled: false }
    ],
    sections: [{ title: '基本プロフィール' }],
    nextActions: [{ label: '設定する', url: 'https://example.com/profile/edit', tag: 'a' }]
  });
  assert.strictEqual(profile.ok, true);
  assert.strictEqual(profile.fields.length, 2);
  assert.strictEqual(profile.filled.length, 1);
  assert.strictEqual(profile.unfilled.length, 1);
  assert.strictEqual(profile.unfilled[0].label, '血液型');
  assert.strictEqual(profile.lines.length, 2);
  assert.strictEqual(profile.buttons[0], 'Save');
  assert.strictEqual(profile.nextActions.length, 1);
  assert.strictEqual(profile.nextActions[0].url, 'https://example.com/profile/edit');
});

test('summarizeProfile 空输入返回空结构', () => {
  const profile = summarizeProfile({});
  assert.strictEqual(profile.ok, true);
  assert.deepStrictEqual(profile.fields, []);
  assert.deepStrictEqual(profile.unfilled, []);
});

test('planPatch 命中字段并标记可执行', () => {
  const profile = {
    fields: [
      { key: 'blood', label: '血液型', name: 'blood', value: '', controlType: 'select', editable: true, readonly: false, options: [{ value: 'a', label: 'A型' }] },
      { key: 'intro', label: '自己紹介', name: 'intro', value: '', controlType: 'textarea', editable: true, readonly: false }
    ]
  };
  const plan = planPatch(profile, { blood: 'A型' });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.total, 1);
  assert.strictEqual(plan.executableCount, 1);
  assert.strictEqual(plan.safeToSubmit, true);
  assert.strictEqual(plan.changes[0].to, 'A型');
});

test('planPatch 未知字段计入 unknownKeys', () => {
  const profile = { fields: [{ key: 'blood', label: '血液型', value: 'B型', controlType: 'select', editable: true, readonly: false }] };
  const plan = planPatch(profile, { blood: 'A型', missing: 'x' });
  assert.deepStrictEqual(plan.unknownKeys, ['missing']);
  assert.strictEqual(plan.safeToSubmit, false);
});

test('planPatch 只读字段计入仅预览', () => {
  const profile = { fields: [{ key: 'uid', label: '用户ID', value: '123', controlType: 'text', editable: false, readonly: true }] };
  const plan = planPatch(profile, { uid: '999' });
  assert.strictEqual(plan.previewCount, 1);
  assert.strictEqual(plan.executableCount, 0);
  assert.strictEqual(plan.safeToSubmit, false);
  assert.ok(plan.warnings.length >= 1);
});

test('buildProfileScanJs 生成可执行的 IIFE 脚本', () => {
  const js = buildProfileScanJs();
  assert.ok(js.includes('devtools-profile-scan'));
  assert.ok(js.includes('controls'));
  assert.ok(js.includes('nextActions'));
  new Function(js);
});

test('buildNavigateProfileJs 生成可执行的跳转脚本', () => {
  const js = buildNavigateProfileJs(['show_profile', 'マイページ']);
  assert.ok(js.includes('show_profile'));
  new Function(js);
});

test('detectProfilePage 依据 URL / 控件 / 按钮综合判断', () => {
  const likely = detectProfilePage({
    page: { url: 'https://example.com/mypage/show_profile.html' },
    sections: [{ title: '基本プロフィール' }],
    controls: [{ label: '血液型', optionsText: 'A型 | B型' }],
    nextActions: [{ label: '設定する' }]
  });
  assert.strictEqual(likely.isLikelyProfile, true);
  assert.ok(likely.score >= 2);

  const unlikely = detectProfilePage({ page: { url: 'https://example.com/mail/inbox' } });
  assert.strictEqual(unlikely.isLikelyProfile, false);
});

test('detectNextLevelPages 去重并保留入口', () => {
  const pages = detectNextLevelPages({
    nextActions: [
      { label: '基本プロフィール 設定する', url: 'https://example.com/basic' },
      { label: '基本プロフィール 設定する', url: 'https://example.com/basic' },
      { label: '詳細 設定する', url: 'https://example.com/detail' },
      { url: 'https://example.com/photos' }
    ]
  });
  assert.strictEqual(pages.length, 3);
  assert.strictEqual(pages[0].url, 'https://example.com/basic');
});

test('createApp 暴露资料页路由所需的工具函数', () => {
  assert.strictEqual(typeof createApp, 'function');
  assert.strictEqual(typeof looksLikeProfileUrl, 'function');
});

test('parseBottomNav 识别底部导航与未读角标', () => {
  const nav = parseBottomNav({
    bottomNav: [
      { label: '\u304a\u5f79\u624b\u5b88\u3057', url: 'https://sp.example.com/sns/search/' },
      { label: '\u52df\u96c6', url: 'https://sp.example.com/sns/recruit/' },
      { label: '\u30e1\u30c3\u30bb\u30fc\u30b8', badge: '2', url: 'https://sp.example.com/sns/message/' },
      { label: '\u30bf\u30a4\u30d5', badge: '99', url: 'https://sp.example.com/sns/snstype/show_typed_list.html' },
      { label: '\u30de\u30a4\u30da\u30fc\u30b8', url: 'https://sp.example.com/sns/mypage/' }
    ]
  });
  assert.strictEqual(nav.length, 5);
  assert.strictEqual(nav.messageCount, 2);
  assert.strictEqual(nav.likeCount, 99);
  const msg = nav.find((x) => x.label === '\u30e1\u30c3\u30bb\u30fc\u30b8');
  assert.ok(msg, 'message item found');
  assert.strictEqual(msg.badge, 2);
  const like = nav.find((x) => /typed|snstype/i.test(x.url));
  assert.ok(like, 'like item found');
  assert.strictEqual(like.badge, 99);
});

test('parseBottomNav 空输入返回空结构', () => {
  const nav = parseBottomNav({});
  assert.strictEqual(nav.length, 0);
  assert.strictEqual(nav.messageCount, 0);
  assert.strictEqual(nav.likeCount, 0);
});
