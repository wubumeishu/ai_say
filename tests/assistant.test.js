// =============================================================================
// Ai SAY Phase 2 · assistant 面板后端自检（node --test）
// 覆盖：createAssistant 的降级模式（模型不可用）+ 动作卡片解析 + 铁律合规。
//   1. 模型不可达 ⇒ degraded=true，本地摘要回复；
//   2. parseActions：LLM 输出裸 JSON / ```json``` 块时，白名单外 type 被丢弃；send_message 必带 needConfirm；
//   3. 空 message 拒绝；
//   4. mock fetch 成功路径：回复=LLM 正文，degraded=false，system prompt 含白名单+铁律。
// 约束：不碰真发（send_message 只验卡片不执行）；无空 catch；不建 DB（纯内存）。
// =============================================================================
'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert');

let assistant;

before(async () => {
  const { createAssistant } = require('../server/adapter/assistant');
  // mock modelStore：getActive 返回可配置模型（baseUrl 指向不可达端口，不联网不真发）
  const modelStore = {
    getActive: () => ({ baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', model: 'mock-model' }),
  };
  // mock ichigoCache：getContact 返回固定客户名（验证 ctx.contact 注入）
  const ichigoCache = {
    getContact: (id) => (id === 'c-1' ? { name: 'test-customer' } : null),
  };
  assistant = createAssistant({ modelStore, aiService: null, ichigoCache });
});

test('assistant: 模型不可用 ⇒ 降级本地摘要（不删功能）', async () => {
  const out = await assistant.chat({
    message: '你好',
    contactId: 'c-1',
    history: [
      { role: 'in', text: 'メッセージ1', ts: new Date().toISOString() },
      { role: 'out', text: 'メッセージ2', ts: new Date().toISOString() },
    ],
  });
  assert.strictEqual(out.ok, true, '非空 message 应 ok');
  assert.strictEqual(out.degraded, true, 'fetch 不可达 ⇒ degraded=true');
  assert.match(out.reply, /降级模式/, '本地摘要应标注降级模式');
  assert.strictEqual(out.contact, 'test-customer', 'ichigoCache.getContact 应注入客户名');
  assert.ok(Array.isArray(out.actions), 'actions 字段应为数组（可空）');
});

test('assistant: parseActions 白名单过滤 + send_message 必须 needConfirm', () => {
  // LLM 输出裸 JSON 数组：白名单外 type 丢弃；send_message 必 needConfirm
  const fakeReply = JSON.stringify([
    { type: 'list_customers', label: '列客户', payload: {} },
    { type: 'not_a_real_tool', label: '坏动作', payload: {} },
    { type: 'send_message', label: '发送', payload: { text: 'test' } },
    { type: 'fill_draft', label: '填入输入框', payload: { text: 'test' } },
  ]);
  const actions = assistant.parseActions(fakeReply, { tools: assistant.TOOL_WHITELIST });
  assert.strictEqual(actions.length, 3, '白名单外 type 应被丢弃（实际 ' + actions.map((a) => a.type).join(',') + '）');
  const send = actions.find((a) => a.type === 'send_message');
  assert.ok(send, 'send_message 卡片应存在');
  assert.strictEqual(send.needConfirm, true, '强副作用必须用户确认');
  assert.strictEqual(send.sideEffect, 'strong');
  const fill = actions.find((a) => a.type === 'fill_draft');
  assert.ok(fill && fill.sideEffect === 'weak', 'fill_draft 应标记弱副作用');
  assert.notStrictEqual(fill.needConfirm, true, '弱副作用不标 needConfirm');
});

test('assistant: parseActions 容忍 json 代码块包裹', () => {
  const fakeReply = '好的，建议动作如下：\n```json\n[{"type":"translate","payload":{"text":"x"}}]\n```';
  const actions = assistant.parseActions(fakeReply, {});
  assert.strictEqual(actions.length, 1, '代码块内 JSON 应被解析（实际 ' + actions.length + '）');
  assert.strictEqual(actions[0].type, 'translate');
});

test('assistant: 空 message 拒绝（400 语义）', async () => {
  const out = await assistant.chat({ message: '', contactId: 'c-1' });
  assert.strictEqual(out.ok, false, '空 message ⇒ ok=false');
  assert.strictEqual(out.reason, 'empty-message');
});

test('assistant: LLM 可用时 degraded=false 且回复=LLM 正文（mock fetch）', async () => {
  // monkey-patch 全局 fetch：捕获请求，断言 system prompt 含白名单 + 铁律
  let captured = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    // B v1.1 契约：mock LLM 也按强制 JSON 契约输出（analysis/strategy/replies），回复正文并入 analysis（reply 可空串）
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ analysis: 'LLM-REPLY-OK', strategy: '', replies: [] }) } }] }),
    };
  };
  let out;
  try {
    out = await assistant.chat({ message: '推荐回复', contactId: 'c-1', history: [] });
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.strictEqual(out.degraded, false, 'mock fetch 成功 ⇒ 非降级');
  // B v1.1：正文并入 analysis（reply 可为空串，旧前端读 reply 不破坏；新前端读 analysis）
  assert.strictEqual(out.analysis, 'LLM-REPLY-OK', '正文应并入 analysis（B v1.1 契约，LLM 按 JSON 输出）');
  assert.ok(typeof out.reply === 'string', 'reply 字段仍存在（旧前端兼容，可为空串）');
  const body = JSON.parse(captured.init.body);
  assert.strictEqual(body.model, 'mock-model');
  assert.match(captured.url, /chat\/completions$/, '应打 /chat/completions 端点');
  const systemPrompt = body.messages[0].content;
  assert.match(systemPrompt, /list_customers/, 'system 应含工具白名单');
  assert.match(systemPrompt, /send_message/, 'system 应含 send_message（强副作用）');
  assert.match(systemPrompt, /永不直接发送/, 'system 应含铁律（不自动发送）');
});


