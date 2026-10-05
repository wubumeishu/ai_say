# 02 · 数据模型 / 自动画像 / 去重合并

> 本章是《Ai SAY 项目计划书》第二部分：定义新版统一数据 schema、自动画像抽取规则、跨窗口/跨平台客户去重合并策略，以及现有 data/*.json 到新模型的迁移映射。
> 实体命名与 01-architecture（消息总线/会话聚合器/画像抽取器/去重闸门）、03-acquisition（LeadEvent、LineMember、Unified Profile、标签体系）、04-roadmap（M0 SQLite、M1 画像、M2 聚合）严格对齐。

---

## 1. 新版数据 Schema

设计原则：

- **客户视角主键**：客户以「稳定身份锚点」为真主键，旧的 平台+窗口+标签 三元组降级为「观测源」（observation），不再当主键。
- **单一写入路径**：所有实体写操作都经过 01 章描述的「画像抽取器（去重闸门）」，保证去重在写入前完成。
- **消息只追加、档案可合并**：消息流水不可变；客户档案可以 merge，每次 merge 写一条 mergeEvent 可审计。
- **兼容期**：M0 用 SQLite 落地，旧 JSON 经 legacyKey 映射并存，不破坏现有 server/ 脚本。

### 1.1 实体总览

| 实体 | 作用 | 真主键 | 与旧三元组关系 |
|---|---|---|---|
| Account | 平台账号（一个登录身份，可挂多窗口） | accountId | 旧 windowId 升级为「账号下的窗口实例」 |
| WindowInstance | 账号在某个浏览器窗口里的实例 | windowId | 旧三元组里的 windowId 直接保留 |
| Contact | 客户（跨窗口去重后的画像载体） | contactId（锚点哈希） | 旧 contactKey/label 降级为「候选键」 |
| ContactAnchor | 客户稳定身份锚点（强/弱） | anchorId | 新增，替代三元组作真主键 |
| Conversation | 会话（某账号 ↔ 某客户，按渠道） | conversationId | 旧 conversations.json 一条记录 |
| Message | 消息（原文/译文/角色/时间） | messageId | 旧 conversations[].messages |
| ContactProfile | 客户画像（自动抽取字段） | contactId | 旧 contacts[].contact 结构化 |
| LeadEvent | 引流事件（评分/触发动作/结果） | leadEventId | 03 章的评分落库载体 |
| LineMember | LINE 私域成员 | openId | 03 章的 OA 成员 |
| LineBind | 平台客户 ↔ LINE 成员绑定 | bindId | 03 章的 phone/openId 三键绑定 |
| Tag | 客户标签（五层体系） | tagId | 03 章五层标签 |
| MergeEvent | 客户合并审计记录 | mergeEventId | 新增 |
| AccountPersona | 账号人设（账号本体：人设/语气/背景/目标人群/禁忌），与 ContactProfile 严格分离 | accountId | 新增，挂在 Account 下 |
| GovernanceRule | 统一规则（合规红线/话术边界/频控/品牌口径），全局生效，独立于账号人设与客户画像 | ruleId | 新增，全局一等实体 |

### 1.2 核心字段定义（精简版）

```
Account
  accountId   string  pk（归一化邮箱/手机号/平台内ID）
  platform    enum    (出会 / LINE / FB / WhatsApp / …)
  label       string  运营可读名
  status      enum    active | suspended | banned
  createdAt / updatedAt

WindowInstance
  windowId    string  pk（BitBrowser 窗口 ID）
  accountId   string  fk → Account
  seq         int
  lastHealth  timestamp

ContactAnchor
  anchorId    string  pk
  contactId   string  fk → Contact
  kind        enum    strong | weak
  value       string  邮箱 / LINE openId / 手机号 / 设备指纹 / 平台内ID
  confidence  float   0-1
  source      string  首次来源渠道

Contact
  contactId   string  pk（= 强锚点哈希，或归一化名+特征）
  displayName string
  nickname    string  旧 label
  mergedInto  string? fk → Contact   账号归并指针（保留历史）
  firstSeen / lastSeen  timestamp
  lifecycle   enum    new | active | silent | churned

ContactProfile（客户画像，独立于账号人设；字段从自动抽取器来，无需人工录入）
  contactId   pk
  age / region / height / occupation / language   抽取字段
  intent      enum    casual | serious | transactional | unknown
  interests   json
  historySummary string   历史对话摘要
  confidence  float   整条画像置信度
  updatedAt

Conversation
  conversationId  pk
  accountId       fk → Account
  contactId       fk → Contact
  channel         enum    platform_dm | line | fb | whatsapp
  status          enum    open | closed | archived
  lastActiveAt

Message
  messageId / conversationId fk
  role  enum  me | other
  original / translation / time
  createdAt   （只追加，不更新）

LeadEvent（03 章评分载体）
  leadEventId pk
  contactId fk
  score  int 0-100
  tier   enum hot | warm | cold
  signals json   命中的会话信号
  action enum triggered | reminded | archived
  lineOffered bool / lineAdded bool
  createdAt

LineMember
  openId pk
  displayName / region
  lineTag    json
  bindPhone  string?
  silentDays int    静默天数（03 章 30 天移出）

LineBind
  bindId pk
  contactId fk → Contact
  openId    fk → LineMember
  joinKey   enum  phone | openId | deviceId
  confidence float
  createdAt

Tag
  tagId pk
  layer  enum  source | intent | category | status | ops   （03 章五层）
  value  string
  appliedTo json   contactId/openId 列表

MergeEvent
  mergeEventId pk
  survivorContactId / mergedContactId
  reason  string
  anchorKind strong | weak
  createdAt

AccountPersona（账号本体的人设，与 ContactProfile 严格分离）
  personaId   pk
  accountId   fk → Account   （同一账号跨平台多窗口共用一份人设）
  persona     json   人设设定（身份/背景故事/口吻基调）
  tone        string  语气风格标签（如「温和」「爽朗」「毒舌」）
  background  string  账号背景设定
  targetAudience string 目标人群描述
  taboos      json   禁忌词/禁忌话题列表
  createdAt / updatedAt
  status      enum  active | draft

GovernanceRule（统一规则，全局生效，独立于账号人设与客户画像）
  ruleId      pk
  ruleType    enum  compliance | speechBoundary | rateLimit | brandTone
  scope       enum  global | platform | account | channel
  scopeKey    string?  当 scope=platform/account/channel 时的具体值
  rule        json   规则体（阈值/关键词/话术边界描述）
  priority    int    高数字覆盖低数字；global 默认 0，platform 10，account 100
  status      enum  active | draft | deprecated
  effectiveFrom / effectiveTo  timestamp?  （可设临时窗口）
  createdAt / updatedAt
  下发契约：④/⑤ 引擎生成外发内容前按 scope 叠加查询（global ⊃ platform ⊃ account，高 priority 胜出）；
             compliance 类未命中默认拒绝，其余默认放行。变更写 auditLog，控制台可一键回滚。
```

---

## 2. 自动画像抽取（无需人工录入）

目标（04 章 M1 验收）：新会话 60s 内自动补全 ≥10 个画像字段，准确率 ≥90%，intent 无空值。

### 2.0 画像建立顺序（资料页优先，固定两步）

抽取器消费的数据源有固定优先级，**不可颠倒**：

| 步骤 | 数据源 | 产出 | 说明 |
|------|--------|------|------|
| 第一步 | 平台资料页（`profileScan` / `profileInspector`，17098 分组：基本/详细/兴趣/成人交友） | **基础画像**（昵称/年龄/地区/兴趣/交友状态等页面可观测字段） | 客户首次被识别即执行，平台已校验的结构化数据，置信度最高 |
| 第二步 | 聊天消息流（①消息总线 → ②会话聚合器） | **细节补充**（意图/历史偏好/回复习惯/资料页未覆盖字段） | 只补不删；与第一步字段冲突时按置信度取高值（§3.2） |

- 第一步的输出直接 `upsert` 到 `ContactProfile`，标记 `source=profile_page`；
- 第二步的输出 `upsert` 到 `ContactProfile`，标记 `source=chat`，同字段冲突走 §3.2 置信度规则；
- 该顺序与 01 章 §3.5、04 章 M1 验收口径一致；账号资料页（AccountProfile 观测源）仅喂给 AccountPersona 侧，**不污染客户画像**。

### 2.1 抽取器管线

```
[第一步] 资料页观测流（profileScan / profileInspector）
  → 页面字段结构化（17098 分组）→ 基础画像 upsert（source=profile_page）
[第二步] 会话消息流
  → 分渠道抽取器（平台私信 / LINE 各一套，复用 04 章 adapter 的 scanMessages）
  → 结构化字段槽（年龄/地区/身高/职业/语言/意向/兴趣，仅补资料页未覆盖字段）
  → 置信度加权（多轮证据累加）
  → 去重闸门（见 §3.1，写入前归并）
  → upsertContactProfile（单一写入路径，source=chat）
```

### 2.2 字段抽取规则

| 字段 | 信号 | 示例 | 置信度来源 |
|---|---|---|---|
| age | 正则 数字+歳 / "XX岁" / 出生年 | "38岁" | 直接自述=高 |
| region | 地名词典 + 平台字段 | "埼玉" / "Tokyo" | 自述=高，页面字段=中高 |
| height | 正则 数字+cm | "170cm" | 自述=高 |
| occupation | 职业词典 + 关键词 | "自営" / "会社員" | 自述=中高 |
| language | 语言识别 | 日/中/英 | 自动=高 |
| intent | 关键词 + 行为 | 询价/留LINE/约见 → serious | 规则=中 |
| interests | 兴趣标签词典 + 历史 | 兴趣字段 group（17098） | 页面字段=中高 |
| historySummary | 对话摘要（可选 LLM） | "上次聊到价格…" | LLM=中高，规则兜底 |

- 抽取器**不直接写 DOM / 不抓界面**，只消费 adapter 已结构化的消息/字段（04 章 engine 不写 DOM 的边界）。
- 页面字段（profile_17098_fields.md 的分组：基本/详细/兴趣/成人交友）作为「页面观测源」，与聊天自述互补；同字段冲突取高置信度。

---

## 3. 客户去重合并（跨窗口 / 跨平台）

这是整章核心：让同一客户在两个窗口、两个平台是**同一条**，不再重复。

### 3.1 归并键分层

| 层级 | 键 | 判定 | 处理 |
|---|---|---|---|
| 强锚点 | LINE openId / 手机号 / 邮箱 / 设备指纹 | 命中即同客户 | 直接 merge（写 mergeEvent） |
| 平台内 ID | 平台唯一客户 ID | 同平台内强 | 同平台直接 merge |
| 弱锚点 | 归一化姓名 + 年龄 + 地区 | 高相似 | 进 likelySame 待确认队列，不自动合并 |
| 行为特征 | 语言 + 意向 + 时间窗 | 低相似 | 仅打标，不合并 |

### 3.2 合并规则

- **消息只追加**：merge 后历史消息全部保留，不丢消息。
- **档案取高置信度**：冲突字段按 confidence 取高；都空则保留幸存者。
- **账号归并**：Account 用 mergedInto 指针保留历史窗口实例，不物理删除。
- **可审计**：每次 merge 写 MergeEvent（survivor / merged / reason / anchorKind）。
- **误并防护**（04 章验收：误并 ≤5%、漏并 ≤10%）：
  - 弱锚点永不自动合并，只进人工确认队列；
  - 强锚点命中但「平台+地区」明显矛盾时降级为弱锚点，触发复核；
  - 合并可一键回滚（写反向 mergeEvent）。

### 3.3 跨平台打通（平台私信 ↔ LINE）

- 绑定键优先级：手机号 > LINE openId > 设备指纹（03 章 phone join key、openId 兜底）。
- LineBind 命中即把平台 Contact 与 LineMember 关联，形成 Unified Profile；
- 未命中（客户不给手机号）→ 降级用 openId/设备指纹，记 confidence 低，进 likelySame。

---

## 4. 现有 data/*.json 迁移映射

M0 用 SQLite 落地，保留 JSON 导入/导出兼容现有脚本（04 章 M0 可验收标准 1）。

| 现有 | 字段路径 | 新模型目标 |
|---|---|---|
| account-profiles.json | key=三元组 / windowId / platform / nickname | WindowInstance + Account（三元组拆成 观测源） |
| account-profiles.json | fields[] / sections[] / lines[] | ContactProfile（页面观测源字段，按 17098 分组） |
| contacts.json | key=三元组 / contactKey / contact{…} / profileUrl | Contact + ContactProfile + ContactAnchor（contactKey 降级候选键） |
| conversations.json | key=三元组 / contactName / messages[] | Conversation + Message + Contact（三元组拆观测源） |
| — | （新增） | LeadEvent / LineMember / LineBind / Tag / MergeEvent |

迁移步骤（可逆）：
1. 读现有 3 个 JSON，按三元组解析出 平台/窗口/标签。
2. 为每条建 Contact（弱锚点：归一化名+特征），写 legacyKey=旧三元组 到 ContactAnchor(kind=weak)。
3. Account 按 platform+窗口归并（同窗口同平台去重）。
4. 全量导入 SQLite；保留 legacyKey 字段，旧 JSON 导出器可按 legacyKey 还原等价结构。
5. M2 起强锚点（LINE/手机）陆续上线，把弱锚点 Contact 逐条升级为强锚点并触发 §3 合并。

---

## 5. 与相邻章节的接口

- 读 01：单一写入路径 + 去重闸门是本章 §2/§3 的执行位置；§3.5 资料页优先顺序与 §3.6 GovernanceRule 全局规则是本章 §2.0 / §6 的依据。
- 写 03：LeadEvent / LineMember / LineBind 是 03 章评分与绑定落库的 schema 载体。
- 写 04：本章 schema 是 M0 的落地对象；§2.0 两步法对齐 M1 验收（资料页优先建基础画像，聊天补细节）；§3 指标对齐 M2（误并 ≤5%）。

---

## 6. 账号人设 / 统一规则的存储与下发契约

> 对应 01 章 §3.2（分离原则）与 §3.6（GovernanceRule）。本节定义两个新增实体在数据层的落地方式。

### 6.1 AccountPersona（账号人设，独立于客户画像）

- 挂在 `Account` 下，**不挂 Contact**；同一账号跨平台多窗口共用一份人设；
- 字段（§1.2）：`persona / tone / background / targetAudience / taboos`；
- 合并规则：账号归并（§3.2 前半）时，`AccountPersona` 随 `Account.mergedInto` 指针一起保留，**不做客户画像式字段合并**（人设是账号属性，无跨账号合并语义，最多人工指定 survivor）；
- 与 `ContactProfile` 的隔离：两套实体表无外键、无共享字段，代码层通过 `upsertContactProfile` / `upsertAccountPersona` 两条独立写入路径保证。

### 6.2 GovernanceRule（统一规则，全局生效）

- 字段（§1.2）：`ruleType / scope / scopeKey / rule / priority / status / effectiveFrom / effectiveTo`；
- 下发契约：
  - ④推荐/引流引擎与 ⑤LINE 适配器在生成任何外发内容前，调用 `getEffectiveRules({accountId, platform, channel})`；
  - 规则按 `scope` 叠加：`global ⊃ platform ⊃ account`，同层多条规则取 `priority` 最高者；`effectiveFrom/To` 在窗内的规则才参与；
  - `compliance` 类未命中默认**拒绝**，其余默认**放行**；
  - 命中结果与规则 id 写入 `LeadEvent.signals` 或消息级审计日志，可追溯「这条话术被哪条规则约束过」。
- 变更管理：规则增改统一经 ⑥控制台（M5）走 `saveGovernanceRule` API，每次变更写 `auditLog`（操作人 / 时间 / 旧值 / 新值），支持一键回滚到上一版本（保留 `status=deprecated` 的历史行）。

### 6.3 与现有 data/*.json 迁移

| 新增实体 | 迁移来源 | 说明 |
|----------|----------|------|
| AccountPersona | 无（全新） | M0 建空表；M1/M5 由运营在控制台补录 |
| GovernanceRule | 无（全新） | M0 建空表并预置 3–5 条 `compliance` 全局红线；M5 开放增改 |

两实体不参与 M0「3 个 JSON 100% 导入」验收（验收对象仍是 Account/WindowInstance/Contact/ContactProfile/Conversation/Message），但表结构在 M0 一次性建好，避免后续 DDL 迁移。
