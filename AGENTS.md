# Ai SAY · 项目长期提示词（AGENTS.md）

> 本文件是 Ai SAY 项目的长期工作契约：任何 AI 会话（开发/运维/排障）开始前先读它，
> 并遵守其中所有「终极蓝图」「铁律」与「用户已定决策」。与用户对话默认用**简体中文**。
> 2026-10-06 修订：引入「群控基座」终极蓝图（§-1）作为最高设计准则；按 task-36 修复
> 状态重写 §3；测试双口径（§1.6）；行数控件实测值更新。
> 2026-10-06 task-1（qa-lead）：清除 audit-view / talk-rollback 两红测试断言（task-37 语义
> 漂移：triggerGuide 恒 {sent:false, pending:true}，真发走 confirmSend）；talk-rollback
> 测试 db 迁 os.tmpdir()；§3.11 建「测试基线与红色记录」存档；§3.10/§3.11/§6/§7 同步。
> 2026-10-06 task-4（qa-lead）：清除仓内 server/acquisition/talkEngine.test.js 4 红
> （task-37 语义漂移）+ task-6 onMessage 修复合入。
> 2026-10-06 总控独立复跑定死（task-11）：全量 19 物理文件 121 用例 / 4 红
> （4 红 = crash-guard 白名单 2 断言漂移 + MergeEvent 回滚 1 + 预审静态 1）；
> §3.11/§6/§7 基线更新为 121/4红。
> 2026-10-06 task-12 三方独立复测坐实（总控 pwsh-153 + code-reviewer task-11 G 复测 +
> qa-lead 全量连跑一致）：121/0 红 ~60s；4 红清零（crash-guard 2 红 task-6 A 项断言同步 +
> MergeEvent 1 红 dedup fixture 迁 os.tmpdir + 预审静态 1 红随 A 项同步）；§3.11/§6/§7 基线
> 更新为 121/121 全绿。
> 2026-10-06 node 1 task-2 收口 + 4.5 跨轨归并修复（总控独立核验通过：schema.sql 5 新表 +
> 活库 _migration v2/v21 + 002 列补齐 + /api/console/health + /api/console/inbox/unread +
> migrateUnify.js 4.5 弱指纹 likelySame 队列 + 3 陷阱全修 + 2 小项 + 现网数据结论 + 补测试 5 用例
> console-health 3 + migrateUnify-cross 2）：全量回归 124→126/126 0 红（code-reviewer task-12
> 复测 + 总控独立复跑坐实）；§1.6/§3.7/§3.11/§6/§7 基线更新为 126/126。
> 2026-10-06 node 2 task-3 收口（频控账本落库：SentLog/GateBlock/PendingQueue 三表 +
> schema.sql L354/377/398 + 5 索引 + 活库 _migration v3 + store.js 7 方法（archiveRateLedgers
> 分片归档 + loadRateLedger 24h 热账本跨重启 + 50ms 双写 + (ts,seq) 字典序 + SIGTERM
> flushQueue）+ talkEngine.js NoopLedger 选法 a + rate-ledger.test.js 6 用例）：全量回归
> 126→132/132 0 红；§3.6/§3.11/§6/§7 基线更新为 132/132。
> 2026-10-06 node 3 task-5 收口（Ai SAY B v1.1 三端联调：assistant.js 强制 JSON 契约
> {analysis/strategy/replies} + intent 4 意图 + parseV11 容忍降级 + 脱敏白名单 3 列 +
> 三要素内存组装 + ageNum 防幻觉；ichigo-console.html 删 D1/D2 + Action Chips + Accordion
> + 话术卡片 + 一键填入（只填不发）+ 降级矩阵 + 双向兼容；assistant.test.js +6 B v1.1 用例）：
> 全量回归 132→138/138 0 红（总控 pwsh-174 独立复跑 + code-reviewer task-8 节点 3 复审
> 5 审查点全核 + 前端 grep 交叉核对 + 铁律红线确认 + backend-lead 定向 11/11 一致）；
> §1.6/§3.11/§5/§6/§7 基线更新为 138/138，行数控件前端实测 2368 行（node 3 后）。

---

## -1. 终极业务蓝图（2026-10-06 用户 5 点 · 最高设计准则）

> 本蓝图是本项目的**战略方向**，一切架构决策、拆分、新功能设计以它为纲；
> 它是原有铁律与决策的**升级补充，不是推翻**——§0/§1 仍然生效。
> 文档视野：从「修 Bug」拉升到「**群控基座**」。

