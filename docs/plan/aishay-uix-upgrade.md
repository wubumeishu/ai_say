# Ai SAY 面板「破旧立新」UI 升级设计稿（task-5）

> 作者：Frontend_Lead · 阶段：设计 + 记录（三端联调待基建 task-①② 稳定后由总控放行）
> 依据：终极蓝图 §-1.4（三要素打包给 LLM 生成策略）、AGENTS.md §5 四条铁律、
> docs/plan/assistant-api-spec.md（B v1 契约，本稿扩展为 B v1.1）、用户插播需求
> （Action Chips + 强制 JSON + 一键填入）。
> 本文是设计稿：定交互、契约、分工、降级矩阵、测试清单。不含实现代码。
> code-reviewer 预审 3 点（脱敏 / 只填不发 / 非标准 JSON 降级）已全部纳入，见 §9。

---

## 1. 破旧：删除范围（硬编码日文快捷语）

### 1.1 删除清单（实施时逐项核对）

| # | 位置 | 内容 | 处置 |
|---|---|---|---|
| D1 | ichigo-console.html renderAiQuick()（L1629-1648） | 面板内「常用语前 8 条按 useCount 排序」快捷短语条（数据源 = 后端 consolePrefs 开场默认语，即「はじめまして☺️…」「大人の関係…」「ご予算は…」等） | 整块删除。被 §2 Action Chips 取代 |
| D2 | ichigo-console.html L585 ai-quick 容器 | 快捷短语容器 HTML | 替换为 §2 的 Action Chips 容器 |
| D3 | server consolePrefs.js 开场组默认语种子（L24+） | 仅被 D1 消费的面板快捷语种子 | 保留不动：中栏「常用语」管理功能（renderPhraseTabs/renderPhrases）仍消费同一数据，删除会破坏中栏。只删前端面板侧消费 |
| D4 | ichigo-console.html renderRecs() 硬编码日文推荐语（L1179-1191 胸/出会/预算分支 + 兴趣拼接） | 规则式硬编码话术 | 不属本次范围：属「假可用」遗留，归 recommender 规则引擎修复域，本稿只标记不删 |

> 精确边界：本次「破旧」只删 D1+D2（Ai SAY 面板快捷短语条）。
> 中栏常用语管理、renderRecs 硬编码话术均不动，避免越权。

### 1.2 删除后空态

删 D1/D2 后，面板输入区上方不再是「常用语条」，而是 §2 的 Action Chips（恒定 4 枚，与数据无关），无「暂无常用语」空态问题。

---

## 2. 立新 · 输入区：Action Chips（可横向滑动意图卡）

### 2.1 设计

- 位置：聊天输入框（aiInput）正上方，原 aiQuick 容器位（L585）。
- 形态：一行可横向滑动 chips（overflow-x:auto；隐藏滚动条；flex nowrap），固定 4 枚：

| chip | 文案 | 图标 | intent 参数 |
|---|---|---|---|
| C1 | 深度心理分析 | 放大镜 | analyze |
| C2 | 生成高情商回复 | 对话 | reply |
| C3 | 委婉拉扯/拒绝 | 盾牌 | deflect |
| C4 | 引导线下约会 | 靶心 | meet |

- 交互：点击不直接发送，而是把意图指令 + 用户当前 aiInput 内容（若有）组装后调 POST /api/console/assistant，请求体新增 intent 字段（§3.2）。若 aiInput 为空，点 chip 即以 intent 为 message 触发后端生成流（后端 LLM 按 intent 出 analysis/strategy/replies）；若 aiInput 有内容，则 message = aiInput + 「（意图：{intent}）」，清空 aiInput。
- 视觉：chip 圆角胶囊，hover/active 用 accent 色；选中态短暂高亮 200ms；降级模式下 chip 灰显（仍可用，后端走 localFallback，返回 degraded=true）。

### 2.2 数据流

