# docs/plan/assistant-api-spec.md · Ai SAY 助手面板 API 协议规范（B v1 → C v2 演进）

> 作者：System_Architect。范围：POST /api/console/assistant 的完整协议、上下文契约、动作卡片 schema、降级语义与 C 阶段演进边界。
> 依据：AGENTS.md §5（B→C 方案 + 工具白名单 + 四条铁律）、附录·系统提示词（persona）、server/adapter/assistant.js 现状（B v1 已实现 161 行）。
> 本文只定契约，不写实现代码；实现归 Backend_Lead，前端渲染契约归 Frontend_Lead。

## 1. 端点总览

| 版本 | 端点 | 说明 |
|---|---|---|
| B v1（现状） | POST /api/console/assistant | 单轮：组上下文 → LLM → { reply, actions[] } |
| **B v1.1（扩入）** | POST /api/console/assistant | 响应增 analysis/strategy/replies 三字段 + 请求 intent + LLM 强制 JSON + PII 脱敏；旧前端零破坏 |
| C v1（演进） | POST /api/console/assistant （sessionId 查询参） | 多轮会话：同一 sessionId 共享 LLM 消息历史 |
| C v2（规划） | POST /api/console/assistant/batch | 批量动作分解：一次任务 → N 条话术建议 + 批量确认卡 |

**不变式（B/C 通用）**：
1. 强副作用动作（send_message）永远只产出 `needConfirm: true` 的动作卡片，执行路径唯一 = send-live（铁律 §0.2）。
2. 模型不可用 → `degraded: true` + 本地摘要回复（不删功能，铁律 §5.3）。
3. 数字事实（年龄/条数/时间）只允许来自 buildContext 的结构化数据，LLM 提示词中明令禁止编造。

## 2. 请求契约

```
POST /api/console/assistant[?sessionId=uuid]
Content-Type: application/json

{
  "message": "string, 必填, 运营者输入",
  "contactId": "string, 可选, 当前选中客户",
  "history": [ { "role": "in|out", "text": "string", "ts": "iso8601?" } ],   // 可选，前端携带的会话上下文
  "maxMsgs": 12,           // 可选，上下文消息截断条数（默认 12）
  "tools": ["string"],     // 可选，子集覆盖 TOOL_WHITELIST（默认全量 9 个）
  "intent": "analyze | reply | deflect | meet"   // B v1.1 可选；缺省 = 自由问答（B v1 行为不变）
}
```

**B v1.1 请求扩展（intent 字段，向后兼容）**：
- `intent` ∈ {analyze, reply, deflect, meet}（可选）。缺省时行为与 B v1 完全一致（自由问答）。
- 后端按 intent 切换 system prompt 侧重（analyze→心理画像解读；reply→高情商话术；deflect→委婉拉扯/拒绝；meet→引导线下约会），三要素组装规则不变（§5）。
- 前端 Action Chips（aishay-uix-upgrade §2）：chip 点击 → 组装 message + intent → POST；aiInput 有内容时 message = aiInput + 「（意图：{intent}）」，无内容时 message = intent 本身。

C v1 新增：`sessionId`（前端 localStorage 生成 uuid）。有 sessionId 时后端把 (system persona + 工具清单 + 该 session 最近 20 轮 对话) 作为 LLM 消息历史；无 sessionId 行为与 B 完全一致（向后兼容，旧前端零改动）。

## 3. 响应契约（B/C 统一）

