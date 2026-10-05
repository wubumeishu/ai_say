# Ai SAY · 项目长期提示词（AGENTS.md）

> 本文件是 Ai SAY 项目的长期工作契约：任何 AI 会话（开发/运维/排障）开始前先读它，
> 并遵守其中所有「铁律」与「用户已定决策」。与用户对话默认用**简体中文**。

---

## 0. 铁律（违反即为事故）

1. **绝不擅自给客户发消息。** 包括测试消息。任何发送动作（send-live / sendToContact /
   页面点「はい」）执行前必须得到用户在对话里的明确同意，并复述：**发给谁、发什么**。
2. **发送永远走「建议 → 确认 → 执行」**。AI 只生成建议和草稿；真正发出由用户确认。
3. **密钥与客户数据不进 Git。** settings.json（含明文 apiKey）、data/（客户画像、消息、
   *.db）、backups/、*.log 必须先 .gitignore 再 push。GitHub 仓库：
   https://github.com/wubumeishu/ai_say（公开历史不可逆，泄露即事故）。
4. **改动后必须验证。** 后端改完跑 node --test；前端改完确认页面可用；真发相关改动
   只做只读验证，不真发。
5. **排障先怀疑被吞的错误。** 项目里有 43 处空 catch（即 catch 后大括号为空），
   现象「没报错但没效果」时，先查对应路径的 catch 是不是把异常吞了。

---

## 1. 用户已定下的决策（勿再劝改，照着执行）

1. **真发功能（send-live）当前定位**：为测试和完成发送功能而建。合规闸门 + 频控
   在「自动化引流阶段」再补。现在不要给 send-live 加闸门，但代码里保留 TODO，
   并把「补闸门」列为自动化引流的准入条件。
2. **优先级**：① Git 安全 → ② 网络体检 + IPDeep 代理池 → ③ Ai SAY 面板（B→C）→
   ④ bug 修复 + 测试全量 + 守护 → ⑤ 拆分 + 看板。①②③可并行。
3. **代理**：IPDeep（gate.ipdeep.com:8082），规则见 §4。代理池 + 网络检测是第一优先级。
4. **脚本守护**：需要进程守护（服务偶发退出）。
5. **代码级 bug**：用户不写代码，AI 负责修，逐个跑测试给前后对比。
6. **测试**：必须全量跑（23 个测试文件），不只跑 npm test 的 4 个。
7. **同意拆分** consoleRoutes.js（1682 行单体）。
8. **同意前端拆分**（ichigo-console.html 1956 行内联）。
9. **窗口行为约定**：所有操作的最终步骤 = 返回收件箱页 + 查是否有新消息；有新消息
   显示 new；只有用户点击客户卡片才同步并进入该客户聊天页。「空闲自动回收件箱」功能
   目前**不存在**（未来可做，属于事件驱动而非定时轮询）。
10. **日志/自动化信息**：放「看板」菜单（延后做）。
11. **Ai SAY 面板**：B（动作助手）起步 → C（多轮编排）演进，见 §5。
12. 用户对清理持谨慎态度：删 data/ 里的 db、根目录调试脚本前先征得同意。

---

## 2. 项目速览（新会话先看这里）

**是什么**：出会平台（sp.194964.com，又名 イククル）运营控制台。监控比特浏览器窗口、
抓取收件箱/历史/资料、翻译消息、画像客户、生成推荐话术、人工确认后真发消息，未来
沉淀 LINE 私域。账号人设：ともね（女，38 岁）。

**关键文件地图**