chip 点击 → intent ∈ {analyze, reply, deflect, meet} → POST /api/console/assistant { message, contactId, intent, history, maxMsgs } → 200 { ok, degraded, analysis, strategy, replies: [{type, content}], actions[] } → 前端渲染 §4（Accordion + 话术卡片）。

---

## 3. JSON 契约（交 System_Architect 扩入 assistant-api-spec.md §3）

### 3.1 响应扩展（B v1.1，向后兼容）

现有 B v1 响应 {ok, degraded, reason, reply, actions[], contact, fetchedAt} 基础上，新增 3 个顶层字段（缺省可空，旧前端不渲染 = 零破坏）：

- analysis（string）：客户心理/画像解读，Accordion ①；可空串。
- strategy（string）：应对策略要点，Accordion ②；可空串。
- replies（数组）：话术卡片列表，每条独立渲染。元素 = { type, content }。type ∈ {opening, followup, deflect, meet, close, other}（前端对未知 type 一律按 other 渲染，不报错）；content = 填入 textarea 的日文话术原文。

reply（LLM 正文）：v1.1 起建议 LLM 把正文并入 analysis/strategy，reply 可为空串。actions（既有动作卡片，send_message 等强副作用）保持不变。

### 3.2 LLM 输出格式（强制 JSON，后端 backend-lead 改 Prompt）

要求 LLM 只输出一个 JSON 对象，结构 = { analysis, strategy, replies:[{type,content}] }，不得输出 Markdown/解释文字。后端 parseJSON 提取（容忍 json 代码块包裹 / 前后杂字），解析失败 → §5 降级。

### 3.3 请求扩展（新增 intent，可选）

POST /api/console/assistant，请求体含 message（必填）、contactId（可选）、intent ∈ {analyze, reply, deflect, meet}（可选；缺省 = 自由问答，B v1 行为）、history、maxMsgs。后端按 intent 切换 system prompt 侧重（analyze→心理画像；reply→高情商话术；deflect→委婉拉扯/拒绝；meet→引导线下），三要素（人设+画像+上下文）组装规则不变（spec §5）。

### 3.4 兼容矩阵

| 前端版本 | 后端版本 | 行为 |
|---|---|---|
| 旧（无 intent） | 新（B v1.1） | 旧前端发请求无 intent → 后端按自由问答，响应带新字段但旧前端不渲染，actions/reply 照常，零破坏 |
| 新（有 intent） | 旧（B v1） | 新前端发 intent → 旧后端忽略该字段，响应无新字段 → 新前端 Accordion/卡片空渲染，仅 actions/reply 可用，降级可用不崩 |
| 新 + 新 | | 完整体验 |

---

## 4. 前端渲染（Accordion + 话术卡片 + 一键填入）

### 4.1 消息节点结构（每条 assistant 回复）

一条 .ai-msg.bot 节点内包含：
- Accordion ①（analysis）：默认收起，点 .ai-acc-head 展开 .ai-acc-body；空值不渲染。
- Accordion ②（strategy）：默认收起；空值不渲染。
- 话术卡片 × N（replies 每条一张）：卡片内含 .ai-reply-content（content 原文，日文）、.ai-reply-type-badge（type 角标：开场/跟进/拉扯/见面/收尾）、右下角 [填入发送框] 按钮。
- 既有 actions[] 渲染区（强副作用确认卡，不变）。

### 4.2 一键填入约束（对应预审 2 点）

- 填入目标 = msgInput（中栏消息输入框，L466，日文），不是 aiInput（助手面板输入框）。与既有 fill_draft 动作（L2092）同一目标，复用 runAction 的填入逻辑。
- 每次填入覆盖 msgInput（非追加），避免多张卡拼接混乱；若用户已手改 msgInput，点填入前 confirm「覆盖当前输入？」。
  > 注记（code-reviewer 初审打回 1 条 · 2026-10-06）：上述 confirm 覆盖逻辑实施时归**公共组件域**（拆分后 events.js 或独立 confirm-dialog 组件，见 AGENTS §1.8 / §7 Phase 4）；当前内联位置是临时态，ichigo-console.html 2236 行正在拆分，避免拆到一半 handler 丢失。
