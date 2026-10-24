// server/agents/registry.js · agent 注册表（总控 2026-10-25）
// 设计：把项目已实现的功能打包成可复用 agent，供内置 AI（assistant.js）发现/调用，也便于管理修改。
//
// 一个 agent = {
//   id: 'bbsQueryPosts',            // 唯一标识（LLM 工具 type 用它）
//   name: '查BBS帖子',               // 人类可读名
//   module: 'bbs',                  // 归属模块（bbs/mail/proxy/network...）
//   desc: '...',                    // 给 LLM 看的描述（进 prompt 工具清单）
//   sideEffect: 'none'|'weak'|'strong',  // 副作用等级（strong 永不直执，只出确认卡片）
//   params: [{name,type,desc,required}], // 参数 schema
//   endpoint: { method:'GET'|'POST', path:'/api/console/...', } // 映射到已有端点
//   needsConfirm: true,             // strong 副作用 agent 必须用户确认
//   buildPayload(p) {...},          // LLM 参数 → HTTP body 的映射（可选）
//   // 不直接写 execute()，统一走 agentExecutor 调 HTTP 端点（解耦 + 可单测 mock）
// }
//
// 管理：增删改 agent 只改本文件；assistant.js 的 TOOL_WHITELIST 从此表动态生成。

const AGENTS = [
  // ===== 模块 1 · 收件箱/消息 =====
  {
    id: 'getCustomer', name: '读客户画像', module: 'mail',
    desc: '读指定客户画像 + 最近消息摘要（只读）',
    sideEffect: 'none',
    params: [{ name: 'contactId', type: 'string', desc: '客户 ID', required: true }],
    endpoint: { method: 'GET', path: '/api/console/customers/:id' },
    needsConfirm: false
  },
  {
    id: 'listCustomers', name: '列客户', module: 'mail',
    desc: '列出/筛选客户（未读/在线/地区/年龄）',
    sideEffect: 'none',
    params: [{ name: 'filter', type: 'object', desc: '筛选条件（unread/online/region/age）', required: false }],
    endpoint: { method: 'GET', path: '/api/console/customers' },
    needsConfirm: false
  },
  {
    id: 'sendMessage', name: '发送消息', module: 'mail',
    desc: '向指定客户发送消息（强副作用，必须用户在动作卡片上确认后才执行，走 send-live）',
    sideEffect: 'strong',
    params: [
      { name: 'contactId', type: 'string', desc: '目标客户 ID', required: true },
      { name: 'text', type: 'string', desc: '消息正文（≤500 字）', required: true }
    ],
    endpoint: { method: 'POST', path: '/api/console/send-live' },
    buildPayload: function (p) { return { contactId: p.contactId, text: p.text, confirmed: true }; },
    needsConfirm: true
  },
  {
    id: 'fillDraft', name: '填入输入框', module: 'mail',
    desc: '把话术填入消息输入框（弱副作用，用户自行点发送，不自动发）',
    sideEffect: 'weak',
    params: [
      { name: 'contactId', type: 'string', desc: '目标客户 ID', required: true },
      { name: 'text', type: 'string', desc: '要填入的文本', required: true }
    ],
    endpoint: { method: 'POST', path: '/api/console/live/customer/refresh' },
    buildPayload: function (p) { return { contactId: p.contactId, text: p.text }; },
    needsConfirm: false
  },

  // ===== 模块 3 · BBS 帖子（动态/招募）=====
  {
    id: 'bbsQueryPosts', name: '查BBS帖子', module: 'bbs',
    desc: '查出会 BBS 招募/动态帖子列表（只读，按 genre/board 拉真实窗口帖子）',
    sideEffect: 'none',
    params: [
      { name: 'genre', type: 'number', desc: 'genreId（ピュア 1/3/4/5/6/17/19；大人 7/8/9/10/11/12/14/18/20）', required: false },
      { name: 'board', type: 'string', desc: "'pure'|'adult'，缺省 pure", required: false },
      { name: 'page', type: 'number', desc: '页码，缺省 1', required: false }
    ],
    endpoint: { method: 'GET', path: '/api/console/bbs/posts' },
    needsConfirm: false
  },
  {
    id: 'bbsEditPost', name: '改BBS帖', module: 'bbs',
    desc: '改出会 BBS 帖子标题/正文（强副作用，必须用户确认；只改指定 targetBbsId 那条，其他不动）',
    sideEffect: 'strong',
    params: [
      { name: 'targetBbsId', type: 'string', desc: '帖子 ID', required: true },
      { name: 'title', type: 'string', desc: '新标题（≤30 字，不传=保持原值）', required: false },
      { name: 'body', type: 'string', desc: '新正文（≤500 字，不传=保持原值）', required: false }
    ],
    endpoint: { method: 'POST', path: '/api/console/bbs/post/edit' },
    buildPayload: function (p) {
      var o = { targetBbsId: p.targetBbsId, confirmed: true };
      if (typeof p.title === 'string') o.title = p.title;
      if (typeof p.body === 'string') o.body = p.body;
      return o;
    },
    needsConfirm: true
  },
  {
    id: 'bbsDeletePost', name: '删BBS帖', module: 'bbs',
    desc: '删出会 BBS 帖子（强副作用、不可逆，必须用户确认 + 复述 targetBbsId；只删指定那条）',
    sideEffect: 'strong',
    params: [
      { name: 'targetBbsIds', type: 'array', desc: '要删的帖子 ID 数组（如 ["178898703"]）', required: true },
      { name: 'board', type: 'string', desc: "'pure'|'adult'，缺省 pure", required: false }
    ],
    endpoint: { method: 'POST', path: '/api/console/bbs/post/delete' },
    buildPayload: function (p) {
      var ids = Array.isArray(p.targetBbsIds) ? p.targetBbsIds : [p.targetBbsIds];
      return { targetBbsIds: ids, board: p.board || 'pure', confirmed: true };
    },
    needsConfirm: true
  },

  // ===== 拉黑/删除联系人 =====
  {
    id: 'blockContact', name: '拉黑客户', module: 'mail',
    desc: '拉黑/删除出会收件箱客户（强副作用、不可逆，必须用户确认 + 复述客户名）',
    sideEffect: 'strong',
    params: [
      { name: 'customerName', type: 'array', desc: '客户名数组（日文全名）', required: true }
    ],
    endpoint: { method: 'POST', path: '/api/console/batch' },
    buildPayload: function (p) {
      var names = Array.isArray(p.customerName) ? p.customerName : [p.customerName];
      return { action: 'blockContact', customerNames: names, confirmed: true };
    },
    needsConfirm: true
  },

  // ===== 网络/代理运维 =====
  {
    id: 'networkHealth', name: '网络体检', module: 'ops',
    desc: '查出口 IP/国家/延迟/平台连通/CDP 可用，归因网络/平台/CDP 问题（只读）',
    sideEffect: 'none',
    params: [],
    endpoint: { method: 'GET', path: '/api/console/network/health' },
    needsConfirm: false
  },
  {
    id: 'proxyRotate', name: '换IP', module: 'ops',
    desc: '换出口 IP（粘性代理池，弱副作用；先 dryRun 确认槽位再执行）',
    sideEffect: 'weak',
    params: [{ name: 'dryRun', type: 'boolean', desc: 'true=只查槽位不真换', required: false }],
    endpoint: { method: 'POST', path: '/api/console/proxy/rotate' },
    buildPayload: function (p) { return { dryRun: p.dryRun !== false }; },
    needsConfirm: false
  },
  {
    id: 'consoleHealth', name: '控制台健康', module: 'ops',
    desc: '查控制台服务健康状态（CDP 连接/缓存/数据库，只读）',
    sideEffect: 'none',
    params: [],

  },
  // ===== 补齐旧 9 工具（保持 LLM 已学命名 + 前端兼容）=====
  {
    id: 'translate', name: '翻译', module: 'mail',
    desc: '日<->中翻译（只读）',
    sideEffect: 'none',
    params: [{ name: 'text', type: 'string', desc: '要翻译的文本', required: true }],
    endpoint: { method: 'GET', path: '/api/console/translate' },
    needsConfirm: false
  },
  {
    id: 'generateReplies', name: '生成话术', module: 'mail',
    desc: '生成推荐话术（只生成，不发送）',
    sideEffect: 'none',
    params: [{ name: 'contactId', type: 'string', desc: '客户 ID', required: true }],
    endpoint: { method: 'GET', path: '/api/console/customers/:id' },
    needsConfirm: false
  },
  {
    id: 'markRead', name: '标记已读', module: 'mail',
    desc: '把指定客户会话标记已读（弱副作用）',
    sideEffect: 'weak',
    params: [{ name: 'contactId', type: 'string', desc: '客户 ID', required: true }],
    endpoint: { method: 'POST', path: '/api/console/live/customer/read' },
    buildPayload: function (p) { return { contactId: p.contactId }; },
    needsConfirm: false
  },
  {
    id: 'switchCustomer', name: '切客户', module: 'mail',
    desc: '控制台切到指定客户（弱副作用）',
    sideEffect: 'weak',
    params: [{ name: 'contactId', type: 'string', desc: '客户 ID', required: true }],
    endpoint: { method: 'GET', path: '/api/console/customers/:id' },
    needsConfirm: false
  },
  {
    id: 'searchCustomers', name: '搜客户', module: 'mail',
    desc: '按条件筛选客户（只读）',
    sideEffect: 'none',
    params: [{ name: 'filter', type: 'object', desc: '筛选条件', required: false }],
    endpoint: { method: 'GET', path: '/api/console/customers' },
    needsConfirm: false
  }
];

