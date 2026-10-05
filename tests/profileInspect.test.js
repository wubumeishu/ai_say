const test = require('node:test');
const assert = require('node:assert');
const { buildProfileInspect, controlPurpose, summarizeProfile, planPatch } = require('../server/profileInspector');
const { detectNextLevelPages } = require('../server/profileScan');

test('controlPurpose 返回控件用途说明', () => {
  assert.strictEqual(controlPurpose('select'), '选择器：可从选项里选择一个值。');
  assert.strictEqual(controlPurpose('textarea'), '多行文本：可填写较长说明。');
  assert.strictEqual(controlPurpose('input'), '输入框：可手动输入或修改值。');
  assert.strictEqual(controlPurpose('checkbox'), '复选项：可勾选或取消。');
  assert.ok(controlPurpose('unknown-type').length > 0);
});

test('buildProfileInspect 输出字段、下一级页面和页面特征', () => {
  const raw = {
    source: 'devtools-profile-scan',
    page: { url: 'https://example.com/profile', title: 'Profile', readyState: 'complete' },
    lines: ['a'],
    buttons: ['Save'],
    controls: [
      { tag: 'input', type: 'text', name: 'nickname', label: 'nickname', value: 'x', readonly: false, disabled: false },
      { tag: 'select', type: 'select', name: 'blood', label: 'blood', value: '', hasOptions: true, optionsText: 'A | B', readonly: false, disabled: false }
    ],
    sections: [{ title: 'basic' }],
    nextActions: [
      { label: 'next', url: 'https://example.com/detail', tag: 'a' },
      { label: 'next', url: 'https://example.com/detail', tag: 'a' },
      { url: 'https://example.com/photos' }
    ]
  };
  const out = buildProfileInspect(raw);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.fields.length, 2);
  assert.strictEqual(out.controls.length, 2);
  assert.strictEqual(out.pageFeatures.fieldCount, 2);
  assert.strictEqual(out.pageFeatures.nextLevelPageCount, 2);
  assert.strictEqual(out.fields[0].purpose, controlPurpose('input'));
  assert.strictEqual(out.fields[1].purpose, controlPurpose('select'));
  assert.strictEqual(out.unfilled.length, 1);
  assert.strictEqual(out.filled.length, 1);
  assert.strictEqual(out.nextLevelPages.length, 2);
});

test('buildProfileInspect 空输入返回空结构', () => {
  const out = buildProfileInspect({});
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.fields, []);
  assert.deepStrictEqual(out.nextLevelPages, []);
  assert.strictEqual(out.pageFeatures.fieldCount, 0);
});

test('detectNextLevelPages 与 inspect 保持一致的去重规则', () => {
  const raw = { nextActions: [
    { label: 'a', url: 'https://example.com/x' },
    { label: 'a', url: 'https://example.com/x' },
    { url: 'https://example.com/y' }
  ] };
  const fromDetect = detectNextLevelPages(raw);
  const fromInspect = buildProfileInspect(raw).nextLevelPages;
  assert.strictEqual(fromDetect.length, fromInspect.length);
  assert.strictEqual(fromInspect[0].url, 'https://example.com/x');
  assert.strictEqual(fromInspect[1].url, 'https://example.com/y');
});

test('summarizeProfile / planPatch 与 inspect 可组合使用', () => {
  const raw = {
    controls: [
      { tag: 'select', type: 'select', name: 'blood', label: 'blood', value: '', readonly: false, disabled: false }
    ]
  };
  const profile = summarizeProfile(raw);
  const plan = planPatch(profile, { blood: 'A型' });
  const inspect = buildProfileInspect(raw);
  assert.strictEqual(profile.fields.length, inspect.fields.length);
  assert.strictEqual(plan.executableCount, 1);
  assert.strictEqual(plan.safeToSubmit, true);
});