- 填入后不自动发送（铁律 §5.1）；填入 = 弱副作用，仅把 content 写进 textarea 并 focus，由用户自行点 #sendButton 走既有确认发送流（ichigoSendExpr）。本功能不存在任何隐式发送路径，点 [填入发送框] 仅触发 DOM value 赋值 + focus + toast，不发起任何 fetch、不触碰 send-live。强副作用 send_message 仍走既有确认卡 → send-live。

### 4.3 降级渲染

degraded=true 时：Accordion/卡片区替换为既有「降级模式」标签（.ai-degraded-tag，L145）+ localFallback 文本（spec §6）；Action Chips 灰显但可点（后端仍返回本地摘要）。

---

## 5. 降级矩阵（前端视角，对应预审 3 点）

| 条件 | 前端表现 |
|---|---|
| 后端 200 + degraded=false + 合法 JSON | 正常渲染 Accordion+卡片+actions |
| 后端 200 + degraded=true（模型不可用） | 灰显 chips + 降级标签 + localFallback 文本，卡片区空 |
| LLM 返回非标准 JSON（杂字/截断/非 JSON） | 后端 parseJSON 失败 → degraded=true + localFallback（§5 铁律 2）；前端按 degraded=true 渲染 |
| 后端 501（assistant 未注入） | 既有「助手不可用」err 气泡，chips 仍可点但提示不可用 |
| 网络异常（fetch throw） | 既有 catch → 本地 aiReply() 降级，chips 不影响 |
| 响应缺 analysis/strategy/replies（旧后端） | 对应区块不渲染，actions/reply 照常 |
| 响应含 send_message action | 渲染既有强副作用确认卡，needConfirm=true，点击才走 send-live |

---

## 6. 前后端分工

| 域 | 负责 | 内容 |
|---|---|---|
| 前端 | Frontend_Lead（本稿） | 删 D1/D2；加 Action Chips；渲染 Accordion+话术卡片+一键填入；降级矩阵实现 |
| 后端 | backend-lead | assistant.js Prompt 改强制 JSON；parseJSON 提取 analysis/strategy/replies；intent 分 prompt；按 §9 脱敏 |
| 契约 | system-architect | 把 §3 扩入 assistant-api-spec.md（响应 + 请求 + 兼容矩阵 + 脱敏约束） |
| 测试 | qa-lead | 按 §7 清单 |
| 删除范围裁决 | lead | 确认 D3（consolePrefs 种子）保留中栏功能、只删面板侧 |

---

## 7. 测试用例清单（交 QA）

### 前端（手动 + 页面验证，铁律 §0.4）
1. 删 D1/D2 后，面板输入框上方 = 4 枚 Action Chips（analyze/reply/deflect/meet），原常用语条消失。
2. 点 chip → 网络面板可见 POST /api/console/assistant 带 intent；aiInput 有内容时 message 含「（意图：x）」。
3. 响应含 analysis/strategy → Accordion 默认收起，点击展开。
4. 响应 replies[] 每条 = 独立话术卡片，右下角有 [填入发送框]。
5. 点 [填入发送框] → msgInput 出现该卡 content（日文），未触发发送，toast 提示「已填入，请检查后发送」。
6. msgInput 已有手改内容时点填入 → confirm「覆盖？」。
7. degraded=true → 降级标签 + chips 灰显，不崩。
8. 旧后端（无 analysis/strategy/replies）→ 新区块不渲染，actions/reply 正常（兼容矩阵 §3.4）。
9. 含 send_message 的响应 → 强副作用确认卡，点击才 send-live（回归既有行为）。
10. 非标准 JSON（后端已按 §5 降级）→ 前端按 degraded=true 渲染，不崩（预审 3 点）。