// 按 id 查
function getAgent(id) {
  for (var i = 0; i < AGENTS.length; i++) {
    if (AGENTS[i].id === id) return AGENTS[i];
    if (llmTypeOf(AGENTS[i]) === id) return AGENTS[i];
  }
  return null;
}
// 按副作用过滤（LLM 工具清单默认给 none+weak+strong，strong 标记需确认）
function listBySideEffect(level) {
  if (!level) return AGENTS;
  return AGENTS.filter(function (a) { return a.sideEffect === level; });
}
// 生成 LLM 工具清单（assistant.js TOOL_WHITELIST 动态源）
// llmType：LLM/前端可见的工具 type（向后兼容旧 snake_case 命名）；缺省用 agent id
function llmTypeOf(a) {
  var known = { get_customer:'getCustomer', list_customers:'listCustomers', send_message:'sendMessage',
    fill_draft:'fillDraft', bbs_query_posts:'bbsQueryPosts', bbs_edit_post:'bbsEditPost',
    bbs_delete_post:'bbsDeletePost', block_contact:'blockContact', network_health:'networkHealth',
    proxy_rotate:'proxyRotate', console_health:'consoleHealth', translate:'translate',
    generate_replies:'generateReplies', mark_read:'markRead', switch_customer:'switchCustomer',
    search_customers:'searchCustomers' };
  // agent.id → llmType 的映射反向查
  var idToType = {
    getCustomer:'get_customer', listCustomers:'list_customers', sendMessage:'send_message',
    fillDraft:'fill_draft', bbsQueryPosts:'bbs_query_posts', bbsEditPost:'bbs_edit_post',
    bbsDeletePost:'bbs_delete_post', blockContact:'block_contact', networkHealth:'network_health',
    proxyRotate:'proxy_rotate', consoleHealth:'console_health', translate:'translate',
    generateReplies:'generate_replies', markRead:'mark_read', switchCustomer:'switch_customer',
    searchCustomers:'search_customers'
  };
  return idToType[a.id] || a.id;
}
function toLlmToolList() {
  return AGENTS.map(function (a) {
    return {
      type: llmTypeOf(a),
      label: a.name,
      sideEffect: a.sideEffect,
      desc: a.desc,
      needsConfirm: a.needsConfirm,
      params: a.params
    };
  });
}

module.exports = { AGENTS: AGENTS, getAgent: getAgent, listBySideEffect: listBySideEffect, toLlmToolList: toLlmToolList, llmTypeOf: llmTypeOf };
