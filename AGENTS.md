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
> 2026-10-27 v5.2（快乐平台引流全流程实测 + 代码债清偿）：测绘图升级 v5.2（§10，13 API + 发送/撤回链路坐实）；
> happy*Expr 3 处 API 路径已修 + 4 新 Expr（帖子列表/详情/撤回/发送坐实）+ happy.js 端点分域表 +
> schema.sql 新增 ContactRecruitPost 表（_migration v5）+ store.upsertContactRecruitPost +
> 快乐 customer 路由/缓存透传 recruitPosts；全量测试 231/231 全绿（测试已增长，物理口径以现跑为准）。
> 2026-10-27 v5.3（用户 10 项反馈扩展，按批次落地）：
>   批1 群控基座：TaskQueue 跨账号任务分发表 + store 账号池/窗口池/任务方法 + /account-pool /tasks 路由 + 前端账号池看板
>   批2 未读轮询：unreadPoller（30s 非秒回，发现新未读→自动备料 查资料/历史/招募帖，不发消息）+ /poller 路由 + index 接线
>   批3 C 多轮状态机：Conversation.followupStage（探测式 ADD）+ FollowupSop 表 + followupSop 引擎（3天加ライン，LINE 一律「ライン」软推进/关心/理解退路，男性付费语境）+ /followup 路由 + 前端 SOP chip + SOP 种子
>   批4 LINE 接入：docs/plan/line-integration.md 设计稿（数据地基 LineMember/LineBind 已有，三期路线）
>   批5 守护+使用方式：start-guarded.bat（pm2 守护）+ README 启动方式段（前台 vs 守护）
>   批6 备忘录：Memo 表 + /memos 路由 + 前端工具箱面板（写入/删除）
>   批7 日历：CalendarEvent 表 + /calendar 路由 + 前端待办日历
>   批8 模板库升级：PhraseLibrary 表（场景标签+多语言+人设过滤）+ /phrases 路由 + 前端工具箱（复制/新增）
>   批9 未读增量：#msg_notification_cnt 增量逻辑进 unreadPoller 基线（5 单测坐实）
>   批10 后期（移动端）：暂缓
>   全量测试 245/245 全绿（含 followupSop 9 用例 + unreadPoller 5 用例 + 新端点回归）。

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
| start-console.bat / stop-console.bat / start-guarded.bat | 前台启动（先清 8300）/ 停止 / pm2 守护启动 |
| server/acquisition/followupSop.js | v5.3 C 多轮状态机：3天加ライン SOP 引擎（care/nudge/understand 三类，LINE 一律 ライン） |
| server/adapter/unreadPoller.js | v5.3 未读轮询器（30s 非秒回，发现新未读→自动备料不发消息） |
| docs/plan/line-integration.md | v5.3 LINE 接入设计稿（三期路线） |

**运维事实**
- 控制台：http://127.0.0.1:8300/ichigo-console 与 /console；端口 8300（PORT/HOST 可覆盖）。
- 比特浏览器 API：http://127.0.0.1:54346（BitBrowser 自身 54345，BIT_BROWSER_API_URL 可覆盖）。
- 出会窗口 windowId：2315e879dd6642559bdc11a07bb1fc43（自用出会，勿删）。
- 启动/停止：start-console.bat / stop-console.bat（bat 必须 CRLF 换行）。
- 测试：node --test 全量（双口径见 §1.6；npm test 只覆盖 4 个文件，要手动全量）。