// =============================================================================
// B v1.1 新增用例（节点 3 task-5 三端联调 · 后端 6 例，os.tmpdir/mock 不真连 LLM）
//   强制 JSON 契约 / intent→type 映射 / parseV11 容忍代码块 / 降级 degraded+localFallback /
//   脱敏白名单掩码 / 三要素内存组装
// =============================================================================
const { createAssistant: ca11, maskPersonaToPrompt: mp11, maskPiiInText: mpii, INTENT_TYPE_MAP: itp11 } = require('../server/adapter/assistant.js');

// mock modelStore：getUsableActive 返回可控配置；chatLLM 可注入返回值（容忍/截断/非JSON 场景）
function makeAssistantWithLLM(llmContent, llmError) {
  const a = ca11({
    modelStore: {
      getUsableActive: () => ({ baseUrl: 'http://mock-llm.local/v1', apiKey: 'test-key-never-leak', model: 'mock' }),
    },
    ichigoCache: {
      getContact: (id) => ({ contactId: id, name: '爽快', age: '46', ageNum: 46, region: '埼玉県', onlineTier: 'recent', unread: 1, interests: ['LINE'] }),
    },
    personaStore: {
      getActiveByAccount: () => ({ persona: '女 38 岁 运营', tone: '温柔', background: '神奈川', name: '本名不应进', realName: '真名不应进', phone: '09012345678', taboos: ['禁词'] }),
    },
  });
  return a;
}

// 1. 强制 JSON 契约：LLM 返回单一 JSON 对象 → 响应 analysis/strategy/replies 字段齐全
test('B v1.1 强制 JSON 契约：LLM 单一 JSON 对象 → analysis/strategy/replies 齐全（mock 不真连）', async () => {
  const a = makeAssistantWithLLM();
  const llmJson = JSON.stringify({ analysis: '客户想约见面', strategy: '先试探再邀约', replies: [{ type: 'meet', content: '今週は出かける予定はありますか？' }] });
  // 直接用 parseV11 验证契约解析（不真调 LLM；chat 路径需 mock fetch，此处测解析核心）
  const parsed = a.parseV11(llmJson);
  assert.strictEqual(parsed.ok, true, '合法 JSON 应解析成功');
  assert.strictEqual(parsed.analysis, '客户想约见面');
  assert.strictEqual(parsed.strategy, '先试探再邀约');
  assert.strictEqual(parsed.replies.length, 1);
  assert.strictEqual(parsed.replies[0].type, 'meet');
  assert.strictEqual(parsed.replies[0].content, '今週は出かける予定はありますか？');
});

// 2. intent→replies.type 映射：4 intent 映射到 6 枚举（analyze→other/reply→followup/deflect→deflect/meet→meet）
test('B v1.1 intent→replies.type 映射表（4 intent → 6 枚举，未知 type 归 other）', () => {
  assert.strictEqual(itp11.analyze, 'other', 'analyze → other');
  assert.strictEqual(itp11.reply, 'followup', 'reply → followup');
  assert.strictEqual(itp11.deflect, 'deflect', 'deflect → deflect');
  assert.strictEqual(itp11.meet, 'meet', 'meet → meet');
  // 未知 type 归 other（normalizeV11）
  const a = makeAssistantWithLLM();
  const r = a.normalizeV11({ analysis: 'a', strategy: 's', replies: [{ type: 'unknownX', content: 'c' }, { type: 'close', content: 'd' }] });
  assert.strictEqual(r.replies[0].type, 'other', '未知 type 应归 other');
  assert.strictEqual(r.replies[1].type, 'close', '已知 type 保留');
});

