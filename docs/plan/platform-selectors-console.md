# 规划备忘：平台选择器挪到网页 + 后续路线（2026-11-08 用户裁定）

> 记录性质文档，**不是设计契约**——用户明确「先记录清楚、后续再优化更改，先不改代码」。
> 本期只做：拿到基本个人资料（账户人设抓取已通：ともね/38/津市→三重-津市/全字段可编辑+随机）。
> 本文件冻结「想法 + 现状事实 + 后续路线」，作为下一批次开工的输入。

## 一、用户原始想法（记录原文）

1. **将平台上的选择器挪到我们的网页上**：
   出会平台资料卡（show_profile.html）/检索页上的那些选择项（昵称、生日、身高、风格、
   血型、类型、よく遊ぶ地域（地区）、交際ステータス、出身地、職業、年収、星座、兴趣等），
   目前只能去平台页面手动改。想法 = 把这些「可编辑项」搬到 Ai SAY 网页（账户人设页），
   在网页上直接改 → 由 CDP 代写到平台页面，一步到位。**本期不做，仅记录。**
2. 未填写的字段也先写入占位（已完成：parseAccountPersona 全字段默认 ''，前端橙色"（未填写）"可填）。
3. 随机更换 = 一键随机填**所有**资料（已完成：/account-persona/randomize 日本女性养号池）。
4. 前端可单项真实修改账户人设（已完成：/account-persona/update 26 字段白名单，单项"保存"按钮）。

## 二、现状事实（2026-11-08 代码核对）

| 能力 | 状态 | 位置 |
|---|---|---|
| 账户人设抓取（show_profile.html innerText→26 字段） | ✅ 已落 | server/adapter/ichigoDeepScrape.js fetchAccountProfile + parseAccountPersona |
| 地区 pref-city 补前缀（津市→三重-津市） | ✅ 已落 | 同上 CITY_PREF_MAP |
| 未填写写空占位 / 前端可编辑单项保存 | ✅ 已落 | domain.js loadPersona + /account-persona/update |
| 一键随机全部资料（本地人设池） | ✅ 已落 | /api/console/account-persona/randomize |
| **改平台资料卡本体（CDP 代填+提交）** | ❌ 未做 | 需平台侧可写表达式（ichigo*Expr 系列里尚无 profile-edit 原语） |
| **检索选择器（年龄/地区/排序/页数）真提交** | ❌ 未做（T1 尾巴） | AGENTS §六：/leads/explore search 维度待用户定条件灌 Lead「检索」来源；/card/search 路由不存在 |
| 平台检索页 DOM 结构 | 未测绘 | 会出检索页选择器的选择器清单未记录（快乐侧已测绘 §十，会出侧没有） |

## 三、铁律边界（做任何一期实现前必须遵守）

- **铁律 0.1/0.2**：改平台资料卡 = 写平台强副作用 → 走「建议 → 确认 → 执行」，AI 永不直接提交；
  前端只能出「待确认」卡片，用户点头才 CDP 执行。
- **§-1.3 三要素隔离**：AccountPersona（本地人设）≠ 平台资料卡（平台侧）；本期做的随机/单项编辑
  全部只写本地表，**不影响平台**——这点必须在前端文案里说清，避免用户误以为改了平台。
- **窗口手动控制模式（§六）**：CDP 代写要窗口已开（手动开关，非自动 /browser/open）。
- 发送/删帖类既有铁律不变。

## 二.5、第二阶段·资料池（2026-11-09 用户裁定，本期开工项）

> **P1（平台资料卡代写）延后**，先做「第二阶段：从线索池转化资料池」。
> 触发方式：**手动**（用户从线索池筛选并选择 → 抓取 → 进资料池）。

### 用户原始裁定（记录原文）
1. 资料卡由**线索池筛选并选择后**再进行抓取（不自动全量爬）。
2. 资料池里可分 **未抓取 / 已抓取** 两态。
3. 若收件箱里**已有消息历史**（我发给他的、或他发给我的，只要有记录即算）→ 资料池标 **已沟通**。
4. 资料池标注**来源**：对方浏览（ashiato）/ 对方点赞（like）/ 帖子（bbs）/ 首页检索（search）等（= Lead.sourceDim）。

### 现状事实（2026-11-09 代码核对）
- **Lead 表已就绪**（005_lead.sql.js v50）：通用字段 name/age/region/online/avatarUrl/profileUrl/selfIntro
  + sourceDim（search/ashiato/like/bbs/faces/unknown）+ contactedAt + extras JSON（refine-crawl 已能写
  资料卡深度字段进 extras）。