1. **群控中枢**：Ai SAY 是「一个平台账号 × 多客户会话」的运营中枢；
   架构必须支撑「群控」形态（N 个账号/窗口并行），数据模型按
   `[平台ID - 账号ID - 会话ID]` 三级嵌套保证跨账号、跨平台兼容与去重。
2. **抗风控基石**：指纹浏览器（BitBrowser 窗口隔离）+ IPDeep 代理池（粘性 IP）
   + 网络体检归因 + CDP 自动重连重试 + 平台环境隔离 = 五条防线，
   是自动化引流的前置条件；不做定时自动换 IP（换太勤触发平台风控）。
3. **三要素隔离**：**账号人设 / 客户画像 / 消息上下文** 三要素严格隔离：
   - 账号人设（AccountPersona）只描述账号本体，不混入客户数据；
   - 客户画像（ContactProfile）独立于账号；
   - 消息上下文（Conversation）按会话隔离；
   - 沟通语境 = 人设 + 画像 + 统一规则（GovernanceRule），三者在生成话术时
     才在内存中组装，**落库互不污染**。
4. **Ai SAY 深度智能化**：助手面板一键策略生成 = 把「人设 + 画像 + 上下文」
     打包给 LLM，返回话术 + 动作卡片；发送类动作永远只出确认卡片
     （建议 → 确认 → 执行，AI 永不直接发）。
5. **高阶自动化与人工兜底**：预留平台原生操作层（页面表达式
   server/adapter/ichigo*Expr.js）、RPA 式接管与「智能接管兜底」：
   自动化失败/模型不可用 → 降级本地规则/拼接 → 人工兜底确认。
   人工兜底是底线，自动化永远可回退。

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
6. **测试（双口径，2026-10-06 修订）**：
   - **契约口径（用户定的 23）**：以 23 个测试文件为全量基准，「必须全量跑」的
     验收数按 23 计；文档/汇报一律引用 23。
   - **物理口径（磁盘实测，2026-10-06 路线 B 三节点收口后）**：22 物理测试文件 138 用例
     = tests/ 16 文件 92 用例（app 12 / assistant 11（node 3 B v1.1 +6）/ audit-view 6 /
     console 6 / console-health 3 / crash-guard 8 / live-scanner 6 / message-monitor 4 /
     metrics-funnel 3 / migrateUnify-cross 2 / profile-integration 4 / rate-ledger 6（node 2 新增）/
     send-confirm 6 / send-live 6 / tag-filter 4 / talk-rollback 4）+ 模块内 6 文件 46 用例
     （server/db 5 文件 39 + server/acquisition 1 文件 12，展开口径；server 域 46 实测）。
     - 契约 23 口径（用户定）数字本身不动，文档/汇报验收数仍引用 23；
       138 是物理实测口径（22 文件）。
   - metrics-funnel 全量连跑口径注记：138/138 全绿需 metrics-funnel fixture 无 data/ 残留
     （os.tmpdir，§3.10）方成立；qa-lead 已迁 fixture L19 到 os.tmpdir + 清 data/ 残留，全量连跑真 0 红。
     dedup EBUSY 同源注记：server/db/dedup.test.js L23 已迁 os.tmpdir（aisay-dedup-test-*.db，
     同 talk-rollback/metrics-funnel 先例；task-11 G 同批 qa-lead 迁移）。
     tag-filter fixture 已迁（qa-lead task-11 G 同批）。
     talk-rollback EBUSY 卫生注记保留：Windows 下 os.tmpdir db 偶发残留，不影响用例结果。
   - 两口径差异的 7 个契约文件尚未落盘，**不得当成缺失**；全量执行命令按
     `node --test tests/*.test.js server/db/*.test.js server/acquisition/*.test.js`
     现跑现报。npm test 目前只覆盖 4 个文件，必须手动全量。
7. **同意拆分** consoleRoutes.js（实测 1745 行单体，2026-10-06 行数控件）。
8. **同意前端拆分**（ichigo-console.html 实测 2368 行内联，node 3 B v1.1 后行数控件）。
9. **窗口行为约定**：所有操作的最终步骤 = 返回收件箱页 + 查是否有新消息；有新消息
   显示 new；只有用户点击客户卡片才同步并进入该客户聊天页。「空闲自动回收件箱」功能
   目前**不存在**（未来可做，属于事件驱动而非定时轮询）。
10. **日志/自动化信息**：放「看板」菜单（延后做）。
11. **Ai SAY 面板**：B（动作助手）起步 → C（多轮编排）演进，见 §5；
    智能化方向按终极蓝图 §-1.4 执行。
12. 用户对清理持谨慎态度：删 data/ 里的 db、根目录调试脚本前先征得同意。