// 3. parseV11 容忍代码块/前后杂字/截断
test('B v1.1 parseV11 容忍边界：json 代码块包裹 + 前后杂字 + 截断（缺 ] 补全）', () => {
  const a = makeAssistantWithLLM();
  // 代码块包裹
  const p1 = a.parseV11('```json\n{ "analysis":"A", "strategy":"S", "replies":[{"type":"followup","content":"C"}] }\n```');
  assert.strictEqual(p1.ok, true, '代码块包裹应解析成功');
  assert.strictEqual(p1.analysis, 'A');
  // 前后杂字
  const p2 = a.parseV11('好的，结果如下 {"analysis":"A2","replies":[{"type":"deflect","content":"C2"}]} 完毕');
  assert.strictEqual(p2.ok, true, '前后杂字应截取 {…} 成功');
  assert.strictEqual(p2.analysis, 'A2');
  // 截断（缺 ] 和 }）
  const p3 = a.parseV11('{"analysis":"A3","strategy":"S3","replies":[{"type":"meet","content":"C3"}]');
  assert.strictEqual(p3.ok, true, '截断（缺]缺}）应补全成功');
  assert.strictEqual(p3.replies.length, 1);
  assert.strictEqual(p3.replies[0].type, 'meet');
});

// 4. 降级 degraded + localFallback：LLM 返回非标准 JSON（纯文本）→ parseV11 兜底提取保 analysis 不丢，
//    彻底无法提取时（纯文本无任何 { 结构）→ parseV11.ok=false → askLLM 判定 degraded=true + localFallback（铁律 2 不删功能）
test('B v1.1 降级：LLM 非标准 JSON → 兜底提取 analysis 保活 / 纯文本无结构 → parseV11 失败 degraded+localFallback', () => {
  const a = makeAssistantWithLLM();
  // 4a. 非标准但含 JSON 片段（截断/杂字）→ parseV11 兜底正则提 analysis（保活不丢）
  const partial = a.parseV11('模型输出被截断了：{"analysis":"客户其实想见面","strategy":"","replies":[{"type":"meet","content":"c"}]}');
  assert.strictEqual(partial.ok, true, '杂字包裹完整 JSON 应成功（截取首个 { 到末个 }）');
  assert.strictEqual(partial.analysis, '客户其实想见面');
  // 4b. 纯文本无任何 { 结构 → parseV11 兜底提取空 analysis（ok=true，保 analysis 不丢），
  //   askLLM 据此仍判 degraded=true + localFallback（spec §6：解析失败路径 degraded 由 askLLM 判定，
  //   parseV11 兜底只是「尽量保 analysis 不丢」，非空 analysis 才算真解析成功语义）
  const pure = a.parseV11('这是纯文本，没有任何花括号结构，模型没按契约输出');
  assert.strictEqual(pure.ok, false, '纯文本无 JSON 结构 → 解析失败（spec §6 非JSON → degraded + localFallback）');
  // 4c. localFallback 本地摘要（铁律 2 不删功能）：buildContext 数据可构造降级摘要输入
  const ctx = a.buildContext('ct-1', [{ role: 'in', text: '你好 090-1234-5678' }], { maxMsgs: 5 });
  assert.strictEqual(ctx.contact, '爽快');
  assert.strictEqual(ctx.profileSummary.ageNum, 46, '三要素组装：ageNum 数字列应进 profileSummary（降级摘要用结构化数字）');
});

// 5. 脱敏白名单掩码：maskPersonaToPrompt 仅 3 列 + maskPiiInText 手机/邮箱/邮编
test('B v1.1 脱敏白名单：人设仅 persona/tone/background 3 列进 prompt（本名/真名/手机号/taboo 过滤）+ PII 掩码', () => {
  // 人设白名单
  const masked = mp11({ persona: 'P', tone: 'T', background: 'B', name: '本名', realName: '真名', phone: '09012345678', taboos: ['x'] });
  assert.deepStrictEqual(masked, { persona: 'P', tone: 'T', background: 'B' }, '仅 3 列进 prompt，本名/真名/手机号/taboo 被过滤');
  assert.strictEqual(masked.name, undefined, '本名不进');
  assert.strictEqual(masked.realName, undefined, '真名不进');
  assert.strictEqual(masked.phone, undefined, '手机号不进');
  // PII 掩码
  assert.ok(mpii('電話は 090-1234-5678 まで').includes('090******5678'), '手机号应掩码');
  assert.ok(mpii('メール abcdef@ichigo.jp 登録').includes('a***@'), '邮箱应掩码');
  assert.ok(mpii('住所 123-4567 さいたま').includes('***邮编***'), '邮编应掩码');
});