### 后端（qa-lead，node --test）
11. LLM 返回合法 JSON → 响应 analysis/strategy/replies 字段齐全。
12. LLM 返回 json 代码块包裹 → parseJSON 仍提取成功（容忍）。
13. LLM 返回非 JSON/截断 → actions=[] 且 degraded=true + localFallback（预审 3 点 / §5 铁律 2）。
14. intent=analyze/reply/deflect/meet 四种，system prompt 侧重正确。
15. 无 intent 请求 → 响应含新字段但 actions/reply 与 B v1 黄金样本一致（回归不破）。
16. 脱敏回归：apiKey 不出现在任何 LLM 请求 body / 日志 / prompt（预审 1 点）。

### 兼容（三端联调，基建 task-①② 稳定后总控放行）
17. 旧前端+新后端、新前端+旧后端 两向零破坏（§3.4 矩阵逐格验证）。

---

## 8. 风险与备注

- D4（renderRecs 硬编码话术）越权风险：本稿不删，归 recommender 域，避免 task-5 范围蔓延。
- chips 与 C 阶段多轮状态机（AGENTS §5 C v1）：本稿 intent 是「单轮意图」，C 阶段 sessionId 多轮上线后 intent 可复用为每轮 hint，不冲突。
- localStorage schema（aishist:v1）：本次新增渲染不改动持久化结构；若后续要持久化话术卡片，需升 v2（不在本稿范围）。
- 本稿为纯设计文档，未修改任何前端/后端代码文件。
- **intent→type 映射对齐**（code-reviewer 初审备注）：前端按 type 渲染话术角标的逻辑，待 system-architect 把 intent→type 映射表 + 脱敏白名单扩入 assistant-api-spec.md 定稿后对齐。预期映射：analyze→other（以 analysis 为主）/ reply→followup / deflect→deflect / meet→meet。本稿暂按 §3.1 的 type 枚举渲染，映射表定稿前不改设计稿；code-reviewer 终审 grep 一键填入 handler 时一并核。

---

## 9. 脱敏与铁律约束（code-reviewer 预审 3 点 · 硬卡点）

### 9.1 LLM Prompt 脱敏（预审 1 点）
- apiKey 绝不进 prompt：assistant.js 调 LLM 时 apiKey 只走 HTTP header（Authorization: Bearer），严禁拼入 system/user message、context 对象或任何会被回显的字段。buildContext 返回的上下文不含密钥。
- 客户 PII 进 prompt 评估：三要素中「客户画像」含 age/region/occupation/interests 等结构化字段（spec §5），这些属必要上下文，允许进 prompt；但**原始消息正文中的 PII（手机号/邮箱/真实姓名/住址）需脱敏**。规则：buildContext 组装 recentMessages 时，对 text 做 PII 掩码（手机号/邮箱/邮编 → 部分打码），人设字段仅保留昵称（ともね），不带账号本名/真名。密钥、账号本名、客户真名三类永不出现在 prompt。
- 验证：qa-lead 用例 16 断言 prompt 不含 apiKey；日志脱敏（§6 开发规范「密钥不进 Git」延伸：运行时日志也不落明文 apiKey）。

### 9.2 只填不发（预审 2 点）
- [填入发送框] 严格只写 DOM value + focus + toast，零 fetch、零 send-live、零 #sendButton 触发。发送唯一路径 = 用户手动点 #sendButton 走 ichigoSendExpr（铁律 §0.2 建议→确认→执行）。
- 实现层约束：该按钮 handler 内禁止出现 fetch / send-live / 任何 send 调用；code-reviewer 终审 grep 该 handler 函数体确认无发送路径。
- 强副作用 send_message 动作卡片是另一条独立路径（用户点确认卡 → send-live），与本「填入」功能解耦，两者都不绕过「用户确认」铁律。

### 9.3 非标准 JSON 降级（预审 3 点）
- LLM 返回非标准 JSON（截断/杂字/非 JSON/缺字段）→ 后端 parseJSON 失败 → degraded=true + localFallback（§5 铁律 2），actions=[]，前端按降级渲染。
- 容忍边界：仅容忍 json 代码块包裹与前后空白/注释；结构必须可 JSON.parse，否则一律降级。
- 对应测试：用例 13（后端）+ 用例 10（前端）。
