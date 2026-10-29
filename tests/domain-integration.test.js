// 模块4-8 · 全域运营前端集成测试（domain.js 导出 + renderUnifiedList 调用链）
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

test('domain.js: renderUnifiedList 导出存在', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'ichigo-assets', 'domain.js'), 'utf8');
  assert.ok(src.includes('export async function renderUnifiedList'), 'renderUnifiedList 应导出');
  assert.ok(src.includes('export function renderDomainPage'), 'renderDomainPage 应导出');
});

test('domain.js: renderUnifiedList 调用 /api/console/domain/rank + 构造 P1/P2/P4/P5/P6 候选', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'ichigo-assets', 'domain.js'), 'utf8');
  assert.ok(src.includes("/api/console/domain/rank"), '应调用排序路由');
  assert.ok(src.includes("cat: 'chat'"), '应构造 P1 chat 候选');
  assert.ok(src.includes("cat: 'like'"), '应构造 P2 like 候选');
  assert.ok(src.includes("cat: 'viewed'"), '应构造 P4 viewed 候选');
  assert.ok(src.includes("cat: 'browse'"), '应构造 P6 browse 候选');
  assert.ok(src.includes('/api/console/domain/chat'), '应调 /domain/chat');
  assert.ok(src.includes('/api/console/domain/like?tab='), 'P2 应调 3 tab');
  assert.ok(src.includes('likeTab'), 'P2 候选带 likeTab 标记');
  assert.ok(src.includes('/api/console/domain/ashiato?direction='), 'P4 应调 2 方向');
  assert.ok(src.includes('viewedDir'), 'P4 候选带 viewedDir 标记');
});

test('view.js: domain 视图分支存在', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'ichigo-assets', 'view.js'), 'utf8');
  assert.ok(src.includes('domain-ashiato'), 'domainViews 应含 domain-ashiato');
  assert.ok(src.includes('renderDomainPage'), '应 import renderDomainPage');
});

test('ichigo-console.html: 全域运营导航项存在', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'ichigo-console.html'), 'utf8');
  assert.ok(src.includes('data-view="domain-ashiato"'), '导航应含 足迹反撩');
  assert.ok(src.includes('data-view="domain-unified"'), '导航应含 统一待办');
  assert.ok(src.includes('id="domainPage"'), '应含 domainPage 容器');
});

test('consoleRoutes.js: /api/console/domain/rank 路由注册', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'consoleRoutes.js'), 'utf8');
  assert.ok(src.includes("'/api/console/domain/rank'"), 'rank 路由应注册');
  assert.ok(src.includes("require('./adapter/domainRank.js')"), '应 require domainRank');
});