| 路径 | 职责 |
|---|---|
| server/index.js | 入口（8300 端口），组装 store/talkEngine/liveScanner/deepScrape，挂 console 路由 |
| server/consoleRoutes.js | 全部 /api/console/* 路由（1682 行，拆分中） |
| server/app.js | 旧 /api/* 路由（JSON store，与 SQLite 双轨，待统一） |
| server/adapter/ichigoDeepScrape.js | 收件箱/历史/资料抓取（页面内 fetch 零导航）+ sendToContact + navigateInbox |
| server/adapter/ichigoSendExpr.js | 真发页面脚本（填 textarea → 点 #sendButton → 确认弹窗 → 点 #submitBtn） |
| server/adapter/ichigoCache.js | 三层缓存（data/console-cache.json）：收件箱快照/历史/资料 |
| server/acquisition/talkEngine.js | 话术引擎 + 闸门（checkGate / withinRateLimit）+ 待确认队列 |
| server/db/store.js | SQLite store（data/aisay.db，schema 见 server/db/schema.sql） |
| server/db/recommender.js | 推荐回复（人设+画像+规则驱动） |
| server/db/leadScoring.js / dedup.js / profileExtractor.js | 评分 / 去重 / 画像抽取 |
| server/aiService.js | LLM 调用（aiTranslate / aiUnderstandPage / aiRecommendReply） |
| public/ichigo-console.html | 主控制台前端（/ichigo-console） |
| public/console.html + console.js | 卡片式控制台（/console） |
| start-console.bat / stop-console.bat | 启动（先清 8300 端口再前台起）/ 停止 |

**运维事实**
- 控制台：http://127.0.0.1:8300/ichigo-console 与 /console；端口 8300。
- 比特浏览器 API：http://127.0.0.1:54346（BitBrowser 自身 54345）。
- 出会窗口 windowId：2315e879dd6642559bdc11a07bb1fc43（自用出会，勿删）。
- 启动/停止：start-console.bat / stop-console.bat（bat 必须 CRLF 换行）。
- 测试：node --test（npm test 目前只覆盖 4/23 个文件，要手动全量）。

**真发机制（已验证，勿重新踩坑）**
- 页面：show_history.html 上 textarea（name=body，class=inputTextAreaRd，
  placeholder「メッセージを書く（500文字以内）」）
- 点 #sendButton（送信内容を確認，输入非空且≤500 字才启用）
- 弹出确认层（popupContent：「この内容で送信します。宜しいですか？」）
  → 点 #submitBtn（はい）才 POST /mail/inbox/ajax_mail_send.html
- 页面不会清空 textarea；成功判定靠 POST 网络事件，不要靠 textarea 变空。
- 发送后把窗口切回 show_mailbox.html（navigateInbox）。

---

## 3. 已知坑（本会话实测验证过，别再踩）

1. **CDP 偶发超时**：BitBrowser 每次 /browser/open 都换 DevTools 端口；
   Runtime.evaluate 偶发无响应（20s 超时）。表现：send-live 返回
   reason=send-failed，重试就好。要加自动重连 + 重试（Phase 4）。
2. **服务进程偶发退出**：uncaughtException 只 log 不重启；无 SIGTERM 处理；
   SQLite 不 close；无 pm2。现象：8300 突然 ECONNREFUSED，重启即好。
3. **4 个「假可用」bug（静默失效）**：
   - 推荐回复恒空：recommender.js:294 写 LeadEvent 漏传 score → SQLite 绑定
     undefined 抛错（leadScoring.js:107）。
   - 确认发送遇频控规则必 500：talkEngine.js:244 checkGate 未传 limits，
     :126 对 rateLimit 规则 Object.assign(limits, spec) 崩。
   - 消息监控空转：app.js:126 的 onMessage 来自 HTTP body，函数无法序列化，
     恒 undefined（messageMonitor.js:49）。
   - 指标趋势线恒空：consoleRoutes.js:628 db.prepare(sql, since) 把 since
     当 options 抛错，被 catch 吞。
4. **画像存不住**：db/store.js:98 用 INSERT OR REPLACE 写 ContactProfile，
   :104 把 occupation/language 硬编码 null；后续写入会把 age/region/height 清成
   null。要改 ON CONFLICT + COALESCE 并真正写入 occupation/language。
5. **A/B 恒 B**：talkEngine.js:142 sha1 hex 串 % 2 = NaN。
6. **频控账本仅内存**：sentLog/pushLedger/pendingQueue 重启即清零（重启可绕过
   24h 限额），且只 push 不裁剪。
7. **双存储**：app.js 的旧 /api/* 写 data/*.json，console 读 SQLite，数据分叉。
8. **请求体 JSON.parse 在 try 外**：app.js:552 畸形 JSON 挂死请求。
9. **WebSocket/窗口泄漏**：stop 不关 client，release 不关窗口，sessions 只增不减。
10. **测试残留**：data/ 里 16 个 *_test.db / dbg / mf / tf 系列是测试垃圾；
    新测试必须用 os.tmpdir()，别在 data/ 留文件。
11. **npm test 只跑 4/23**：audit-view / talk-rollback 现在是红的但没人跑。
12. **send-live 无闸门/无频控/无审计**：见 §1.1，自动化引流前必须补。

---

## 4. IPDeep 代理规则与代理池方案

**账号格式**：gate.ipdeep.com:8082 + 账号 + 密码（冒号分隔）
账号 = d2849313000-res-country-jp-session-{随机数}-sessiontime-{IP时长}

| 参数 | 含义 | 使用规则 |
|---|---|---|
| IP时长=0 | 一次一换 | 出会窗口**禁用**（会掉登录/触发风控） |
| IP时长>0 | 粘性 N 分钟同一 IP | 出会窗口默认用它 |
| 随机数 | 区分会话（10000-9999999999） | 换随机数 = 换一个粘性 IP |
| 密码 | 固定 | 手动维护，**不进 Git**（env / gitignored 文件） |

**代理池本质**：管理一批账号变体（同 host/port/密码，不同随机数+时长），分配给
窗口，体检，失效时换账号并重启窗口。**不做定时自动轮换**（换太勤触发平台风控）。

**网络体检**：/api/console/network/health → 出口 IP / 国家 / 延迟 / DNS /
sp.194964.com 连通 / CDP 可用 → 归因输出「网络问题 / 平台问题 / CDP 卡住」。

**开工前先实测 4 问**：
1. 同 sessiontime 下不同随机数 = 不同出口 IP？
2. sessiontime=0 会打断登录态吗？
3. BitBrowser 能运行时改代理还是必须重启窗口？
4. 换 IP 后平台会要求重新登录/风控吗？

---

## 5. Ai SAY 面板方案（B 起步 → C 演进）

**定位**：右侧「Ai SAY · 会话」面板从装饰品升级为自然语言编排入口。
现状：ichigo-console.html:1912 的 aiReply() 是纯前端字符串拼接，无后端、无 LLM、
无记忆、无动作。优化 = 从零做真。

**B 阶段（v1）**：单轮 + 工具调用
- POST /api/console/assistant { message, contactId, history[] }
- 后端组上下文（画像 + 最近 N 条消息摘要 + 工具清单）→ 调活跃模型 →
  返回 { reply, actions:[{type,label,payload}] }
- 只读/弱副作用动作直接执行；强副作用只生成「动作卡片」，用户点确认才执行
- 前端流式渲染 + 动作卡片 + localStorage 会话历史

**工具白名单**：

| 动作 | 副作用 |
|---|---|
| get_customer / list_customers / search_customers | 无 |
| generate_replies / translate | 无 |
| fill_draft（填入输入框，不发送） | 弱 |
| mark_read / switch_customer | 弱 |
| send_message | 强（必须用户确认，走 send-live） |

**四条铁律**：
1. LLM 永远不能直接发送（建议→确认→执行）。
2. 模型不可用 → 退回现有 aiReply() 拼接，不是删掉。
3. 上下文摘要化，不塞全量消息。
4. 数字（年龄/条数）从结构化数据取，防幻觉。

**C 阶段（v2）**：多轮状态机 + 多步任务分解 + 工具链 + 批量确认卡。

---

## 6. 开发规范

- **语言**：中文注释；回复用户用简体中文。
- **测试**：改动后跑全量 23 个测试文件；新测试用 os.tmpdir()；修复 bug 先写复现。
- **错误处理**：禁止新增空 catch；catch 里至少 log 模块.动作 + 错误。
- **发送相关**：任何真发改动只做只读验证（抓历史/查缓存），不真发测试。
- **bat 文件**：必须 CRLF 换行。
- **文件改动**：先读后改；大文件（consoleRoutes、ichigo-console.html）拆分中，
  新增代码按域放新文件。
- **密钥**：不进 Git；settings.json 改读 env 时提供 settings.example.json。

---

## 7. 执行路线（Phase 0–4）

- **Phase 0（现在）**：Git 安全 —— .gitignore + 密钥外置 + 首次提交。
- **Phase 1**：网络体检 → 实测 IPDeep 4 问 → 代理池 v1（配置管理 + 体检 + 手动换 IP）。
- **Phase 2**：Ai SAY 面板 B v1（后端 assistant + 真对话 + 只读工具）。
- **Phase 3（可并行）**：4 个假可用 bug + 画像 COALESCE + 测试全量 + 守护 + CDP 重试。
- **Phase 4**：Ai SAY C、拆 consoleRoutes/前端、看板（代理/日志/健康）。

---

## 附录 · Ai SAY 助手面板系统提示词（persona）

```
你是「Ai SAY 助手」，出会平台运营控制台的 AI 会话助手，服务运营者（用户）。

## 身份与语气
- 用简体中文回复；引用客户消息时可保留日文原文。
- 专业、简洁、信息密度高；不确定的事直说，不编造。

## 你的能力（工具）
- get_customer：读当前客户画像 + 最近消息摘要
- list_customers / search_customers：列出/筛选客户（按未读、在线、地区、年龄）
- generate_replies：生成推荐话术（只生成，不发送）
- translate：日⇄中翻译
- fill_draft：把话术填入消息输入框（用户自行点发送）
- mark_read / switch_customer：控制台内部操作
- send_message：必须由用户在你的动作卡片上点确认后才执行；你自己永不直接发送

## 铁律
1. 绝不自动发送任何消息。发送 = 你给建议 → 用户确认 → 系统执行。
2. 年龄、消息条数、时间等事实只引用系统提供的结构化数据，不得自行编造。
3. 数据不足时明确说「没有数据」，并提示可先抓取/刷新。
4. 模型或数据不可用时，降级为本地摘要回复，并告知用户当前是降级模式。

## 输出格式
- 普通问答：一段或分点回答，先结论后依据。
- 需要动作：正文 + 动作卡片 [{type,label,payload}]，由前端渲染成按钮。
- 生成话术后：给出话术 + 「填入输入框」卡片；涉及发送的额外给「发送」卡片，
  且必须标注「发送需你确认」。
```

