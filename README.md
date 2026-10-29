# Ai SAY

出会平台（sp.194964.com，イククル）运营控制台：监控比特浏览器窗口，抓取收件箱/历史/资料，
翻译消息、画像客户、生成推荐话术，人工确认后真发消息，未来沉淀 LINE 私域。
账号人设：ともね（女，38 岁）。

## 核心能力

- **客户监控**：比特浏览器窗口连接状态 + 收件箱轮询（三层缓存，避免重复抓取）。
- **翻译**：日⇄中 LLM 翻译，内容寻址缓存；模型不可用时降级本地规则兜底。
- **推荐话术**：人设 + 客户画像 + GovernanceRule 规则驱动（[recommender.js](server/db/recommender.js)）。
- **Ai SAY 助手（面板 B v1）**：自然语言对话 + 工具白名单；发送类动作只出确认卡片，绝不自动发。
- **发送（人工确认才发）**：send-live 页面真发；send-confirm 走合规闸门 + 频控。
- **网络与代理基建**：网络体检归因（网络/平台/CDP）+ IPDeep 代理池 v1（粘性 IP、事件驱动换 IP）。
- **指标 / 审计 / 回滚**：四大指标看板、话术审计、一键回滚。

## 快速开始

前置条件：

1. **比特浏览器**客户端已启动，本地 API 可用（默认 http://127.0.0.1:54345 或 54346）。
2. Node.js（项目按 Node 24 开发）。

启动（Windows）：

```bat
start-console.bat
```

该脚本先清理 8300 端口上的旧实例，再前台启动 `node server/index.js`。
启动成功后访问：

- 主控制台 http://127.0.0.1:8300/ichigo-console
- 卡片式控制台 http://127.0.0.1:8300/console

停止：stop-console.bat（或在 cmd 窗口 Ctrl+C，SIGTERM/SIGINT 均会优雅退出）。

命令行等价方式：

```bash
npm install          # 依赖仅 ws
npm start            # 或 node server/index.js
# 可选环境变量：PORT（默认 8300）、HOST（默认 127.0.0.1）、BIT_BROWSER_API_URL
```

## 配置

- [settings.example.json](settings.example.json) 是配置模板；实际使用 settings.json（含明文
  apiKey，**已 .gitignore，绝不进 Git**）。
- 字段：apiBase / bitBrowserApiPort（比特浏览器 API）、windowId（出会窗口 id）、
  model（provider / baseUrl / model / apiKey）、models[]（多模型）+ activeModelId。
- 也可通过控制台 API 管理模型（/api/console/models/*）并写回 settings.json。

## 数据与存储

- SQLite：data/aisay.db（客户 / 画像 / 会话 / 规则 / LeadEvent，schema 见
  [server/db/schema.sql](server/db/schema.sql)）。
- 三层缓存：data/console-cache.json（收件箱快照 / 历史 / 资料）。
- 旧轨 JSON：data/*.json（/api/* 路由，与 SQLite 双轨，待统一）。
- 代理池：data/proxy-pool.json + proxy-secrets.json（**手动维护，不进 Git**）。
- 数据目录整体 .gitignore：客户数据、密钥、日志、备份一律不上库。

## 测试

```bash
# 全量 16 个测试文件（npm test 只跑其中 4 个，务必手动全量）
node --test tests/*.test.js \
  server/db/recommender.test.js server/db/recommender.live.test.js \
  server/db/leadScoring.test.js server/db/dedup.test.js server/db/profileExtractor.test.js \
  server/acquisition/talkEngine.test.js
```

- 现有 16 个测试文件（tests/ 10 个 + 模块内 6 个），必须全量跑，不只跑 npm test 的 4 个。
- 新测试用 os.tmpdir()，不要在 data/ 留文件。

## 项目结构

| 路径 | 职责 |
|---|---|
| [server/index.js](server/index.js) | 入口（8300 端口），组装 store/talkEngine/liveScanner/deepScrape，挂 console 路由 |
| [server/consoleRoutes.js](server/consoleRoutes.js) | 全部 /api/console/* 路由（拆分中） |
| [server/app.js](server/app.js) | 旧 /api/* 路由（JSON 存储，与 SQLite 双轨） |
| [server/adapter/ichigoDeepScrape.js](server/adapter/ichigoDeepScrape.js) | 收件箱/历史/资料抓取（页面内 fetch 零导航）+ sendToContact + navigateInbox |
| [server/adapter/ichigoSendExpr.js](server/adapter/ichigoSendExpr.js) | 真发页面脚本（textarea → #sendButton → 确认弹窗 → #submitBtn） |
| [server/adapter/ichigoCache.js](server/adapter/ichigoCache.js) | 三层缓存 |
| [server/acquisition/talkEngine.js](server/acquisition/talkEngine.js) | 话术引擎 + 闸门 + 频控 + 待确认队列 |
| [server/db/store.js](server/db/store.js) | SQLite store |
| [server/db/recommender.js](server/db/recommender.js) | 推荐回复（人设+画像+规则） |
| [server/aiService.js](server/aiService.js) | LLM 调用（翻译 / 页面理解 / 推荐回复） |
| [public/ichigo-console.html](public/ichigo-console.html) | 主控制台前端（/ichigo-console） |
| [start-console.bat](start-console.bat) / [stop-console.bat](stop-console.bat) | 启动 / 停止 |

## 文档索引

- [CONSOLE-HOWTO.md](CONSOLE-HOWTO.md) — 启动说明（简版）
- [docs/API.md](docs/API.md) — API 接口文档（/api/console/* + /api/*）
- [docs/功能清单.md](docs/功能清单.md) — 主链路功能清单
- [docs/plan/00-README.md](docs/plan/00-README.md) — 里程碑与架构总览
- [AGENTS.md](AGENTS.md) — 项目长期契约（铁律 / 决策 / 已知坑）
- [docs/IPDeep实验协议.md](docs/IPDeep实验协议.md) — 代理实验协议

## 安全铁律（摘录，全文见 AGENTS.md §0）

1. 绝不擅自给客户发消息；发送永远走「建议 → 确认 → 执行」。
2. 密钥与客户数据不进 Git（settings.json、data/、backups/、*.log）。
3. 改动后必须验证（后端跑 node --test，前端确认页面可用）。


## 启动方式（两种，按需选）

```bat
:: 前台模式（开发排障，Ctrl+C 停，日志直接看）
start-console.bat

:: 守护模式（生产，crash 自重启 + 内存护栏 + 优雅退出）
start-guarded.bat   :: 首次自动装 pm2，之后 pm2 monit/logs/restart/stop
```

- **前台模式**：适合开发、看日志、排障；窗口关了进程就停。
- **守护模式（pm2）**：适合长期跑（引流需要 7x24 在线）；进程崩了 pm2 自动拉起，
  内存超 512M 自动换新进程，优雅退出留足 10s 关 SQLite。详见 [docs/GUARDIAN.md](docs/GUARDIAN.md)。
- 控制台入口：http://127.0.0.1:8300/ichigo-console（出会）+ 快乐平台视图。