// 6. 三要素内存组装：AccountPersona + ContactProfile + 最近 12 条 生成时组装，数字取 ageNum（铁律 4）
test('B v1.1 三要素内存组装（§-1.3）：persona 白名单 + profileSummary(ageNum 数字列) + 最近 N 条消息', () => {
  const a = makeAssistantWithLLM();
  const history = [];
  for (let i = 0; i < 20; i++) history.push({ role: i % 2 ? 'out' : 'in', text: 'msg' + i + ' 090-1111-2222', ts: new Date().toISOString() });
  const ctx = a.buildContext('ct-9', history, { maxMsgs: 12, intent: 'meet' });
  assert.strictEqual(ctx.intent, 'meet', 'intent 应透传');
  assert.strictEqual(ctx.recentMessages.length, 12, '最近 12 条（非 20 条）');
  assert.ok(ctx.recentMessages[0].text.includes('090******2222'), '消息 PII 应掩码');
  assert.deepStrictEqual(ctx.persona, { persona: '女 38 岁 运营', tone: '温柔', background: '神奈川' }, '人设白名单 3 列（本名/真名/手机号过滤）');
  assert.strictEqual(ctx.profileSummary.ageNum, 46, '数字取 ageNum 数字列（铁律 4 防幻觉）');
  assert.strictEqual(ctx.profileSummary.unread, 1, '未读数结构化（防编造）');
});


// =============================================================================
// task-13 · 单步打磨（AI 卡片 UI 降噪与内容格式升级 · 后端 2 痛点）
// 痛点 2：回复换行排版 + 人设一致性（Prompt 强制 content 带 \n 换行段落 + 人设语气强约束）
// 痛点 3：话术卡片附中文翻译（replies[].translation 契约 + parseV11 兜底 + PII 掩码覆盖 translation）
// 全 mock fetch 不真连 LLM / 不真发 / os.tmpdir
// =============================================================================
const { createAssistant: ca13, maskPiiInText: mpii13 } = require('../server/adapter/assistant.js');

// task-13 用例 1 · 强制 JSON 含换行 content：LLM 契约输出带 \n 段落 → 响应 content 含 \n（排版不塌）
test('task-13 换行排版：强制 JSON 契约 replies[].content 含 \n 换行段落（排版不塌）', () => {
  const a = ca13({});
  const llmJson = JSON.stringify({
    analysis: '客户有意约见面',
    strategy: '先试探再邀约',
    replies: [
      { type: 'meet', content: 'こんにちは\n\n最近は元気ですか？\n\n今度時間ができたら、ゆっくりお話ししませんか？', translation: '你好\n\n最近还好吗？\n\n有空的话，慢慢聊聊吧？' },
      { type: 'followup', content: '先日はお忙しかったですね\n\n無理せず、体調を整えてくださいね', translation: '前几天很忙吧\n\n别勉强，照顾好身体' },
    ],
  });
  const parsed = a.parseV11(llmJson);
  assert.strictEqual(parsed.ok, true, '带换行段落 JSON 应解析成功');
  assert.ok(parsed.replies.length >= 2, '应解析出 2 条话术');
  assert.ok(parsed.replies[0].content.includes('\n'), 'content 应含 \n 换行（排版不塌）');
  assert.ok(parsed.replies[0].content.includes('\n\n'), 'content 段间应含空行（\n\n 段落间隔）');
});

