# docs/plan/console-routes-split.md · consoleRoutes.js 域拆分方案 + API 协议规范

> 作者：System_Architect（架构评审稿，非实现代码）
> 依据：AGENTS.md §1.7（用户同意拆分 1682 行单体）、§6（新增代码按域放新文件）、docs/API.md
> 现状：server/consoleRoutes.js 已长到 **1745 行**，47 条路由挤在单文件；AGENTS.md §7 Phase 4 明确「拆 consoleRoutes/前端」。
> 目标：按域拆为 **7 个模块 + 1 个路由注册中枢**，每个文件 ≤ 300 行，API 契约不变（前端零改动），并为 Phase 4 看板/事件驱动留边界。

---

## 1. 域划分（按 URL 前缀 + 依赖注入对象双维切分）

| 模块文件 | 路由 | 依赖注入（deps） | 行数预估 |
|---|---|---|---|
| consoleRoutes/customers.js | GET customers / customers/:id / customers/:id/profile / tags | store, deepScrape | ~230 |
| consoleRoutes/accounts.js | GET accounts / accounts/:id / account / account/refresh / account/update | accountInfo, deepScrape, store | ~110 |
| consoleRoutes/live.js | GET live / live/deep / live/customers / live/customer / mailbox / customer/read / customer/refresh | liveScanner, deepScrape, ichigoCache | ~190 |
| consoleRoutes/translate.js | translate / translate/batch / translate/stats / translate/clear / phrases*（常用语 4 条） | translationCache, consolePrefs | ~180 |
| consoleRoutes/models.js | model-status / models*（CRUD+activate+test）/ model-config | modelStore | ~140 |
| consoleRoutes/governance.js | rules / rules/rollback / likely-same / pending-queue / audit | store, talkEngine, dedup | ~230 |
| consoleRoutes/actions.js | **assistant / send-confirm / send-live / proxy/* / network/health / private-domain** | assistant, proxyPool, deepScrape, ichigoCache, talkEngine, settingsForLive | ~250 |
| consoleRoutes/index.js | 中枢：组装 deps、逐域 mount、统一 404/错误包装、导出 mountConsoleRoutes(app, deps) | 全量 | ~90 |

> 切分原则：**同一注入依赖聚一文件**（customers 和 live 都读 ichigoCache 但归属不同，因为 live 域的本质是 CDP 通道，customers 域本质是 DB 快照视图——保持语义边界优先于依赖去重）。

### 关键边界裁定
1. **send-live 归 actions.js，不归 live.js**：live.js 只读（抓页面 → 写缓存）；send-live 是唯一「页面写操作 + 平台副作用」端点，与 proxy 换 IP、assistant 动作卡片同属「有副作用的动作域」，审计/频控/闸门（Phase 3.12 补）也统一加在这里。
2. **proxy/* 与 network/health 同域**：体检是换 IP 的驱动源，两者共享 deepScrape.networkHealth() 通道，拆开会跨文件调用。
3. **governance.js 包含 audit 聚合查询**：audit 端点直连 db.prepare（绕 store 的已知坑 §3.4 同类问题），拆分后此处 SQL 集中治理，QA 回归范围可控。

## 2. 迁移顺序（零中断，每步可独立验证）

1. 先建 consoleRoutes/index.js 中枢 + 空壳 7 域文件，mountConsoleRoutes 委托各域 register(app, deps)；原 1745 行文件逐域 cut-paste 搬移，**一次搬一个域即跑全量 23 测试 + 冒烟 /ichigo-console 页面**（铁律 §0.4）。
2. 搬完 7 域 → 删除原单体 consoleRoutes.js → 更新 server/index.js 的 require 路径。
3. 每域文件头注释写明「本域 deps 契约 + 端点清单」，作为 Frontend_Lead/QA 的契约源（替代现在只在头部注释里的清单）。

## 3. API 协议规范（拆分后仍生效的统一契约）

- 统一包装：`json(res, code, data)` 上提到 index.js 中枢，各域不得自定义响应结构；成功 `{ ok:true, data?, ... }`，失败 `{ ok:false, msg, reason? }`。
- 501 语义统一：deps 未注入 → `501 + msg 说明缺什么`（现网行为，拆分不改）。
- send-live 新增契约（Phase 3 补闸门前）：响应保留 `data.step / data.sent / data.returnedToInbox / data.messagesRefreshed`；**新增审计字段** `audit: { sentLogId, sentAt, textLen }`（为 Phase 3.12 频控账本持久化预留，当前先写内存账本 + 落 data/sent-log.json，DB 化留 M4）。
- assistant 契约不变（B v1 已定稿）：`POST /api/console/assistant` → `{ ok, degraded, reason, reply, actions:[{type,label,payload,sideEffect,needConfirm?}], contact, fetchedAt }`；C 阶段（多轮）通过 **新增** `?sessionId=` 查询参 + `data.sessionId` 响应字段演进，不破坏 B 契约。

## 4. C 阶段（v2）演进预留
- 多轮状态机：consoleRoutes/assistant-session.js 新域（不动 B 的 actions.js 入口），session 持久化用 SQLite 新表 AssistantSession（schema 走 DBA，不写业务代码）。
- 批量确认卡：actions 数组支持 `batch: true`，前端渲染分组卡片；后端仍逐条走 send-live（铁律：LLM 永不直接发送，批量也是「建议 N 条 → 用户逐条/整批确认」）。
- 事件驱动（替代前端 30s 轮询 locator-misses / metrics）：中枢加 `GET /api/console/events?cursor=`（SSE 或长轮询），归 Phase 4 看板，本方案不实现，只留边界。

## 5. 风险与验证
- 切路由匹配：index.js 的 matchConsoleRoute 目前只硬编码 customers/accounts 的 :id 段 → 拆分后参数段路由统一改由中枢的 **前缀路由表**（每域声明 prefix + 参数模式）处理，消灭正则特判。
- 验证口径（铁律 §0.4）：每步 node --test 全量 23 文件；前端 /ichigo-console + /console 冒烟；send-live 只读验证（抓历史/查缓存），不真发。