```
200 {
  "ok": true,
  "degraded": false,
  "reason": "",                     // degraded 时说明原因；正常为空
  "reply": "string",                // LLM 正文（简体中文；引用客户消息可保留日文）
  "actions": [
    {
      "type": "get_customer | list_customers | search_customers | generate_replies | translate | fill_draft | mark_read | switch_customer | send_message",
      "label": "string",            // 卡片按钮文案（LLM 可覆写，缺省用白名单 label）
      "payload": { "…": "…"},      // 类型相关参数，见 §4
      "sideEffect": "none | weak | strong",
      "needConfirm": true           // 仅 strong 出现；前端必须渲染确认按钮
    }
  ],
  "contact": "string?",             // 上下文客户名
  "sessionId": "uuid?",            // 有 sessionId 请求时回显
  "fetchedAt": "iso8601",
  // ---- B v1.1 扩展字段（缺省可空，旧前端不渲染 = 零破坏）----
  "analysis": "string?",            // 客户心理/画像解读（Accordion ①），可空串；v1.1 起建议 LLM 正文并入 analysis/strategy
  "strategy": "string?",            // 应对策略要点（Accordion ②），可空串
  "replies": [                       // 话术卡片列表（Accordion ③ 下方独立卡片 × N），v1.1 新增
    { "type": "opening | followup | deflect | meet | close | other", "content": "string（填入 msgInput 的日文话术原文）" }
  ]
}
400 { "ok": false, "reason": "empty-message", "msg": "缺少 message" }
```

**B v1.1 响应扩展说明**：
- `analysis` / `strategy`：Accordion 折叠区（默认收起，空值不渲染）。
- `replies`：每条独立话术卡片，右下角 [填入发送框] 按钮（只填 msgInput DOM value + focus，零发送，铁律 §0.2）；`replies[].type` 枚举 6 种，前端未知 type 一律按 other 渲染不报错。

**intent → replies[].type 默认映射表（code-reviewer 收编 b，消除枚举不对称）**：
`intent` 枚举 4 种（§2），`replies[].type` 枚举 6 种（opening/followup/deflect/meet/close/other）。LLM 按 intent 生成 replies 时，默认 type 映射如下；LLM 可覆写 type，但前端渲染以 type 为准（未知 type 按 other）：

| intent | 默认 replies[].type | 说明 |
|---|---|---|
| analyze | other | 深度心理分析以 analysis 为主，replies 出 other 类型话术（可选） |
| reply | followup | 高情商回复，replies 默认出 followup 跟进话术 |
| deflect | deflect | 委婉拉扯/拒绝，replies 默认出 deflect 话术 |
| meet | meet | 引导线下约会，replies 默认出 meet 话术 |

前端按 type 渲染角标（开场/跟进/拉扯/见面/收尾/其他），与 intent 一一对应不错位。backend-lead 改 Prompt 时把此映射写进 system（「当 intent=X，replies 优先出 type=Y 的话术」），LLM 可出混合 type，前端逐条按实际 type 渲染。
- `reply`（LLM 正文）：v1.1 起可为空串（正文并入 analysis/strategy）；旧前端仍读 reply，不破坏。
- `actions`（既有动作卡片）：不变。

**B v1.1 兼容矩阵**（aishay-uix-upgrade §3.4 契约固化）：

| 前端版本 | 后端版本 | 行为 |
|---|---|---|
| 旧（无 intent） | 新（B v1.1） | 旧前端无 intent → 后端按自由问答，响应带新字段但旧前端不渲染，actions/reply 照常，**零破坏** |
| 新（有 intent） | 旧（B v1） | 新前端发 intent → 旧后端忽略，响应无新字段 → 新前端 Accordion/卡片区空渲染，actions/reply 可用，**降级可用不崩** |
| 新 + 新 | — | 完整体验 |

**LLM 输出格式（B v1.1 强制 JSON，backend-lead 改 Prompt）**：
- 要求 LLM 只输出**单一 JSON 对象**，结构 = `{ analysis, strategy, replies:[{type, content}] }`，不得输出 Markdown / 解释文字。
- 后端 parseJSON 提取：容忍 json 代码块包裹与前后空白；结构不可 JSON.parse → `degraded=true` + localFallback（§6 降级矩阵，铁律 2）。
- 与 §4 actions 的关系：actions 仍从 LLM 输出解析（现状 parseActions 行为不变），新字段与 actions 共存（前端渲染分两块：Accordion/话术卡片 vs 动作卡片）。