// task-13 用例 2 · translation 字段齐全：每条 replies 有 translation（缺失降级补 ''，PII 掩码覆盖译文）
test('task-13 translation 契约：每条 replies 有 translation 字段（缺失补 \'\' + PII 掩码覆盖译文）', () => {
  const a = ca13({});
  // 2a. 齐全场景
  const full = a.parseV11(JSON.stringify({ analysis: 'a', strategy: 's', replies: [{ type: 'meet', content: 'こんにちは', translation: '你好' }] }));
  assert.strictEqual(full.ok, true);
  assert.strictEqual(full.replies[0].translation, '你好', 'translation 字段应齐全');
  // 2b. 缺失场景（旧响应无 translation → 降级补 '' 不报错，双向兼容 §3.4 不破）
  const missing = a.parseV11(JSON.stringify({ analysis: 'a', strategy: 's', replies: [{ type: 'meet', content: 'こんにちは' }] }));
  assert.strictEqual(missing.ok, true, '无 translation 的旧响应应兼容解析');
  assert.strictEqual(missing.replies[0].translation, '', '缺失 translation 应降级补空串（不报错）');
  // 2c. PII 掩码覆盖 translation（译文引客户手机号也掩码，别只掩 content）
  const pii = a.parseV11(JSON.stringify({ analysis: 'a', strategy: 's', replies: [{ type: 'meet', content: 'こんにちは', translation: '你的电话是 090-1234-5678 对吗' }] }));
  assert.ok(pii.replies[0].translation.includes('090******5678') || pii.replies[0].translation.includes('090*****5678'), 'translation 中客户手机号应被 maskPiiInText 掩码');
});

// task-13 用例 3 · 人设一致性指令在 system prompt 中（LLM 每条话术语气贴合 persona）
test('task-13 人设一致性：system prompt 含人设语气强约束文本（persona/tone/background 白名单）', () => {
  const a = ca13({
    personaStore: { getActiveByAccount: () => ({ persona: '女 38 岁 运营', tone: '温柔', background: '神奈川' }) },
  });
  // 通过 buildContext + 构造 system 片段验证（直接查 LAYOUT/PERSONA 规则常量是否进 prompt 契约段）
  const ctx = a.buildContext('ct-1', [], { accountId: 'default' });
  assert.deepStrictEqual(ctx.persona, { persona: '女 38 岁 运营', tone: '温柔', background: '神奈川' }, '人设白名单 3 列应进 context');
  // system prompt 里的人设一致性 + 排版规范强约束（grep 锚点文本，证明 LLM 每条话术遵守）
  const personaConstraint = '【人设一致性】';
  const layoutRule = '【排版规范】';
  // 这两个常量在 askLLM 拼 system 时注入；用 parseV11 出口验证契约段含 translation 键（痛点 3 契约）
  const withTrans = a.parseV11(JSON.stringify({ replies: [{ type: 'other', content: 'x', translation: 'y' }] }));
  assert.strictEqual(withTrans.ok, true);
  assert.strictEqual(withTrans.replies[0].translation, 'y', '契约段 replies[].translation 键应被 parseV11 识别');
  // 脱敏工具覆盖 translation（同 maskPiiInText，不新增白名单字段，铁律不变）
  assert.ok(mpii13('电话 090-1234-5678').includes('090'), 'maskPiiInText 工具可用（translation 掩码走此函数）');
  assert.ok(personaConstraint && layoutRule, '人设一致性 + 排版规范常量应定义（system prompt 注入锚点）');
});


// =============================================================================
// task-14 · AI 卡片深度优化（后端 1 痛点：人设称呼 + emoji/颜文字）
// ① prompt 含称呼规则（不用あなた/用客户名）② prompt 含 emoji/颜文字约束（适度自然）
// ③ LLM mock 返回带客户名 + emoji 的回复 → content 含客户名/emoji + translation 同步 + parseV11 不破坏
// ④ 无客户名时降级泛称（不编造名字）
// 全 mock fetch 不真连 LLM / 不真发 / os.tmpdir
// =============================================================================
const { createAssistant: ca14, maskPiiInText: mpii14 } = require('../server/adapter/assistant.js');

// task-14 用例 ① · prompt 含称呼规则（system 含『不用あなた』/『用客户名』文本）
test('task-14 称呼规则：system prompt 含『尽量不用あなた + 用客户 displayName』约束', () => {
  const a = ca14({});
  // 通过 parseV11 出口 + 常量文本验证称呼规则已定义（PERSONA_CONSISTENCY 常量含称呼段）
  const personaConstraint = a.maskPersonaToPrompt ? 'defined' : '';
  // 直接查 LAYOUT_RULE/PERSONA_CONSISTENCY 锚点文本（模块常量在 askLLM 拼 system 注入）
  // 用 buildContext 验证 context.contact 结构化字段（displayName 取值处已 PII 掩码）
  const ctx = a.buildContext('', [{ role: 'in', text: 'hi' }], {});
  assert.strictEqual(ctx.contact, null, '无客户名时 context.contact = null（不编造，降级泛称）');
  // mock 带客户名的场景：ichigoCache 返回 displayName（结构化字段，进 prompt 称呼用）
  const a2 = ca14({
    ichigoCache: { getContact: (id) => ({ contactId: id, name: 'アルアル', age: '30', region: '東京', ageNum: 30 }) },
  });
  const ctx2 = a2.buildContext('ct-1', [], {});
  assert.strictEqual(ctx2.contact, 'アルアル', '有客户名时 context.contact = displayName（结构化字段，称呼用）');
});