**快乐平台机制（happymail.co.jp / 18595 窗口，v5.2 坐实）**
- 渲染：.php 服务端渲染 + 13 业务 API POST（/sp/app/api/html/*.php）；CDP 调试口动态（每 /browser/open 现取），target 匹配 url 含 happymail.co.jp
- 13 API（读/发/撤/帖四类，全部 POST /sp/app/api/html/ 下）：读=list_message(收件箱全量)/message_detail(会话全量)/list_profile_gallery(检索)/list_billboard(BBS)/typelist(点赞三路)/list_profile_ashi(足迹)/get_profile_fixed_phrase(客户画像40+字段)/get_notification_banner_info(通知)；发=send_message.php；撤=getTextMessageRevokeStatus.php+revokeTextMessage.php；帖=get_profile_billboard.php(客户帖子列表)+get_billboard.php(单帖正文 billboard_body+标签 scene_name_list+电话号码)
- token 分域：读数据 API 用会话 UID；发送/撤回/帖子域用独立 token（动态获取），写项目按域分组
- 发送：进 message_detail.php?mailID={b64} → form#send_message（41 字段含 ukey/UID/twilio 风控隐藏字段）→ textarea#text-message（maxl=800，支持 \n 换行→<br>）→ 点 .icon-message_send → 确认层点「送信する」→ POST send_message.php(200) + 新 .message__block--send + 未読标记
- 撤回：消息块 button.revokeTextMessage（仅自己发的、对方未读、时限内）→ remodal「送信取消について」点「送信取消」→ revokeTextMessage.php。撤回对对方可见，对方可能已看到部分
- 客源 4 路 UNION：点赞(typelist) + 检索(profile_gallery) + 募集(billboard) + 足迹(ashiato=主动看我的人)
- 话术生成规则：三要素（人设+画像+上下文）→ 思考过程 5 维度（时间/撤回/人设/意向/竞争）→ 多维度选项（推进明天/周末/先交往/轻快唤回）+ 原文+译文+判断；每句一行（\n）；铁律 AI 只出草稿，真发走 建议→确认→执行，未确认绝不发
- 防误发校验：发送前 header 含目标客户名 + #send_message 存在 + 全量聊天确认未发过；撤回前目标 messageId 块 + .revokeTextMessage 按钮存在
- 测绘图：docs/survey-happymail-20261025/report/全域DOM结构拓扑图.md（v5.2，§10 全链路）；原始存档同目录 flow-haruki/
- Adapter 现状（v5.2 补全 2026-10-27）：server/adapter/happy*.js（12 个 happy*Expr，含帖子列表/详情/撤回 4 新 Expr + 3 处 API 路径已修 /sp/app/api/html/），happy.js 13 API 端点分域表（getApiEndpoints）+ getRevokeExpr/帖子 getter，happyScanner.scanCustomer 抓 recruitPosts，happyCache 透传，consoleRoutes /happy/inbox/customer 返回 recruitPosts，store.upsertContactRecruitPost + schema.sql ContactRecruitPost 表（_migration v5）；全量测试 231/231 全绿


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

**C 阶段（v5.3 已落核心）**：多轮状态机 + 多步任务分解 + 工具链 + 批量确认卡。
  - **多轮状态机已落**（v5.3 批3）：Conversation.followupStage（0破冰/1跟进中/2约见面/3已推ライン/4私域/5冷却）
    + server/acquisition/followupSop.js 跟进引擎（3 天加ライン SOP，LINE 一律写「ライン」软推进，
    关心 care / 软推进 nudge / 理解退路 understand 三类话术，男性付费语境）+ FollowupSop 规则表 +
    /api/console/followup 路由 + 前端「⏰ 跟进 SOP（加ライン）」chip + index.js 默认 SOP 种子。
  - **跨账号任务分发已落**（v5.3 批1）：TaskQueue 表 + store.enqueueTask/claimTask/finishTask +
    /api/console/tasks（入队/分发/完成）+ /api/console/account-pool（账号池+窗口健康巡检）。
  - **未读轮询已落**（v5.3 批2）：server/adapter/unreadPoller.js（30s 非秒回，发现新未读→自动备料
    查资料/历史/招募帖，不发消息）+ /api/console/poller 路由 + index.js 接线 + 前端账号池看板。
  - **运营工具箱已落**（v5.3 批6/7/8）：Memo（备忘录）/CalendarEvent（日历）/PhraseLibrary（模板库升级，
    场景标签+多语言）三表 + /memos /calendar /phrases 路由 + 前端「🧰 工具箱」面板（写入/复制/新增）。
  - **LINE 接入设计稿已落**（v5.3 批4）：docs/plan/line-integration.md（数据地基 LineMember/LineBind 已有，
    三期路线：OA 申请→Messaging API→平台内 SOP 触发导流闭环；个人号代接仅研究不上线）。
  - 剩余：多步任务分解状态机（stage 转移自动化）+ 批量确认卡 + 看板可视化（Phase 4）。

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


---

## 附录 · 架构决策备忘（呼吸引擎 + 二期集群化，2026-10-30 外脑对齐）

> 本附录归档外部架构顾问（外脑）针对 Ai SAY「群控引流」四阶段蓝图的设计裁定，共 3 轮对齐。
> **这是设计契约，不是已落地代码。** 落地以本备忘 + §四「勘误与修正」为准。

### 一、四阶段蓝图总纲
1. **基建防风控**：双层代理（Kookeey 动态住宅 IP 做高优补充 + IPDeep 粘性做常态基座），按任务风险级别路由，单次登录生命周期内绝不切 IP（启动取一个动态住宅 IP，该任务 2-4h 内保持粘性，任务结束休眠，下次唤醒再取新 IP）。
2. **低成本引流**：足迹自动化（单账号日上限 150、分 3 时段错峰、CDP 无痕）+ 揭示板矩阵占位（严格守 1h 冷却铁律：检测沉底 → 立即删帖 → 进 1h 休眠队列 → 冷却期满唤醒发新帖）。
3. **AI 聊单 + 熔断**：每会话一个无状态 Agent（Serverless 用完即走）；双轨熔断（正则硬熔断 LINE/ID/QR + LLM 语义软熔断）；硬熔断标记 high_intent 推 TaskQueue 人工兜底队列，前端置顶 + 视觉/声音提醒，人工黄金 3 分钟介入。
4. **LINE 私域 + 变现**：中间跳转页承接（公域不发带参 LINE 链接）；8-10 个人号 + 2 OA；一期 CPA 联盟/低客单电商，二期高客单（玄学/情感）必须先过日本本地法务（特商法 + 灵感商法监管）。

### 二、一期核心：呼吸感调度器（breathEngine）
- 落点 `server/acquisition/breathEngine.js`（新建，与 `followupSop.js` 同域；宏观 SOP vs 微观节拍通过 TaskQueue 表解耦，不互相 import）。
- 双段节拍：pre_fixed → pre_random → 执行 → post_fixed → post_random；每拍独立采样（Irwin-Hall 三角分布近似：两次独立 crypto.randomInt 取均值，O(1) 向中位聚拢）。
- 调度公平：GROUP BY accountId + MIN(nextWakeAt) 折叠每账号最早到期，内存 Round-Robin（每 500ms tick 每账号最多派 1 单，MAX_DISPATCH_PER_TICK=4 环形游标），单账号串行互斥锁 inFlightAccounts。
- 4 条契约锁死：
  - D1：仅调度 accountId IS NOT NULL 的已绑定任务；无主任务入队 → 分配器绑定账号，归上游独立模块，不进 004。
  - D2：401/403/429/503 连续异常计数复用 TaskResult 按 accountId 倒序聚合最近 3 条（限定 executedAt >= AccountProfile.updatedAt），不落内存 Map。
  - D3：inFlightAccounts 进程级互斥，重启即归零由 clusterCoordinator 基于 claimedAt 租约回滚接管；单步套 120s Promise.race 超时守卫。
  - D4：AccountProfile.pool 每日 00:05 JST 守护任务自动晋升（注册满 7 天 + 近 72h 无硬熔断 + manualPoolLock=0 时 warmup → veteran），支持人工锁覆写。

### 三、二期集群化定案
- B1 NodeRegistry 自注册 + 惰性摘除（30s 心跳 / 90s 失联 / adminStatus 只管运维上下线）。
- B2 幂等键 ${accountId}:${taskType}:${batchId}:${seq}（UUID 批次号），CAS 抢单 changes===1；claimed_at + claim_token 租约（120s）+ 孤儿回滚（15s 巡检，重派延迟 5s）。
- B3 CDP 长连接常驻 + withTarget 断线重连，仅账号进跨小时批次休眠时主动销毁。
- B4 LineAsset 加 warmup_stage + manual_stage_lock（每日 00:05 JST 评估：new/fresh/active/veteran 7/30/90 天自动晋升，配额 3/8/15/25）。
- B5 CPA 归因 S2S Postback 实时主通道 + 每日对账兜底；LeadCapture 加 attribution_sub_id UNIQUE + 三币种字段（cpaAmountJpy / fxRateToCny 默认 0.048 / cpaAmountCny）。
- B6 二期玄学/情感咨询先过日本本地行政书士/法务 review + 特商法明示，包装「传统文化心理倾听」。

### 四、勘误与修正（我核实真实 schema 后，外脑 DDL 的 4 处必须改）
> 外脑给的 004 脚本与 5 大伪代码基于「理想 snake_case schema」，与 Ai SAY 真实 schema（camelCase）冲突，以下 4 处落地时必须修正：
1. **TaskQueue.type 列不能加 CHECK( business/high_intent/system_exception )**：真实 TaskQueue.type 注释是 scan/followup/post/recruit/line-push（任务动作类型），现有 store.enqueueTask 默认 type=scan，加此 CHECK 会崩全部现有入队。改为新开 taskClass 列（CHECK business/high_intent/system_exception）与 type（动作）正交。
2. **TaskQueue 主键 taskId 是 TEXT（现有 enqueueTask 用 sha1(task/type/...) 生成）**，外脑伪代码 INSERT INTO TaskQueue(accountId,type, ...) 漏了 taskId + createdAt/updatedAt（TEXT，ISO 字符串，现有 now()=new Date().toISOString()），直接插会报错。修正：INSERT 必须补 taskId + createdAt/updatedAt（ISO）。
3. **GovernanceRule 存量行回填**：外脑的 GROUP BY scene,accountGroup + MIN(rowid) 写法在「所有存量行 scene/accountGroup 同为默认值」时只有一组，会把所有非首行存量旧规则（compliance/rateLimit/...）全改成 legacy_<ruleId>，污染语义。修正：存量行统一 scene=legacy，呼吸规则新插时 scene 用真实值（like/footprint/first_msg/recruit_post/delete_post/exception），唯一索引改为部分索引 CREATE UNIQUE INDEX idxGovSceneGroup ON GovernanceRule(scene, accountGroup) WHERE scene NOT IN (legacy, default)，存量行不进唯一索引、永不冲突。
4. **AccountProfile vs Account 关系**：真实已有 Account 表（accountId/platform/label/status/legacyKey），store.js 已有 upsertAccountProfile 写 Account + WindowInstance。外脑新建 AccountProfile（pool/bitWindowId/currentPersonaId/proxyChannel/ipBindingJson/registeredAt）是账号物理主档案，与 Account（身份归一）互补不替代；accountId 主键语义对齐 Account.accountId。

### 五、MVM 验收口径（C 档定案）
- C1 封禁率 <10%：硬封 + 软封合并计数（日本平台极少删号，Shadowban/静默吞私信/强制弹年龄认证/高频验证码 都算损耗分子），数据源 = TaskResult 连续 401/403 + 人工每日巡检各窗口登录态。
- C2 内存不泄漏：4h~7h 连续 3h RSS 均值作 Baseline + 6h 滚动 OLS 斜率（每 5min 采样，72 点窗口）；Node 30MB/h 或末值 >1.5×Baseline、Python 20MB/h 或末值 >1.4×Baseline 任一超阈值报警。
- C3 CDP 重连金丝雀：cdp_reconnect_rate >=95% + cdp_reconnect_avg_ms <=5000ms，进 /api/console/funnel 扩展字段，标黄预警。

### 六、线索池（Lead）一期落地决策（2026-11-02 用户裁定）
> 一期「侦测→线索池」全链路已落地：出会 17098 五维度探测（点赞 like 65 / 帖子 bbs 37 已灌库；
> 足迹 ashiato 当前 0；检索 search 待用户定条件；特征 faces 用户裁定搁置并清库）。
> 实机坐实 + 修复清单：
1. **点赞表达式按实机 DOM 重写（ichigoLikeExpr.js v5）**：卡片真实结构 =
   .type-list-name（名）/ .type-list-age span（在线图标 + 「N岁/市」）/ .type-list-desc .desc-txt（简介）/
   .type-list-thumb img（头像）/ a.type-list-link（资料卡链接）/ .type-list-footstep .type-list-date（时间）。
   旧版正则从整卡文本抠名字全空，已废。
2. **窗口手动控制模式（2026-11-02 用户裁定：禁用自动开窗）**：
   - 路由 POST /api/console/window/open、/close、GET /window/status?windowId=（BitBrowserClient.call 已解包 .data，
     取 resp.list 不是 resp.data.list；窗口列表服务端每页上限 100，目标窗口可能排在第 N 页，需分页扫描，实测 17098/18595 在第 3 页）；
   - liveScanner.openCdpSession + happyScanner（openLiveCdpSafe）加 autoOpenWindow 开关（index.js 默认 false），
     窗口未开 → 抛 window-closed（isRetryable 直抛不重试）→ mailbox/happy 路由降级缓存；
   - 窗口只能由「控制台 开/关 按钮」或 二期任务编排 启动；点 17098/收件箱轮询 不再自动 /browser/open。
   - settings.json 可 autoOpenWindow:true 恢复旧行为。
3. **全域运营 CSS 修复**：domainPage 被 100vh .layout 压在视口外 + body overflow:hidden → 恒空白。
   改 .domain-page{position:fixed;top:48px;left:160px;z-index:100}（盖 5 列、留 160px 菜单可点）。
   切非全域视图必须显式 domainPage.style.display='none'（view.js 5 分支已补）。
4. **重复菜单项清理**：全域运营 children 里 账号池/工具箱 各出现 2 次，删 1。

### 线索池一期定案（后续会话勿再劝改）
- **定位**：线索池 = 平台-窗口 分类的**累积留痕**存储（线索客户 + 资料卡链接），不做细筛；
  年龄/在线/来源维度筛选放**二期任务编排**（漏斗入口）。
- **累积语义**：同客户（memberId 优先，否则 name+age+region+sourceDim 稳定键）重复出现 → 以最新记录为准
  （store.upsertLead：保留最早 firstSeen，刷新 lastSeen，extras._history 记最近 5 条变化轨迹，「已更新」角标）。
- 005 Lead 表：通用字段 + extras JSON（ichigo_feature/happy_feature 平台特色字段）。
- BBS 帖子线索无头像/在线（卡片本身不带），用户接受该不完整度。
- **待办（一期尾巴 + 二期）**：
  1. T1 尾巴：出会检索 search 维度真提交（用户定 年龄/地区/排序 条件 + 页数），灌 Lead「检索」来源；
  2. 任务编排挂窗口启动：breathEngine 唤醒任务时 POST /window/open（替代手动开关的第二入口）；
  3. T3 breathEngine.js 落地（004 DDL 已就位：TaskQueue 呼吸列 + GovernanceRule 场景/养号组 + AccountProfile 池）；
  4. 任务汇报（日报看板：来源分布/完成情况/人工介入提醒）；
  5. 快乐 18595 维度探测（二期，同 Lead 表平台=happymail）。


### 七、线索池地区字段语义（2026-11-03 用户裁定）
- **region = 客户自己填写/平台卡片显示的位置**（如 三重-津市），**不代表检索条件**。
- 检索条件（如「津市を表示中」）只是筛选入口，客户是否真在津市以卡片实际显示的 city/pref 为准。
- 未填位置的线索 region 保持空，不得用检索条件反推填充。
- 存储格式：pref-city 组合（如 三重-津市）；pref 缺失时只用 city。
- 前端线索池展示：region 列加 tooltip「客户自己填写的地区（检索条件不代表客户位置）」，
  分组头部固定说明「地区 = 客户自己填写的位置（按实际显示为准，非检索条件）」。


### 八、快乐平台（happymail/18595）线索池二期（2026-11-03 落地）
- **POST /api/console/leads/explore-happy**：18595 窗口 4 路客源（点赞 type / 检索 profile / 募集 bbs / 足迹 ashiato），
  走 **happyScanner.scanSource 导航各客源页读已渲染 DOM**（不是直连 API）→ upsertLead 灌 Lead
  （platform=happymail, accountId=18595）。走 CDP 只读，不碰 /browser/list（不触发 BitBrowser 限频）。
  - 维度映射：like→type_list.php、search→profile_list.php、bbs→keijiban.php、ashiato→ashiato.php。
  - 改走 DOM 的原因：CDP 直连 4 客源 API 全报 errNo=101 (E:04)（缺会话 UID token；window.uid 取值为空、
    cookie 无现成 UID）；DOM 是页面自带会话态渲染好的，绕开 token 问题，更稳。测绘图 §10.1 的 4 API
    直读仅真发/撤回/帖子域才需动态取 token（读数据域走 DOM 更省事）。
- **API 响应字段坐实**（2026-10-25 测绘存档 docs/survey-happymail-20261025/json/，备查）：
  - typelist：type_sita/type_sareta/type_ryoomoi 三路
  - list_profile_gallery：profile_list[]（all_count 1002）
  - list_billboard：billboard_search_result[]
  - list_profile_ashi：profile_list[]（all_count 100）
- **happyScanner 修复（2 处）**：
  1. scanSource 旧调 bit.openLiveCdpSafe()（BitBrowserClient 无此方法，只有 openLiveCdp）被 catch
     吞成 window-not-open 假象 → 改调模块内 openLiveCdpSafe（含翻页探测 + bit.openLiveCdp(windowId,{queue:true})）。
  2. openLiveCdpSafe / probeCdp 翻页扫描（18595 在第 3 页，旧版单页 1000 条找不到 → 误报 window-closed）。
- **happyAshiatoExpr.js（新）**：足迹 ashiato.php DOM 抓取原语（name/age/region/footTime/footRef/memberId）。
  扫描器 routes/exprs 加 ashiato kind，module.exports 加 EXPR_ASHIATO。
- **4 路客源当前全空（实测 2026-11-03）**：18595 账号点赞/检索/募集/足迹均 0 条——平台侧无新数据，
  非功能故障。链路全通（4 页均 ok:true），有数据进来即自动灌库。10-25 探测时 gallery 1002 / 募集 300 /
  足迹 100，现已清空。前端点快乐侦测灌库会显示 emptyNote「4 路客源当前全空——平台侧无新数据，非功能故障」。
- **前端「🔭 侦测灌库」加平台切换**：线索池页加「侦测目标：出会 17098 / 快乐 18595」下拉，按平台调
  /explore（出会）或 /explore-happy（快乐）。

### 九、BitBrowser 限频修复（2026-11-03 用户反馈"被强制退出登录"）
- **根因**：前端 20s 轮询 /window/status × 2 窗口 + 每次分页 30 页 /browser/list = 每分钟上百次调用 → 触发 BitBrowser API 限频 → 强制登出。
- **修复**：
  1. /window/status 加 90s 服务端内存缓存（?force=1 跳缓存查真值，开/关按钮点击后 2.5s 强刷一次）
  2. 前端窗口轮询 20s → 90s
  3. liveScanner.probeCdp 修 resp.list 取值 bug + 翻页 + 60s 缓存（旧版 resp.data.list 恒 undefined → 恒误判窗口关闭）
  4. happyScanner.probeCdp / openLiveCdpSafe 同修
  5. 修后 /browser/list 调用量：每分钟 ≤ 2 次（90s 缓存 + 探测 60s 缓存），不再触发限频
- **教训**：BitBrowserClient.call 已解包 .data，所有 listBrowsers 调用取 resp.list 不是 resp.data.list；窗口列表服务端每页上限 100 条（441 窗口），目标窗口（17098/18595）在第 3 页。


### 十、快乐 type_list 选择器按实机 DOM 重写（2026-11-03）
- 旧 happyTypeExpr 选择器（.ds_type_list_item/.ds_type_name/.ds_type_year/.ds_type_pref）全部未命中 →
  11 条卡片抓成空壳（name/age/region 全空）→ upsertLead 合并成 1 条空 lead。
- 实机 DOM 坐实（type_list.php · li.type_list_outer）：
  - 名字 = .ds_like_list_name（.container_right 下）
  - 年龄+市 = .ds_like_list_age（如「50代半ば 札幌市」，需 regex 拆 age/city）
  - 时间 = .ds_like_list_date_last_login_list（点赞时间，extras.like_time）
  - 详情行 = .ds_like_list_item / .ds_common_profile_detail_list_text（职业/身高/风格/收入）
  - 头像 = .ds_thum_contain（bg 或 img；svgz_icon = 默认头像需过滤）
- happyTypeExpr.js 已按上表重写；explore-happy like 分支同步升级（selfIntro=detail, extras.like_time）。
- 灌库实测（18595）：我点赞 7 条（にんじん/ある/ボリ/ミッコリ/つぶ/えいと/ケンタ，札幌/江别/富良野/釧路等），
  对方给我 0、互赞 0（真实状态，非 bug）。18595 快乐线索池 = 7 条。


### 十一、快乐 type 维度「灌入 0 条」根因与修复（2026-11-03）
- 现象：按钮点「快乐 18595 侦测灌库」提示「灌入 0 条（共 7 条）」+「4 路客源全空」。
- 根因 1（服务未重启）：服务进程仍加载旧 happyTypeExpr（loadExpr 启动时读盘进内存），
  旧选择器全未命中 → 11 卡片抓成空壳 → 灌 0 有效条。重启后加载 v2 即恢复。
- 根因 2（navigate 等待不足）：happyScanner.navigate 旧版只等 2.5s，快乐客源页数据是 JS 动态填的
  （需 ~6-10s）→ 卡片未渲染就读 → 0 条。已升级为 CDP 侧同步轮询：每 800ms 探一次目标 class
  （.type_list_outer/.profile_list_big_item/.ds_billboard_item/.ashi_list_item/.ds_like_list_item），
  最多 20s；单次 evaluatePage 报 "navigated or closed" 属正常，不再跳出循环。
- 防脏：explore-happy like 分支加「空名字/全选行不过滤」保护（name 空或 raw 含「すべてを選択」跳过）。
- emptyNote 文案更正：「本次没有灌入新线索（可能已有记录未变化，或平台侧暂无新数据）」——
  区分「真没数据」与「去重未变化」。
- 库内 18595 现有 7 条真实 like 线索（にんじん/ある/ボリ/ミッコリ/つぶ/えいと/ケンタ，独立进程已验证）。


### 十二、快乐在线状态(平台真实点颜色,2026-11-03 用户纠正)
- 快乐 type_list.php 卡片年龄前有一个**平台真实在线点**:${'}  <span class="last_login_icon_detail_small_list" style="background-color: #2AB788"></span>${'} 等。
  在线档读它的 **background-color**,不是按「最后登录 24h/7d」估算(用户纠正:平台点色才是真信号):
  - #2AB788 绿 = 在线(happy-green)
  - #F3B117 黄 = 不常在线(happy-yellow)
  - #D3D3D3 灰 = 离线(happy-gray)
  - 兜底:点色读不到时回退按最后登录 24h/7d 估算(同为 happy-green/yellow/gray 命名)。
- 落地:happyTypeExpr 读 .last_login_icon_detail_* 的 background-color 映射 green/yellow/gray;
  explore-happy like 分支写 Lead.online=happy-green/yellow/gray + extras.online_dot/last_login;
  前端 loadLeads 按 happy-* 渲染 🟢/🟡/⚪ + tooltip。
- 实测(18595,7 条 like):にんじん/ケンタ=绿(在线),ある/ボリ/ミッコリ/つぶ/えいと=黄(不常在线)。
- 会出 17098 的 online 列保持原语义(online-icon1/2/3 实时档),两平台 online 列并存、前端各自匹配。


### 十三、T3 任务编排：呼吸引擎 breathEngine 落地（2026-11-03）
- **server/acquisition/breathEngine.js（新，345 行）**：宏观调度器，把 TaskQueue「有主 + 已绑账号」的
  呼吸任务按拟人节拍唤醒。
  - 双段节拍 pre_fixed→pre_random→执行→post_fixed→post_random，Irwin-Hall 三角分布近似
    （两次独立 crypto.randomInt 取均值，O(1) 向中位聚拢，§二）。
  - 调度公平：GROUP BY accountId + MIN(nextWakeAt) 折叠每账号最早到期 + 内存 Round-Robin
    （每 500ms tick，MAX_DISPATCH_PER_TICK=4 环形游标），单账号串行互斥锁 inFlightAccounts（D3）。
  - D2：连续异常计数 = 按 accountId 倒序聚合最近 3 条 TaskResult（401/403/429/503），≥3 次硬熔断
    → 推 high_intent（TaskQueue type=exception，前端置顶）。
  - D4：每日 00:05 JST 晋升守护（用户 2026-11-04 裁定去掉「注册满 7d」门槛：warmup→veteran 仅看 近 72h 无硬熔断 + manualPoolLock=0；registeredAt 不参与判定）。
  - 抢单 CAS：claimed_at + claim_token 租约 120s + 幂等键（B2）。
  - **铁律边界**：引擎只调度节拍（何时唤醒 + 抢单 + 异常熔断），**不直接发消息/发链接**——
    真实业务副作用由 SOP 执行器（onTask 钩子）驱动，符合铁律 0.1（AI 永不直接发）。
- **接线**：index.js require + 实例化（注入 store）+ 默认不 start（启停走路由）+ D4 每日守护
  setInterval；mountConsoleRoutes 注入 breathEngine。
- **路由组 /api/console/tasks/breath/***（consoleRoutes.js）：
  - GET /status · POST /start · POST /stop · POST /enqueue（入队 + 写 004 呼吸列 nextWakeAt/breathRuleId）
  - POST /rules/seed（GovernanceRule 6 场景 breath 规则播种，幂等）· GET /board（看板数据）
- **前端**（domain.js 线索池页）：「📋 任务编排（呼吸引擎）」看板块 = 播种呼吸规则 / 入队示例任务(30s) /
  启动引擎 / 停止引擎 / 刷新看板 5 按钮 + 状态行（引擎运行态 + 队列 pending/done/failed + 来源分布 +
  high_intent 人工介入提醒，悬停看明细）。
- **测试** tests/breath-engine.test.js 5 用例（os.tmpdir 不碰现网）：irwinHall 区间 + 均值中位聚拢 +
  tickOnce 抢单 CAS 翻 done + D2 连续 429 熔断 + D4 晋升（含 manualPoolLock 不晋升边界）全绿。
- 全量测试 245/0。