**前端渲染规则**（Frontend_Lead 契约）：
- `actions` 按数组顺序渲染卡片；强副作用卡片带「发送需你确认」徽标。
- 弱副作用卡片点击后前端直接执行（fill_draft 填入输入框 / mark_read / switch_customer / 只读工具调对应 GET 端点），不经 LLM。
- 强副作用卡片点击 → 前端调 `POST /api/console/send-live { contactId, text: payload.text, doConfirm: true }`；**assistant 端点永不触发真发**。

## 4. 各动作类型 payload schema（LLM 输出解析 + 前端执行 双端契约）

| type | payload | 执行路径 |
|---|---|---|
| get_customer | { contactId } | GET /api/console/live/customer?id= |
| list_customers | { filter?: { unread?, online?, region?, ageMin?, ageMax? } } | GET /api/console/live/customers |
| search_customers | { query } | GET /api/console/live/customers + 前端过滤（现状无服务端 search，C 阶段可加 ?q= 参数） |
| generate_replies | { contactId, tier? } | 前端调现有推荐回复逻辑（GET customers/:id 的 recommendedReplies） |
| translate | { text, from?, to? }（from/to 缺省 ja→zh-CN） | GET /api/console/translate?text=&from=&to= |
| fill_draft | { text } | 前端 DOM 填入 ichigo-console 输入框（不点发送） |
| mark_read | { contactId } | POST /api/console/live/customer/read?id= |
| switch_customer | { contactId } | 前端切卡片 + GET live/customer |
| send_message | { contactId, text, doConfirm? } | **仅生成卡片**；点击后走 send-live |

## 5. 上下文组装契约（buildContext，后端内部）

```
{
  contactId, contact: name,
  profileSummary: { age?, region?, occupation?, interests?: [labels] },  // 来自 ichigoCache 画像，缺字段省略（不填 null 防 LLM 引用）
  recentMessages: [{ role, text: ≤160字截断, ts }],                       // 最近 maxMsgs 条
  tools: [白名单子集],
  degraded: false
}
```

规则：
- 画像字段缺失 → 提示词中标「没有数据」，不构造默认值（防幻觉，铁律 §5.4）。
- 消息截断 160 字/条（现状），C 阶段可提至 400 但须同步更新 token 预算说明。
- 工具清单注入 system prompt 时只出 type/label/desc，不出 payload 示例（省 token；LLM 按 §4 schema 自行填参，解析失败的动作被丢弃而非报错——现状 parseActions 行为，保持）。

**B v1.1 脱敏约束（code-reviewer 预审 1 点，硬卡点 · 三类数据永不进 prompt）**：
1. **apiKey 仅走 HTTP header**：调 LLM 时 apiKey 只放 `Authorization: Bearer` header，严禁拼入 system/user message、context 对象或任何会被回显的字段。buildContext 返回的上下文不含密钥。
2. **客户 PII 掩码**：buildContext 组装 recentMessages 时，对每条 text 做 PII 掩码（手机号/邮箱/邮编 → 部分打码；如 `090****1234` / `a***@b.com`）。结构化画像字段（age/region/occupation/interests）属必要上下文，允许进 prompt。
3. **人设字段白名单（写死，code-reviewer 收编 a）**：
   - 进 prompt 的人设字段**仅限白名单 3 个**：`persona`（身份/背景故事/口吻基调 JSON）/ `tone`（口吻基调）/ `background`（背景故事）。
   - **严禁进 prompt**：账号本名 / 真名 / 手机号（AccountPersona 表若有此类字段一律过滤；talk.vars.personaName 拼 system 时只取昵称段，不带本名/真名）。
   - 统一口径：talkEngine L363 personalize 拼 system 与 assistant.js buildContext 组上下文**共用同一白名单**（backend-lead 实施按白名单取字段，两处不各写一套）。
   - 白名单来源 = AccountPersona 表（schema.sql）的 persona/tone/background 三列，不含 taboos（taboos 单独走规则引擎，不进 LLM prompt）。