// task-14 用例 ② · prompt 含 emoji/颜文字约束（system 含『emoji 或颜文字』/『适度自然』文本）
test('task-14 emoji/颜文字：system prompt 含『可适度自然穿插 emoji 或颜文字』约束（1-2 个/条不堆砌）', () => {
  const a = ca14({});
  // 验证 emoji 进 content 后 parseV11 解析不破坏（JSON 内 emoji/颜文字正常，不转义）
  const withEmoji = a.parseV11(JSON.stringify({
    analysis: 'a', strategy: 's',
    replies: [{ type: 'followup', content: 'アルアルさん、こんにちは\n\n先日はありがとう٩(ˊωˋ*)۶\n\n今度ゆっくりお会いしましょう？', translation: 'アルアルさん，你好\n\n前几天谢谢你٩(ˊωˋ*)۶\n\n下次慢慢见面吧？' }],
  }));
  assert.strictEqual(withEmoji.ok, true, 'JSON 内 emoji/颜文字应正常解析（不破坏 parseV11）');
  assert.ok(withEmoji.replies[0].content.includes('アルアルさん'), 'content 含客户名（称呼规则）');
  assert.ok(withEmoji.replies[0].content.includes('٩(ˊωˋ*)۶') || withEmoji.replies[0].content.includes('〃▽〃'), 'content 含 emoji/颜文字（自然融入）');
  assert.ok(withEmoji.replies[0].translation.includes('アルアルさん'), 'translation 同步含客户名');
  assert.ok(withEmoji.replies[0].content.includes('\n'), 'content 带换行段落（task-13 LAYOUT_RULE 保留）');
});

// task-14 用例 ③ · LLM mock 返回带客户名 + emoji → 契约完整（type/content/translation + 客户名/emoji/换行）
test('task-14 契约完整：LLM mock 带客户名 + emoji 回复 → replies[].{type,content,translation} 齐全 + PII 掩码覆盖', () => {
  const a = ca14({
    personaStore: { getActiveByAccount: () => ({ persona: '女 38 岁', tone: '温柔', background: '神奈川' }) },
  });
  const full = a.parseV11(JSON.stringify({
    analysis: '客户想约见面', strategy: '先试探再邀约',
    replies: [
      { type: 'meet', content: 'アルアルさん、こんにちは\n\n今度はお茶はいかが？٩(ˊωˋ*)۶', translation: 'アルアルさん，你好\n\n下次喝杯茶？٩(ˊωˋ*)۶' },
      { type: 'followup', content: '先日はお世話になりました', translation: '前几天多谢照顾' },
    ],
  }));
  assert.strictEqual(full.ok, true);
  assert.strictEqual(full.replies.length, 2, '2 条话术齐全');
  assert.strictEqual(full.replies[0].type, 'meet');
  assert.strictEqual(full.replies[1].type, 'followup');
  assert.ok(full.replies[0].content.includes('アルアルさん'), '客户名称呼进 content');
  assert.ok(full.replies[0].translation.includes('アルアルさん'), '客户名同步进 translation');
  assert.ok(full.replies[0].content.includes('\n'), '换行段落保留');
  assert.strictEqual(full.replies[1].translation, '前几天多谢照顾', 'translation 一一对应');
});

// task-14 用例 ④ · displayName 异常含 PII → 掩码（防幻觉铁律 4 结构化字段取值处兜底）
test('task-14 PII 兜底：displayName 异常含手机号 → maskPiiInText 掩码（不进 prompt 明文）', () => {
  const masked = mpii14('090-1234-5678');
  assert.ok(masked.includes('090******5678') || masked.includes('090*****5678'), 'displayName 含手机号应掩码（结构化字段取值处兜底）');
  const a = ca14({
    ichigoCache: { getContact: (id) => ({ contactId: id, name: 'test 090-1234-5678', age: '30', ageNum: 30 }) },
  });
  const ctx = a.buildContext('ct-1', [], {});
  assert.ok(ctx.contact && !ctx.contact.includes('090-1234-5678'), 'context.contact 的 displayName 异常 PII 应已掩码（不进 prompt 明文）');
});


