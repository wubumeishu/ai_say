# Ai SAY · 项目总览（按客户统一运营的长期系统）

> 现状：比特浏览器窗口监控 + DevTools 消息翻译/推荐回复（0.1.0）。
> 目标：演进为「按客户统一运营 + 自动画像 + 自动引流 + LINE 私域 + 卡片式控制台」的长期运营系统。

## 四条不可动摇的设计原则
1. 画像建立顺序：**先读资料页建基础画像，再从聊天补充细节**（两步法，profile_page 胜出）。
2. **账号人设（AccountPersona）与客户画像（CustomerProfile）严格分离**：前者描述账号本体，后者独立于账号。
3. 沟通语境 = **账号人设 + 客户画像 + 统一规则**（账号 #1 与客户 A = #1 人设 + A 画像 + GovernanceRule）。
4. **统一约束与规则（GovernanceRule）全局生效**：无论 1 账号还是 N 账号，合规红线/话术边界/频控/品牌口径一致。
5. 数据只追加、合并可审计可回滚；画像与去重走「单一写入路径」。

## 里程碑进度
| 里程碑 | 内容 | 交付物 | 验收 |
|---|---|---|---|
| **M0 数据模型** | 15 表 DDL + 可逆迁移 + SQLite store | [server/db/schema.sql](../server/db/schema.sql)、[migrate.js](../server/db/migrate.js)、[store.js](../server/db/store.js)、[m0-contract.md](m0-contract.md) | ✅ 3 JSON 100% 导入、round-trip diff 空、幂等、API 探针 7/7 |
| **M1 自动画像** | 资料页优先抽取器 + 意向评分 | [profileExtractor.js](../server/db/profileExtractor.js)、[leadScoring.js](../server/db/leadScoring.js) | ✅ 14 字段槽（≥10）、profile_page 胜出、enriched 标记、hot/warm/cold |
| **M2 跨平台聚合** | 去重归并 + 平台适配器 | [dedup.js](../server/db/dedup.js)、[server/adapter/](../server/adapter/) | ✅ 强/弱锚点分层、误并护栏、回滚可审计、4 方法契约 + 定位规则数据化 |
| **M3 自动引流** | 话术引擎 + LINE OA 服务端 | [talkEngine.js](../server/acquisition/talkEngine.js)、[lineOa.js](../server/acquisition/lineOa.js) | ✅ 10+16 自检全绿、合规闸门、A/B z 检验、签名校验 |
| **M4 LINE 私域** | 接真实 LINE 官方凭据 | [lineOa.js](../server/acquisition/lineOa.js)（已 mock） | ⏸ 阻塞：需老板提供 channelAccessToken/Secret/webhookSecret（见 [m4-handoff.md](m4-handoff.md)） |
| **M5 控制台** | 卡片式控制台 + 指标看板 | [public/console.html](../public/console.html)+.js+.css、[consoleRoutes.js](../server/consoleRoutes.js) | ✅ 9 条 /api/console/*、四大指标看板、DOM 告警、话术回滚 |

## 全链路验收证据（Lead 实测）
- **50/50 自检全绿**（node --test server/db/*.test.js + server/acquisition/*.test.js）：
  - profileExtractor 9 + leadScoring 8 + dedup 7 + talkEngine 10 + lineOa 16
- **M0 round-trip diff 为空** + 幂等（Contact 2→2、Message 17→17）
- **全部模块 require 加载成功**（store / profileExtractor / leadScoring / dedup / createAdapter / talkEngine / lineOa / consoleRoutes）
- 旧生产代码 [server/store.js](../server/store.js)、[server/app.js](../server/app.js)、[public/index.html](../public/index.html) 均未改动（新代码全部增量，共存可回退）

## 计划书与提示词
- 总览：[00-README.md](00-README.md) · 架构 [01](01-architecture.md) · 数据 [02](02-datamodel.md) · 引流 [03](03-acquisition.md) · 路线图 [04](04-roadmap.md)
- 团队长期目标提示词：[agent-prompts.md](agent-prompts.md)

## 团队架构（Agent Teams）
Lead（统筹）→ 5 个执行角色：
- **architect**（架构组）：M0 数据 + M2 去重
- **engine**（引擎组）：M1 画像 + 评分（复用 datamodel 队友）
- **adapter**（适配组）：M2 平台适配（复用 roadmap 队友）
- **acquisition**（引流组）：M3 话术 + LINE（复用 acquisition 队友）
- **ui**（前端组）：M5 控制台（复用 summarizer 队友）

> 测试/一次性队友（cleaner / bak-consolidator / tool-reorganizer）已退役；M4 解锁后 acquisition 接真实 LINE 凭据即可上线。

## M1 收尾 · 推荐回复 LLM 个性化（已验收）
- [recommender.js](../server/db/recommender.js)：hot 客户走 aiService.chatCompletion（对齐真实入参），AI 未配置/失败/空输出 ⇒ 降级 talkEngine 模板（绝不卡死）；warm/cold 走模板省 token；每条回复过 GovernanceRule 合规闸门。
- [recommender.live.test.js](../server/db/recommender.live.test.js)：本地 mock LLM（http server 模拟 OpenAI）9/9 全绿——证明三要素（人设+画像+规则）真进 system prompt、敏感词被 gateReply 拦、合规生成 source='ai'+LeadEvent、LLM 空输出降级不卡死。
- [recommender-live.md](recommender-live.md)：真实 LLM 接入说明（老板给 API key+baseUrl+model 后 settings.json 怎么配 + 4 级降级链 + 合规双保险）。
