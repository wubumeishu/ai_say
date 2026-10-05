const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');
const {
  COMMON_PHRASES,
  buildRecommendation,
  detectLanguage,
  translateToChinese,
  myMemoryTranslate
} = require('../server/translator');

test('detectLanguage 识别中文', () => {
  assert.strictEqual(detectLanguage('你好'), 'zh');
});

test('detectLanguage 识别外语', () => {
  assert.strictEqual(detectLanguage('hello world'), 'foreign');
});

test('translateToChinese 对中文原文直接透传', async () => {
  const out = await translateToChinese('你好，想问一下价格', {});
  assert.strictEqual(out.source, 'passthrough');
  assert.strictEqual(out.text, '你好，想问一下价格');
});

test('translateToChinese 空输入', async () => {
  const out = await translateToChinese('   ', {});
  assert.strictEqual(out.source, 'empty');
  assert.strictEqual(out.text, '');
});

test('translateToChinese 调用翻译引擎（网络可用时）', async () => {
  // 网络可达时，MyMemory 会返回中文；不可达则回退到占位
  const out = await translateToChinese('hello', {});
  assert.ok(['engine', 'fallback'].includes(out.source));
  assert.ok(out.text.length > 0);
});

test('buildRecommendation 命中价格关键词', () => {
  const r = buildRecommendation({ text: 'how much is it?' }, {});
  assert.ok(r.message.includes('价格'));
});

test('buildRecommendation 命中问候关键词', () => {
  const r = buildRecommendation({ text: 'hello' }, {});
  assert.ok(r.message.includes('您好'));
});

test('buildRecommendation 通用兜底', () => {
  const r = buildRecommendation({ text: 'xyz abc' }, {});
  assert.ok(r.message.length > 0);
});

test('buildRecommendation 带客户名', () => {
  const r = buildRecommendation({ text: 'hello' }, { customerName: 'Alice' });
  assert.ok(r.message.startsWith('您好 Alice'));
});

test('常用语列表非空', () => {
  assert.ok(Array.isArray(COMMON_PHRASES) && COMMON_PHRASES.length >= 4);
});

test('createApp 返回路由函数', () => {
  const app = createApp();
  assert.strictEqual(typeof app, 'function');
});

test('myMemoryTranslate 导出为函数', () => {
  assert.strictEqual(typeof myMemoryTranslate, 'function');
});