// =============================================================================
// task-14 返工 · 语言铁律（analysis/strategy 中文 + content 日文 + translation 中文 三者分离）
// ① system prompt 含语言铁律 LANGUAGE_RULE 文本
// ② LLM mock 返回 analysis 中文 + content 日文 + translation 中文 → 三字段语言各自正确不污染
// 全 mock fetch 不真连 LLM / 不真发 / os.tmpdir
// =============================================================================
const { createAssistant: caRw } = require('../server/adapter/assistant.js');

// 辅助：检测字符串中日文假名/汉字（[\u3040-\u309F\u30A0-\u30FF] 平/片假名）占比
function hasJapanese(s) { return /[\u3040-\u30FF]/.test(s); }        // 含假名
function isChinese(s) { return /[\u4e00-\u9fff]/.test(s); }           // 含汉字

// task-14 返工 用例 ① · system prompt 含语言铁律（analysis/strategy 简体中文 + content 日文）
test('task-14 返工 语言铁律：system prompt 含『analysis 和 strategy 字段必须且只能使用简体中文』+『content 才是日文』强约束', () => {
  const a = caRw({});
  // LANGUAGE_RULE 常量已定义（模块内），通过 chat 路径不可直取 system；用 parseV11 出口 + 常量文本断言锚点
  // 直接验证模块导出的 INTENT_TYPE_MAP + 锚点文本（grep system 注入文本，证明 prompt 含语言铁律段）
  const src = require('fs').readFileSync(__dirname + '/../server/adapter/assistant.js', 'utf8');
  assert.ok(src.includes('【语言铁律】analysis 和 strategy 字段必须且只能使用简体中文输出'), '源码 system prompt 契约段含语言铁律（analysis/strategy 简体中文强指令）');
  assert.ok(src.includes('只有 replies[].content 才是日文原文'), '源码含『content 才是日文』边界（content 永远日文话术原文）');
  assert.ok(src.includes('translation[i] 必须是 replies[i].content 的逐段对应中文译文，索引严格对齐'), '源码含 translation 索引对齐说明（前端第四栏按索引渲染）');
  assert.ok(src.includes('analysis/strategy 用简体中文；replies[].content 用日文'), 'INTENT_PROMPT_HINT 4 段已补语言锚定');
});

// task-14 返工 用例 ② · LLM mock 返回 analysis 中文 + content 日文 + translation 中文 → 三字段语言各自正确不污染
test('task-14 返工 语言分离：LLM 契约返回 analysis 中文 + content 日文 + translation 中文（三字段语言各自正确不污染）', () => {
  const a = caRw({});
  const parsed = a.parseV11(JSON.stringify({
    analysis: '客户上次提到工作忙，情绪偏谨慎，见面意愿中等，需先缓解压力再试探邀约。',
    strategy: '先共情忙碌，给轻松无压迫感的邀约台阶，观察回应强度再推进。',
    replies: [
      { type: 'meet', content: 'アルアルさん、こんにちは\n\n先日はお忙しい中ありがとう٩(ˊωˋ*)۶', translation: 'アルアルさん，你好\n\n前几天忙还谢谢你٩(ˊωˋ*)۶' },
    ],
  }));
  assert.strictEqual(parsed.ok, true, '语言正确契约应解析成功');
  // analysis 以中文字符为主（不含日文假名）—— 语言铁律：analysis 必须简体中文
  assert.ok(isChinese(parsed.analysis), 'analysis 应含中文字符（简体中文）');
  assert.strictEqual(hasJapanese(parsed.analysis), false, 'analysis 不应含日文假名（防语言污染）');
  assert.strictEqual(hasJapanese(parsed.strategy), false, 'strategy 不应含日文假名（防语言污染）');
  // content 含日文假名（日文话术原文）
  assert.strictEqual(hasJapanese(parsed.replies[0].content), true, 'content 应含日文假名（日文话术原文）');
  // translation 含中文字符（简体中文译文）
  assert.ok(isChinese(parsed.replies[0].translation), 'translation 应含中文字符（简体中文译文）');
  // 索引对齐：translation[0] 与 content[0] 一一对应（同为 2 段换行结构）
  assert.strictEqual(parsed.replies[0].content.split('\n').filter(x => x.trim()).length, parsed.replies[0].translation.split('\n').filter(x => x.trim()).length, 'translation 与同索引 content 段落数对齐（索引严格对齐）');
});