- **「已沟通」判定数据源**：Conversation + Message（按 contactId）。card-leads 已有未回复双源查询
  （最后一条 Message.role='other' ∪ Conversation.unread>0）。资料池"已沟通"= 该 lead 对应 contactId
  在 Conversation/Message 有 ≥1 条记录（不区分方向、不限未读）。
- **Lead ↔ Contact 关联键**：Contact 表无 accountId/contactKey 列（M0 归一身份），用 displayName +
  contactId 去重；Lead 无直接 contactId 外键，需按 name(+region+age) 弱匹配或靠 contactId 回填。
- **「资料池」概念尚不存在**：无表、无路由、无前端菜单（AGENTS 无此提法）。需新建。

### 待设计（动代码前需用户裁定 2 点）
见下方「开工前裁定」第 1/2 条。

## 四、后续路线（按优先级排序，待用户逐条点头后再动代码）

### P1 · 平台资料卡「网页改 + CDP 代写」（用户的原始想法）
1. 测绘：CDP 只读 dump show_profile.html 的表单 DOM（字段 id/name、下拉选项值、保存按钮），
   产出一份「会出 profile 可写原语表」（仿 happy*Expr，存 docs/survey-* 存档）。**只读，不点保存。**
2. 原语：新增 server/adapter/ichigoProfileEditExpr.js（按 DOM 写表达式：填昵称/选下拉/写身高/保存），
   每个原语默认 dryRun（只读回填预览，不 submit）。
3. 路由：POST /api/console/account-persona/apply-to-platform（body=patch 字段）→
   校验白名单字段 → 组装 CDP 表达式 → dryRun 预览 → 返回「待确认」卡片（前端展示将要改什么）。
4. 确认：用户点确认 → 执行 submit + 读回校验（重新抓一次 show_profile 对比）→ 写 OperationLog 审计。
5. 回退：每次提交前快照旧值（extras 存 prev 值），失败/反悔可一键回写旧值。
6. 测试：os.tmpdir fixture + 只读验证（铁律 4：真发相关只读验证，不实提交）。

### P2 · 检索选择器挪网页（T1 尾巴，AGENTS §六）
1. 用户定检索条件（年龄/地区/排序/页数）→ 网页下拉/输入框（会出检索页真实选项先 CDP 只读测绘）。
2. POST /api/console/card/search（或 /leads/explore?dim=search&params）真提交检索 → 灌 Lead「检索」来源。
3. 前端线索池页已有「侦测目标 出会/快乐 + 维度」下拉，search 维度补参数面板。

### P3 · 任务编排挂窗口启动（§六 待办 2）
- breathEngine 唤醒任务时 POST /window/open（替代手动开关的第二入口）——与「手动控制模式」
  边界需用户裁定：引擎代开窗是否违反 §六（当前裁定：窗口只能控制台按钮/二期编排启动，编排=合法第二入口）。

### P4 · 任务日报看板（§六 待办 4）
- 来源分布/完成情况/人工介入提醒（high_intent 置顶+声音），放「看板」菜单（§1.10 延后项归位）。

### P5 · 快乐 18595 维度探测（§六 待办 5，二期）
- 快乐侧 4 路客源已通但当前全空；平台有数据即自动灌库，无需新代码，只需定期巡检测试。

## 五、开工前置（用户裁定）

### 资料池（第二阶段）开工前 2 条
1. **资料池存储形态**：
   (a) 新建独立表 `Profile`（leadId 关联 Lead，存抓取状态/已沟通/来源快照）——推荐，数据独立、好查；
   (b) 不建新表，资料池 = Lead 表 + `extras.pooledAt`/`extras.crawlStatus` 标记的筛选视图（轻量，不新增表）。
2. **"已沟通"判定口径**：按 Lead.name 匹配 Contact.displayName（弱匹配，可能误配/漏配），
   还是 Lead 灌库时就回填 contactId（精确，但要改 explore/explore-happy 灌库逻辑补 contactId）？

### 原 P1 前置（P1 延后，暂不裁定）
1. 平台资料卡改动是否只允许改「账户人设页」这几个字段，还是含照片/自我介绍正文？（照片=生成+上传，成本高）
2. 代写前快照回退的保留期（建议 7 天）。
3. 检索条件（P2）：用户要按什么 年龄/地区/排序/页数 灌会出 Lead 检索来源？
4. 引擎代开窗（P3）是否放行？

---
*状态：记录冻结（资料池第二阶段为下一开工项，P1 延后）。动代码前读本文件 §二.5 + §五 资料池 2 条裁定。*