4. **验证**：qa-lead 用例 16 断言 prompt body 与运行时日志均不含 apiKey / 账号本名 / 客户真名（AGENTS §6 密钥不进 Git 延伸到运行时日志脱敏）。

## 6. 降级矩阵

| 条件 | 行为 |
|---|---|
| modelStore 无可用模型（未配置/apiKey 空） | degraded=true, reason=「模型未配置或不可用」, reply=本地摘要 |
| LLM HTTP 非 2xx | degraded=true, reason=「LLM HTTP {status}」, 本地摘要 |
| LLM 超时（60s AbortController）/ 网络失败 | degraded=true, reason=「LLM 调用失败：{msg}」, 本地摘要 |
| LLM 返回 200 但无有效 choices | 同上按失败处理 |
| 动作 JSON 解析失败 | 正文照回，actions=[]（静默，不报错——现状行为，保留） |
| **B v1.1：LLM 返回非标准 JSON**（杂字/截断/非 JSON/缺字段） | 后端 parseJSON 失败 → `degraded=true` + localFallback（铁律 2），replies=[]、analysis/strategy 为空串，前端按降级渲染（预审 3 点） |

本地摘要内容（localFallback 现状）：声明降级模式 + 客户名 + 最近 5 条消息 + 可建议的弱副作用动作清单。

## 7. C v2 批量确认卡协议（规划，不实现）

```
POST /api/console/assistant/batch
{ "task": "给未读客户批量生成回复并标记已读", "contactIds": [...], "maxActions": 10 }
→ 200 { "ok": true, "plan": [ {step, action, payload} ], "batchConfirm": true }
前端整批确认 → 逐条执行（只读/弱副作用直执行；send_message 类逐条出 confirm 卡，用户可勾选 N/M 条再发）
```

不变式仍成立：批量 = 用户整批确认 → 系统逐条执行，LLM 仍不直接发送。

## 8. 会话持久化（C v1 多轮）

- 新表 AssistantSession(sessionId PK, contactId?, createdAt, updatedAt, TTL 24h) + AssistantMessage(id, sessionId, role, content, ts)——**schema 走 DBA 出迁移，本文不写 DDL**。
- 无 sessionId 的单轮请求不落库（B 行为零变化）。
- session 超 TTL 或手动关闭 → 下次同 sessionId 视为新会话。

## 9. 验收口径（QA）
- B 回归：无 sessionId 请求响应字段与现状逐字段一致（黄金样本对比）。
- 降级路径：断网/未配置模型 两种注入用例，断言 degraded=true 且 reply 非空、actions 可解析。
- 强副作用不变式：所有含 send_message 的响应，needConfirm 必须为 true；前端断言 send-live 调用只出现在用户点击后。
- **B v1.1 新增（对应 aishay-uix-upgrade §7 用例 11-16）**：
  - LLM 返回合法 JSON → 响应 analysis/strategy/replies 字段齐全。
  - LLM 返回 json 代码块包裹 → parseJSON 仍提取成功（容忍边界）。
  - LLM 返回非 JSON/截断 → actions=[] 且 degraded=true + localFallback（预审 3 点 / 铁律 2）。
  - intent=analyze/reply/deflect/meet 四种，system prompt 侧重正确。
  - 无 intent 请求 → 响应含新字段但 actions/reply 与 B v1 黄金样本一致（回归不破，§3.4 矩阵第一格）。
  - 脱敏回归：apiKey 不出现在任何 LLM 请求 body / 日志 / prompt（预审 1 点）；客户 PII 在 recentMessages 中已掩码。
  - 只填不发：[填入发送框] handler 函数体 grep 无 fetch / send-live / 任何 send 调用（预审 2 点）。
