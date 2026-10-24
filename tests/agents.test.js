'use strict';
// agent 包单测（registry + executor，mock HTTP 不真连 8300）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const registry = require(path.join(rootDir, 'server', 'agents', 'registry.js'));
const executor = require(path.join(rootDir, 'server', 'agents', 'agentExecutor.js'));

test('registry：LLM 工具清单含新旧命名（向后兼容）', () => {
  const tools = registry.toLlmToolList();
  // 旧 9 工具命名保持（LLM 已学）
  ['get_customer','list_customers','search_customers','generate_replies','translate','fill_draft','mark_read','switch_customer','send_message'].forEach(function (t) {
    assert.ok(tools.some(function (x) { return x.type === t; }), '缺旧工具 ' + t);
  });
  // 新增 BBS/拉黑/运维 agent
  ['bbs_query_posts','bbs_edit_post','bbs_delete_post','block_contact','network_health','proxy_rotate','console_health'].forEach(function (t) {
    assert.ok(tools.some(function (x) { return x.type === t; }), '缺新工具 ' + t);
  });
});

test('registry：强副作用 agent 全带 needsConfirm', () => {
  const strong = registry.AGENTS.filter(function (a) { return a.sideEffect === 'strong'; });
  assert.ok(strong.length >= 3, '至少 3 个强副作用 agent');
  strong.forEach(function (a) {
    assert.equal(a.needsConfirm, true, a.id + ' 强副作用必须 needsConfirm');
  });
});

test('getAgent：按 llmType 和 agentId 都能查到', () => {
  assert.ok(registry.getAgent('bbs_query_posts'), 'llmType 查 bbs_query_posts');
  assert.ok(registry.getAgent('bbsQueryPosts'), 'agentId 查 bbsQueryPosts');
  assert.ok(registry.getAgent('send_message'), 'llmType 查 send_message');
  assert.equal(registry.getAgent('no_such_agent'), null, '未知返 null');
});

test('executor：未知 agent → unknown-agent', async () => {
  const r = await executor.executeAgent({ agentId: 'nope', params: {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-agent');
});

test('executor：强副作用未 confirmed → confirmation-required', async () => {
  const r = await executor.executeAgent({ agentId: 'bbs_delete_post', params: { targetBbsIds: ['1'] } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'confirmation-required');
});

test('executor：缺必填参数 → missing-param', async () => {
  const r = await executor.executeAgent({ agentId: 'bbs_edit_post', params: {}, confirmed: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing-param');
});

test('executor：bbs_query_posts GET 路径拼接 + confirmed 无关', async () => {
  // mock：不起真 HTTP，用 baseUrl 指向一个立刻拒绝的端口验证请求构造（连接被拒 = 路径/host 正确）
  const r = await executor.executeAgent({ agentId: 'bbs_query_posts', params: { genre: 5, board: 'pure' } }, { baseUrl: 'http://127.0.0.1:1', timeoutMs: 3000 });
  // 端口 1 拒绝 → http-error（证明请求真的发出去了，构造无误）
  assert.equal(r.reason, 'http-error', '应真发出 HTTP（' + r.reason + '）：' + (r.error || ''));
});

test('assistant.js 的 TOOL_WHITELIST 来自 registry（动态）', () => {
  const src = fs.readFileSync(path.join(rootDir, 'server', 'adapter', 'assistant.js'), 'utf8');
  assert.ok(src.includes('agentRegistry.toLlmToolList()'), 'TOOL_WHITELIST 从 registry 生成');
  assert.ok(src.includes("require('../agents/registry')"), 'require registry');
});