---

## 2. 项目速览（新会话先看这里）

**是什么**：出会平台（sp.194964.com，又名 イククル）运营控制台，终极形态是
「出会平台运营群控基座」（终极蓝图 §-1）。监控比特浏览器窗口、
抓取收件箱/历史/资料、翻译消息、画像客户、生成推荐话术、人工确认后真发消息，
未来沉淀 LINE 私域。账号人设：ともね（女，38 岁）。

**关键文件地图**

| 路径 | 职责 |
|---|---|
| server/index.js | 入口（8300 端口），组装 store/talkEngine/liveScanner/deepScrape，挂 console 路由；SIGTERM/SIGINT 优雅退出 |
| server/consoleRoutes.js | 全部 /api/console/* 路由（实测 1745 行，拆分中） |
| server/app.js | 旧 /api/* 路由（JSON store，与 SQLite 双轨，待统一） |
| server/adapter/ichigoDeepScrape.js | 收件箱/历史/资料抓取（页面内 fetch 零导航）+ sendToContact + navigateInbox |
| server/adapter/ichigoSendExpr.js | 真发页面脚本（填 textarea → 点 #sendButton → 确认弹窗 → 点 #submitBtn） |
| server/adapter/ichigoCache.js | 三层缓存（data/console-cache.json）：收件箱快照/历史/资料 |
| server/adapter/proxyPool.js | IPDeep 代理池 v1（槽位/粘性/冷却/事件驱动换 IP） |
| server/adapter/assistant.js | Ai SAY 助手 B v1/v1.1 后端（组上下文 → LLM → reply + actions；B v1.1 强制 JSON 契约 {analysis/strategy/replies} + intent 4 意图 + parseV11 容忍降级 + 脱敏白名单 3 列 + 三要素内存组装 + ageNum 防幻觉） |
| server/acquisition/talkEngine.js | 话术引擎 + 闸门（checkGate / withinRateLimit）+ 待确认队列 |
| server/db/store.js | SQLite store（data/aisay.db，schema 见 server/db/schema.sql） |
| server/db/migrations/002_add_columns.sql.js | 002 列补齐批次（node 1 task-2 双存储：5 新表字段 + 现网列补齐，活库 _migration v2/v21） |
| server/db/migrateUnify.js | 双存储统一迁移器：三轨归位（JSON→SQLite）+ 4.5 跨轨归并（弱指纹 likelySame 队列）+ NoopLedger 兜底 |
| tests/console-health.test.js | /api/console/health 轻量探针 3 用例（node 1 新增） |
| tests/migrateUnify-cross.test.js | 4.5 跨轨归并 2 用例（node 1 新增，验证归并数 > 0） |
| tests/rate-ledger.test.js | 频控账本落库 6 用例（node 2 task-3 新增：三表读写 + 24h 热账本跨重启 + 归档裁剪） |
| server/db/recommender.js | 推荐回复（人设+画像+规则驱动） |
| server/db/leadScoring.js / dedup.js / profileExtractor.js | 评分 / 去重 / 画像抽取 |
| server/aiService.js | LLM 调用（aiTranslate / aiUnderstandPage / aiRecommendReply） |
| public/ichigo-console.html | 主控制台前端（/ichigo-console，实测 2368 行 B v1.1 前端：Action Chips + Accordion + 话术卡片 + 一键填入，拆分中） |
| public/console.html + console.js | 卡片式控制台（/console） |
| start-console.bat / stop-console.bat | 启动（先清 8300 端口再前台起）/ 停止 |

**运维事实**
- 控制台：http://127.0.0.1:8300/ichigo-console 与 /console；端口 8300（PORT/HOST 可覆盖）。
- 比特浏览器 API：http://127.0.0.1:54346（BitBrowser 自身 54345，BIT_BROWSER_API_URL 可覆盖）。
- 出会窗口 windowId：2315e879dd6642559bdc11a07bb1fc43（自用出会，勿删）。
- 启动/停止：start-console.bat / stop-console.bat（bat 必须 CRLF 换行）。
- 测试：node --test 全量（双口径见 §1.6；npm test 只覆盖 4 个文件，要手动全量）。

**真发机制（已验证，勿重新踩坑）**
- 页面：show_history.html 上 textarea（name=body，class=inputTextAreaRd，
  placeholder「メッセージを書く（500文字以内）」）
- 点 #sendButton（送信内容を確認，输入非空且≤500 字才启用）
- 弹出确认层（popupContent：「この内容で送信します。宜しいですか？」）
  → 点 #submitBtn（はい）才 POST /mail/inbox/ajax_mail_send.html
- 页面不会清空 textarea；成功判定靠 POST 网络事件，不要靠 textarea 变空。
- 发送后把窗口切回 show_mailbox.html（navigateInbox）。
**删帖机制（BBS 招募帖子，已验证 2026-10-25）**
- 目标：只删**自己的**招募帖子（BBS 招募历史页 show_bbs_write_list.html），绝不删他人帖子/消息/客户
- 链路 3 步：① 招募历史页勾 `input[type=checkbox][name="targetBbsId[]"]`（每帖 1 个 checkbox，value=帖子ID）→ ② 点「チェックを削除」按钮 → ③ 跳 `show_bbs_confirm_delete.html` 确认页 → 点「削除する」（确认页文案「一度削除すると元に戻せません」）
- 批量删全部：招募历史页点「すべて削除する」→ `show_bbs_confirm_delete_all.html` 确认页 →「削除する」
- 单帖 3 个操作 form（在 show_bbs_write_detail.html 写详情页，按 targetBbsId）：
  - 编辑：POST `show_bbs_write_edit.html?targetBbsId=` → 表单 POST `exec_routing_bbs_write.html`（is_edit=1）
  - 下架（掲載停止，不删只隐藏）：POST `exec_bbs_close.html`（identifier=status + targetBbsId）
  - 删除：POST `show_bbs_confirm_delete.html`（identifier=delete + targetBbsId）→ 确认页
  - 确认页提交：确认页「削除する」实际在 `form action=exec_bbs_delete.html` 里，**直接 form.submit()**（按钮 click 可能被事件拦截不触发表单提交，2026-10-25 端到端实测坐实）；deepScrape.bbsDeletePosts 默认开 confirmSubmit + 显式回列表页 + 验证 checkbox 消失（verifiedDeleted）
- 安全铁律：删帖是强副作用，执行前必须用户在对话明确同意 + 复述删哪条（targetBbsId + 帖子标题）；只删数据边界内指定的那一条，不动其他帖子
- 防封：招募帖子 1 小时冷却期内不能重新发帖（删帖本身不受限，但平台可能限频操作）

---

## 3. 已知坑（按 2026-10-06 修复状态重写；「已修」项附 task 标记）

1. **CDP 偶发超时**：~~无自动重连重试，Runtime.evaluate 偶发无响应（20s 超时）~~。
   **已修（task-36）**：ichigoDeepScrape.js withTarget 通道级自动重连 + 重试
   （isRetryable 识别 timeout/ECONNREFUSED/socket closed 等，2 次重试；业务错误直抛不重试，
   L72/L223）。残留：偶发仍可能 reason=send-failed，手动重试或再跑体检即好；
   终极蓝图 §-1.2 抗风控基石要求把 CDP 重连 + 重试纳入统一网络层。
2. **服务进程偶发退出**：~~uncaughtException 只 log 不重启；无 SIGTERM 处理~~。
   **已修（task-36）**：SIGTERM/SIGINT 优雅退出（server/index.js shutdown，关 server +
   1500ms 兜底 exit）。仍缺：uncaughtException 自动重启 / pm2 守护 / SQLite close
   （crash 自重启属高阶守护，规划中）。现象 8300 ECONNREFUSED 时重启即好。
3. **4 个「假可用」bug（静默失效）——修复状态（2026-10-06 源码核实）**：
   - ~~推荐回复恒空：recommender.js 写 LeadEvent 漏传 score → SQLite 绑定
     undefined 抛错~~。**已修（task-36）**：score 必传
     （({ hot: 80, warm: 50, cold: 20 })[tier] || 50）。
   - ~~确认发送遇频控规则必 500：talkEngine.js checkGate 未传 limits，
     对 rateLimit 规则 Object.assign(limits, spec) 崩~~。**已修（task-36）**：
     checkGate({ ..., limits: ctx.limits || entry.limits || {} })。
   - ~~指标趋势线恒空：consoleRoutes.js db.prepare(sql, since) 把 since 当 options
     抛错，被 catch 吞~~。**已修（task-36）**：参数放 .all(since)。
   - ~~消息监控空转：app.js startMonitor 的 onMessage 来自 HTTP body，函数无法
     序列化，恒 undefined（messageMonitor.js）~~。**已修（task-6）**：messageMonitor.js
     registerSink 进程内 sink + onMessage?.() 不抛错，/api/monitor 保留兼容层
     deprecated 标记；新增 tests/message-monitor.test.js 4 用例（复现 + 修复 + 回归
     + 缓冲上限）全绿。
4. **画像存不住**：~~db/store.js 用 INSERT OR REPLACE 写 ContactProfile，把
   occupation/language 硬编码 null；后续写入把 age/region/height 清成 null~~。
   **已修（task-36）**：store.js L97 改 ON CONFLICT DO UPDATE + COALESCE
   （occupation/language 真正写入不再 null；age/region/height 新值为空保留旧值；
   confidence 取 MAX(excluded, 旧值)）。
5. **A/B 恒 B**：~~talkEngine.js:142 sha1 hex 串 % 2 = NaN~~。
   **已修（task-36）**：talkEngine.js L142-147 改 parseInt(前 4 位 hex,16) % 2，
   同一 contactId 恒得同值（A/B 固定分流）。
6. **频控账本~~仅内存~~（node 2 task-3 已落库）**：~~sentLog/gateBlockLog/pendingQueue
   重启即清零（重启可绕过 24h 限额），且只 push 不裁剪~~。**已修（node 2 task-3）**：
   三表 schema.sql L354/377/398（SentLog/GateBlock/PendingQueue）+ 5 索引 + 活库 _migration
   v3 挂 v2；store.js 7 方法（archiveRateLedgers 7d/72h/30d 分片归档 + loadRateLedger
   24h 热账本跨重启限额 + 50ms 双写 + (ts,seq) 字典序 + SIGTERM flushQueue）；
   talkEngine.js NoopLedger 选法 a（_sentLog/_pendingQueue 数组不破 4 处断言 + ledger
   句柄注入）；裁剪窗保留 >=24h+30min remindWindow。
   勘误（task-3 核实）：原文误写 pushLedger（仓内不存在）；实际三本账 =
   sentLog / gateBlockLog / pendingQueue（abStats 已落 TalkAbStat 表）。gateBlockLog
   已升级 GateBlock 审计表。
7. **双存储**：app.js 的旧 /api/* 写 data/*.json，console 读 SQLite，数据分叉
   （终极蓝图 §-1.1 群控基座统一在 SQLite 单轨上走）。
   已落（node 1 task-2）：schema.sql 5 新表（Platform/PlatformGroup/AccountGroup/InboxSnapshot/
   AccountProfileRaw）+ 002 列补齐批次 + migrateUnify.js 三轨归位 + /api/console/health 轻量探针 +
   /api/console/inbox/unread 未读端点（Phase B 切单轨启用）。**4.5 跨轨归并边界（TODO）**：
   现网缓存轨 q-token（base64 会话 ID）与 JSON 轨 contactKey（明文 label）两套 key 交集为 0、
   不同源，强归并（q-token=contactKey 直接 JOIN）不适用；当前 4.5 走弱指纹 likelySame 队列
   （dedup.getWeakFingerprint 归一化姓名+地区+年龄命中，MergeEvent 'queue:cross-track-unify|' 专属
   前缀入队 + mergeContact 'cross-track-unify' 'weak' 归并，§0.3 可回滚；现网不同名客户 0 命中属
   正常结果非 bug）。强归并待缓存轨补全 q-token↔contactKey 映射锚点后启用（node 2+ 或独立批次）。
   4.5 已补测试（node 1 收口）：migrateUnify-cross.test.js 2 用例验证归并数 > 0（同指纹客户
   走 likelySame 队列被归并）+ console-health.test.js 3 用例验证 /api/console/health 探针。
   现网数据结论（node 1 核验）：q-token vs contactKey 不同源，强归并待映射锚点补全；
   3 陷阱（q-token 含 '/' 需 base64 反解 / 弱指纹跨轨归一 / 队列前缀专属）全修 + 2 小项。
8. **请求体 JSON.parse 在 try 外**：app.js:552 畸形 JSON 挂死请求。
9. **WebSocket/窗口泄漏**：stop 不关 client，release 不关窗口，sessions 只增不减。
10. **测试残留**：data/ 里 16 个 *_test.db / dbg / mf / tf 系列是测试垃圾；
    新测试必须用 os.tmpdir()，别在 data/ 留文件。
    已清（task-1）：tests/talk-rollback.test.js 的 TMP_DB 已从 data/talk_rollback_test.db
    迁到 os.tmpdir()（消除 safeUnlink EBUSY 残留锁）；audit-view 早已用 os.tmpdir()。
    待清：data/ 里的历史垃圾 db（_test.db/dbg/mf/tf 系列）需用户同意后删除（§1.12 清理谨慎原则）。
    卫生注记（task-6 全量回归日志实测）：Windows 下 talk-rollback 的 os.tmpdir db
    （aisay-talk-rollback-test-*.db）偶发 EBUSY 残留（safeUnlink 3 次重试后 ENOENT/EBUSY），
    不影响用例结果（路线 B 三节点收口后 node 3 已坐实 138/0 红），下次全量前可手动清
    C:\Users\Administrator\AppData\Local\Temp\aisay-talk-rollback-test-*.db。
11. **npm test 只跑 4/23**：audit-view / talk-rollback 两红已清（task-1）；仓内
    server/acquisition/talkEngine.test.js 4 红已清（task-4，task-37 语义漂移）；
    全量测试请用 `node --test tests/*.test.js server/db/*.test.js server/acquisition/*.test.js`，
    现 **22 物理文件 138 用例全绿（0 红，全量连跑口径；node 2 task-3 收口 +
    rate-ledger 6 用例 + node 3 task-5 收口 + assistant B v1.1 +6 用例；node 3 三方核验：
    总控独立读 assistant.js + ichigo-console.html + 6 新测试 + 独立复跑 pwsh-174 +
    code-reviewer task-8 复测 + backend-lead 定向 11/11 一致，均 138/0 红 ~60s）**。
    （node 2 task-3 前基线为 126/126：node 1 三方坐实；node 1 task-2 前基线为 121/121：
    task-12 三方坐实，4 红已清零，见上 4 红清零原因段。）耗时 ~60s。
    真绿注记（task-4 t4 假绿修复，backend-lead 核实）：t4 此前假绿（profileStore 缺桩
    导致断言空转），已修为 profileStore 最小桩 + strictEqual 40 断言；
    当时记录的 4 红（crash-guard 白名单 2 + MergeEvent 1 + 预审静态 1）均为已知回归漂移，
    非假绿格；task-12 已全部清零（见上 4 红清零原因）。
12. **send-live 无闸门/无频控/无审计**：见 §1.1，自动化引流前必须补
    （终极蓝图 §-1.2/§-1.4：自动化以抗风控 + 人工兜底为底线）。

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
已落 v1：server/adapter/proxyPool.js + /api/console/proxy/*（池状态/换 IP dryRun/
扩池/改粘性/体检驱动换 IP），页头「换 IP」按钮先 dryRun 确认槽位再执行，
15s 自动体检。

**网络体检**：/api/console/network/health → 出口 IP / 国家 / 延迟 / DNS /
sp.194964.com 连通 / CDP 可用 → 归因输出「网络问题 / 平台问题 / CDP 卡住」。

**开工前先实测 4 问**：
1. 同 sessiontime 下不同随机数 = 不同出口 IP？
2. sessiontime=0 会打断登录态吗？
3. BitBrowser 能运行时改代理还是必须重启窗口？
4. 换 IP 后平台会要求重新登录/风控吗？

---

## 5. Ai SAY 面板方案（B 起步 → C 演进，按终极蓝图 §-1.4 深化）

**定位**：右侧「Ai SAY · 会话」面板 = 自然语言编排入口。一键策略生成：
后端把「账号人设 + 客户画像 + 最近消息上下文」打包给 LLM（终极蓝图 §-1.3
三要素在生成时才组装），返回 { reply, actions:[{type,label,payload}] }；
只读/弱副作用动作直接执行；**发送类动作永远只出确认卡片**（建议 → 确认 → 执行，
AI 永不直接发，终极蓝图 §-1.5 人工兜底是底线）。

**B 阶段（v1，已落）**：单轮 + 工具调用
- POST /api/console/assistant { message, contactId, history?, maxMsgs? }
  （server/adapter/assistant.js：组上下文（画像 + 最近 12 条消息 + 工具清单）→
  调活跃模型 → 返回 reply + actions；模型不可用降级本地摘要）
- 前端流式渲染 + 动作卡片 + localStorage 会话历史

**B v1.1 三端联调已落（node 3 task-5 收口）**：
- 后端 assistant.js：强制 JSON 契约 { analysis/strategy/replies:[{type,content}] } +
  intent 4 意图参数（analyze/reply/deflect/meet）+ parseV11 容忍代码块降级 +
  脱敏白名单 3 列（apiKey/账号本名/客户真名不进 prompt）+ 三要素内存组装 +
  ageNum 防幻觉（数字只取结构化数据）。
- 前端 ichigo-console.html（实测 2368 行）：删 D1/D2（renderAiQuick/ai-quick 硬编码
  短语条，实测 0 残留）+ Action Chips（4 枚横滑意图卡）+ Accordion（ai-acc×18，
  analysis/strategy 可折叠默认收起）+ 话术卡片（ai-reply×11）+【填入发送框】×5
  （只写 msgInput DOM value+focus+toast，零 fetch/零 send-live/零 #sendButton 触发，
  弱副作用铁律 1）+ 降级矩阵（degraded×7）+ 双向兼容（旧前端+新后端 / 新前端+旧后端 零破坏）。
- 测试：6 新测试（os.tmpdir mock 不真连 LLM）覆盖 B v1.1；assistant.test.js 11 用例
  （原 5 + B v1.1 新增 6）全绿。
- 放行条件（§5.8：三端联调排基建 task-①② 稳定后放行）= **已满足并放行收口**
  （node 1 task-2 双存储 + node 2 task-3 频控账本落库均已坐实，node 3 三端联调收口）。

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
2. 模型不可用 → 降级本地摘要/现有拼接，不是删掉（人工兜底）。
3. 上下文摘要化，不塞全量消息。
4. 数字（年龄/条数）从结构化数据取，防幻觉。

**C 阶段（v2，规划）**：多轮状态机 + 多步任务分解 + 工具链 + 批量确认卡。

**破旧立新（长期体验规划，B v1.1 设计稿已定稿）**：设计稿
[docs/plan/aishay-uix-upgrade.md](docs/plan/aishay-uix-upgrade.md)（B v1.1，task-5 定稿）。
核心：LLM 返回从 Markdown 纯文本升级为结构化 JSON，面板输入区换意图快捷卡，
话术一键填入发送框——消除「难阅读 + 手动复制粘贴」两大痛点。
1. **破旧**：删 ichigo-console.html 硬编码日文快捷短语条（renderAiQuick/ai-quick，
   清单 D1/D2）；中栏常用语管理不动（consolePrefs 种子保留，只删面板侧消费）。
2. **立新 · 输入区 Action Chips**：aiInput 正上方 4 枚横滑意图卡
   （🔍深度心理分析 analyze / 💬高情商回复 reply / 🛡️委婉拉扯拒绝 deflect / 🎯引导线下 meet），
   点击把 intent 参数 + 当前输入组装后调 POST /api/console/assistant（请求体新增 intent，向后兼容）。
3. **后端格式**：LLM Prompt 强制输出标准 JSON { analysis, strategy, replies:[{type,content}] }
   （type ∈ opening/followup/deflect/meet/close/other，未知按 other），替代 Markdown；
   parseJSON 容忍代码块包裹，失败即降级。
4. **前端渲染**：analysis/strategy 可折叠 Accordion（默认收起）+ 每条话术独立卡片
   （type 角标）+ 右下角【填入发送框】：只写 msgInput 的 DOM value + focus + toast，
   零 fetch / 零 send-live / 零 #sendButton 触发（弱副作用，铁律 1；用户自行点发送走既有确认流）。
5. **降级**：LLM 非标准 JSON / 模型不可用 → degraded=true + localFallback（铁律 2），
   chips 灰显仍可用；旧前端+新后端 / 新前端+旧后端双向零破坏（兼容矩阵 §3.4）。
6. **脱敏（§0.3 铁律延伸）**：apiKey 只走 HTTP header 绝不出现在 prompt/上下文/日志；
   客户 PII（手机号/邮箱/真名/住址）进 prompt 前掩码，密钥/账号本名/客户真名三类永不进 prompt。
7. **三端分工**：system-architect 扩契约（assistant-api-spec.md 响应+请求+兼容矩阵+脱敏约束）/
   backend-lead 改 Prompt + parseJSON + intent 分 prompt + 脱敏 / frontend-lead 删 D1/D2 +
   Action Chips + Accordion 卡片 + 一键填入 + 降级矩阵；测试 qa-lead（设计稿 §7 共 17 例）。
8. **放行条件**：三端联调排基建 task-①②（双存储统一 + 频控账本落库）稳定后由总控放行；
   **已满足并放行收口（node 3 task-5）**：node 1 task-2 双存储 + node 2 task-3 频控账本
   均已坐实，三端联调（assistant.js 强制 JSON + ichigo-console.html Action Chips/Accordion/
   一键填入 + 6 新测试）已收口，138/138 全绿。当前为 B v1.1 已落阶段（C 阶段 v2 规划中）。

**高阶自动化预留（终极蓝图 §-1.5）**：平台原生操作层（页面表达式
adapter/ichigo*Expr.js，零导航抓取/发送）→ RPA 式接管 → 智能接管兜底；
自动化失败必降级人工确认，可完整回退。

---

## 6. 开发规范

- **语言**：中文注释；回复用户用简体中文。
- **测试**：改动后跑全量测试（双口径见 §1.6：契约 23 / 物理实测；
  全量命令 `node --test tests/*.test.js server/db/*.test.js server/acquisition/*.test.js`，
  基线见 §3.11：22 物理文件 138 用例全绿（0 红，路线 B 三节点收口 + rate-ledger 6 + assistant B v1.1 +6；node 3 三方核验坐实：总控 pwsh-174 + code-reviewer task-8 + backend-lead 定向 11/11 一致；耗时 ~60s）；
  新测试用 os.tmpdir()；修复 bug 先写复现。
- **错误处理**：禁止新增空 catch；catch 里至少 log 模块.动作 + 错误。
- **发送相关**：任何真发改动只做只读验证（抓历史/查缓存），不真发测试。
- **bat 文件**：必须 CRLF 换行。
- **文件改动**：先读后改；大文件（consoleRoutes 1745 行、ichigo-console.html 2368 行）
  拆分中，新增代码按域放新文件。
- **密钥**：不进 Git；settings.json 改读 env 时提供 settings.example.json。
- **群控基座（终极蓝图 §-1.1）**：新数据模型一律 `[平台ID - 账号ID - 会话ID]`
  三级嵌套；三要素（人设/画像/上下文）落库隔离（§-1.3）。

---

## 7. 执行路线（Phase 0–4，按终极蓝图升级）

- **Phase 0（已完成）**：Git 安全 —— .gitignore + 密钥外置 + 首次提交。
- **Phase 1（已完成）**：网络体检 → 实测 IPDeep 4 问 → 代理池 v1（proxyPool.js +
  /api/console/proxy/* + 页头换 IP 按钮）。
- **Phase 2（已完成）**：Ai SAY 面板 B v1（server/adapter/assistant.js 真 LLM 对话
  + 工具白名单 + 降级保底；tests/assistant.test.js 5 用例）。
- **Phase 3（进行中）**：task-36 已修 6 项——CDP 自动重连重试（§3.1）、SIGTERM 优雅
  退出（§3.2）、4 假可用 bug 中 3 个（recommender score / talkEngine checkGate limits /
  metrics 趋势线，§3.3）、画像 COALESCE（§3.4）、A/B 恒 B（§3.5）；剩余：消息监控
  onMessage 空转（§3.3.4，task-6 已修：messageMonitor.js registerSink 进程内 sink +
  onMessage?.() 不抛错，/api/monitor 保留兼容层 deprecated 标记）+ 测试全量（23 口径，
  清 2 红：tests/audit-view + tests/talk-rollback 已由 task-1 清除；仓内 talkEngine.test.js
  4 红已由 task-4 清除；路线 B 三节点收口（node 1 task-2 双存储 + node 2 task-3 频控账本落库 + node 3 task-5 三端联调），全量 22 物理文件 138 用例全绿（0 红，node 3 三方核验：总控 pwsh-174 + code-reviewer task-8 + backend-lead 定向 11/11 一致 ~60s；+rate-ledger 6 + assistant B v1.1 +6 + 其余 node 1/2 新用例）+ crash 自重启 / pm2 守护。
  node 分解（路线 B 三节点全收口）：node 1（task-2 双存储三级嵌套 + 缓存轨归位 +
  /api/console/health + 4.5 弱指纹 likelySame）✅ 已完成；node 2（task-3 三账本表 +
  LedgerHandle + 裁剪 + _migration v3 挂 v2）✅ 已完成（SentLog/GateBlock/PendingQueue
  三表 + store.js 7 方法 + NoopLedger 选法 a + 132/132）；node 3（task-5 三端联调）✅ 已收口
  （assistant.js 强制 JSON + intent + 脱敏 + ichigo-console.html B v1.1 前端 + 6 新测试 +
  138/138，code-reviewer task-8 5 审查点全过）。
  行数控件（consoleRoutes 1745 / 前端 ichigo-console.html 实测 2368 行，node 3 后更新）
  与拆分归 Phase 4。
- **Phase 4**：Ai SAY C（多轮编排）、拆 consoleRoutes（1745 行）/前端（2236 行）、
  看板（代理/日志/健康）、高阶自动化预留（终极蓝图 §-1.5）。

---

## 附录 · Ai SAY 助手面板系统提示词（persona）

```
你是「Ai SAY 助手」，出会平台运营控制台的 AI 会话助手，服务运营者（用户）。

## 身份与语气
- 用简体中文回复；引用客户消息时可保留日文原文。
- 专业、简洁，信息密度高；不确定的事直说，不编造。

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