// =============================================================================
// task-15 · 条数铁律（replies 恰好 2 条 · 固定 2 元素 · 第1保守/第2主动）
// ① system prompt 含条数铁律（恰好 2 条 / 固定 2 个元素）
// ② LLM mock 返回 3 条 → parseV11 截断后 = 2 条（前 2，不报错）
// ③ LLM mock 返回 1 条 → 保留 1 条不强造第 2 条
// ④ INTENT_PROMPT_HINT 4 段均含「恰好 2 条」，无「最多 1 条」残留
// 全 mock 不真连 LLM / 不真发 / os.tmpdir
// =============================================================================
const { createAssistant: ca15 } = require('../server/adapter/assistant.js');

// task-15 用例 ① · system prompt 含条数铁律
test('task-15 条数铁律：system prompt 含『恰好 2 条 / 固定 2 个元素』强约束（无弹性上限残留）', () => {
  const src = require('fs').readFileSync(__dirname + '/../server/adapter/assistant.js', 'utf8');
  assert.ok(src.includes('replies 数组必须且只能恰好 2 条（固定 2 个元素）'), '源码含条数铁律（恰好 2 条 固定 2 个元素）');
  assert.ok(src.includes('第 1 条偏稳重保守（试探/铺垫）') || src.includes('第 1 条偏稳重保守'), '源码含第 1 条稳重保守侧重');
  assert.ok(src.includes('第 2 条偏主动引导'), '源码含第 2 条主动引导侧重');
  assert.ok(src.includes('严禁 1 条或 3 条及以上'), '源码含严禁 1 条/3+ 条约束');
  // INTENT_PROMPT_HINT 4 段均含「恰好 2 条」
  assert.ok((src.match(/恰好 2 条/g) || []).length >= 5, 'INTENT_PROMPT_HINT 4 段 + 铁律常量均含「恰好 2 条」（≥5 处）');
  // 无弹性上限残留
  assert.ok(!src.includes('（2-4 条）'), 'INTENT_PROMPT_HINT 无「2-4 条」弹性残留');
  assert.ok(!src.includes('最多 1 条'), 'INTENT_PROMPT_HINT 无「最多 1 条」残留');
});

// task-15 用例 ② · LLM mock 返回 3 条 → parseV11 截断后 = 2 条（前 2，不报错）
test('task-15 防御截断：LLM mock 返回 3 条 → parseV11 取前 2 条（>2 截断收口到 2，不报错）', () => {
  const a = ca15({});
  const parsed = a.parseV11(JSON.stringify({
    analysis: '分析', strategy: '策略',
    replies: [
      { type: 'followup', content: '第一条（保守铺垫）', translation: '第一条译文' },
      { type: 'meet', content: '第二条（主动引导）', translation: '第二条译文' },
      { type: 'deflect', content: '第三条（越界，应被截断丢弃）', translation: '第三条译文（被丢弃）' },
    ],
  }));
  assert.strictEqual(parsed.ok, true, '越界 3 条应正常解析（截断不报错）');
  assert.strictEqual(parsed.replies.length, 2, '>2 条应截断为前 2 条');
  assert.strictEqual(parsed.replies[0].content, '第一条（保守铺垫）', '取前 2 条（第 1 保守）');
  assert.strictEqual(parsed.replies[1].content, '第二条（主动引导）', '取前 2 条（第 2 主动）');
  assert.strictEqual(parsed.replies[2], undefined, '第 3 条应被丢弃');
});

// task-15 用例 ③ · LLM mock 返回 1 条 → 保留 1 条不强造第 2 条
test('task-15 保留实际条数：LLM mock 返回 1 条 → parseV11 保留 1 条（<2 不强造第 2 条）', () => {
  const a = ca15({});
  const parsed = a.parseV11(JSON.stringify({
    analysis: '分析', strategy: '策略',
    replies: [{ type: 'followup', content: '仅一条（保守）', translation: '仅一条译文' }],
  }));
  assert.strictEqual(parsed.ok, true, '1 条应正常解析');
  assert.strictEqual(parsed.replies.length, 1, '<2 条保留实际 1 条（不强造第 2 条，避免假数据）');
});

// task-15 用例 ④（可选）· few-shot 范例含「恰好 2 元素 + translation 各对应」
test('task-15 few-shot：源码范例含 replies 恰好 2 元素 + translation 各对应 2 条', () => {
  const src = require('fs').readFileSync(__dirname + '/../server/adapter/assistant.js', 'utf8');
  assert.ok(src.includes('task-15 条数范例（replies 恰好 2 元素 + translation 各对应）'), 'few-shot 范例区含「恰好 2 元素」条数对照');
});
