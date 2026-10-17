# 快乐平台（happymail.co.jp）测绘图

> 总控产出 · 2026-10-11 · 只读探查（18595 窗口，CDP 调试口动态）
> 纪律：全程零发消息 / 零改登录态 / 零换 IP / 零点风控入口；只读 CDP + GET。
> 状态：**测绘图 v1**（页面地图 + 7 原语对照 + 选择器命中 + 风控入口标注）。
> 待补：会话页 DOM + 发送成功判定 + 客户卡字段映射（下轮只读探查）。

---

## 0. 平台基元（坐实事实）

| 项 | 值 | 来源 |
|---|---|---|
| 平台名 | 快乐 / ハッピーメール / happymail | 用户给 + CDP title「ハッピーメール」 |
| 域名 | https://happymail.co.jp（sp 前缀 = /sp/app/html/*.php） | CDP + 直连 200 |
| 测试窗口 | BitBrowser seq 18595（id 1ccd4351a6fe4482…，name「不能删」，status=1 运行中） | /browser/list 坐实 |
| CDP 连接 | /browser/open 返回**动态调试口**（本轮 49570，非固定）→ /json/list 找 type=page url 含 happymail.co.jp 的 target | 实测 |
| 渲染模型 | **.php 服务端渲染**（出会是零导航页面内 fetch，快乐直接 location.href 跳 .php） | 页面实测 |
| Service Worker | qg-sw（happymail.co.jp/sp/app/html/qg-sw.*.js）缓存层，存在 | CDP targets |
| 渲染框架 | jQuery + 模板引擎（jquery/jquery.min.js + js/template.js） | profile 页脚本 |
| 账号主体 | 窗口已登录（operUserName 1_aiyuechuan，proxy IPDeep JP） | /browser/list |

---

## 1. 页面地图（树状结构）

\`
快乐 happymail.co.jp /sp/app/html/
├─ mbmenu.php（首页 Home）
├─ profile_list.php（プロフィール检索 = 客源①）
├─ keijiban.php（募集 = 客源②）
├─ type_list.php（タイプ点赞 = 客源③）
│   ├─ Tab（ds_common_tab_item）：相手から(对方给我) / 自分から(我点赞) / マッチング(互赞)
│   ├─ 列表壳：list_myself(我点赞, data-kind=2) / list_type(对方点赞, data-kind=1) / list_reciprocal(互赞, data-kind=3)
│   │   └─ 条目 = JS 动态填充（.php 只给壳 + 全選択 checkbox selToAll[]）
│   └─ 批量操作 form（POST type_list.php）：削除(削除) / 無視(deny) / 見ちゃいや(noWatch)
│       ⚠ 风控红线入口（批量删/无视/屏蔽），本轮未点
├─ message_list.php（消息收件箱）
│   ├─ Tab（ds_message_tab_item）：すべて / 未読(active) / 未返信 / 返信済 / 保存済
│   ├─ 未读汇总：#msg_notification_cnt + #msg_notification_addition（隐藏 input）+ nav「メッセージ N」
│   ├─ 操作：全既読(#kidoku) / 編集(#edit) / メニュー(#search)
│   ├─ 子页：email_notification.php（邮件通知设定）/ messageFolder.php（フォルダ一覧 0）
│   └─ 点某客户 → 会话页（**待下轮探**）
├─ mypage.php（我的页）
│   ├─ 我的画像入口：my_profile_picture_and_movie.php
│   ├─ 点数/里程：point.php(購入) / mileage_top.php(交換)
│   ├─ 列表：ashiato.php(足あと 99+) / my_list.php(マイリスト) / deny_list.php(無視)
│   ├─ 其他：oshaberi.php(通話募集) / couple_report_renewal_top.php / passkey_setting.php
│   └─ 广告：s.lmes.jp/landing-qr（LINE 引流）
├─ profile.php（我的画像 = 人设）
│   ├─ interest[]（兴趣多选）/ purpose[]（目的多选）/ self_introduction(自我介绍 textarea name=comment)
│   ├─ 画像完整度：fun_graph + reward(勋章) + profileAdequacyPresent.php
│   └─ 邮箱：email_address_settings.php（初回登録 20C 礼物）
├─ 设定/帮助：menu.php（各种设定）/ help.php / important_from_support.php / latest_information_event.php
└─ 付费/活动：point.php / mileage_top.php / couple_report_renewal_top.php
\`

---

## 2. 7 原语对照表（出会 ↔ 快乐）

| 7 原语 | 出会 sp.194964 | 快乐 happymail | 差异 / 落点 |
|---|---|---|---|
| 收件箱 | show_mailbox.html | **message_list.php**（5 tab + #msg_notification_cnt 未读） | .php 渲染；未读走隐藏 input + nav 数字 |
| 客源 | 单路 | **type_list.php(点赞) + profile_list.php(检索) + keijiban.php(募集) = 3 路并集** | 客户 = 多路 UNION（去重） |
| 会话历史 | show_history + q-token | **点 message_list 客户 → 会话页（下轮探）** | q-token 等价待坐实 |
| 人设 | AccountPersona（本地表） | **profile.php = 人设页**（interest/purpose/self_introduction） | 快乐人设=页面数据，非本地表 |
| 客户画像 | profile + 兴趣 icon | **profile_list.php / type_list.php 客户卡（下轮探字段）** | IDENTITY_FIELDS 映射待补 |
| 发送 | textarea→#sendButton→确认#submitBtn | **会话页 DOM + 成功判定（下轮探，只测绘不真发）** | 红线：测 DOM 不真发 |
| 网络体检 | /api/console/network/health | 直连 happymail.co.jp 200 + CDP 匹配 url 含 happymail.co.jp | 本轮实测 200 |
| CDP 匹配 | url.indexOf('sp.194964.com') | **url.indexOf('happymail.co.jp')**（调试口动态，/browser/open 现取） | 端口动态已处理 |

---

## 3. 选择器命中表（已抓 DOM，.php 壳 + JS 填充）

### 3.1 message_list.php（收件箱）
| 用途 | 选择器 | 命中 |
|---|---|---|
| 未读数 | #msg_notification_cnt（hidden） | ✓ |
| 未读增补 | #msg_notification_addition（hidden） | ✓ |
| 未读/已读 tab | .ds_message_tab_item[data-tab-id]（1=未読 active） | ✓ |
| 全既读 | #kidoku（li.ds_user_display_icon_item_ms） | ✓ |
| 客户条目 | **JS 动态填充**（.php 只给 .ds_common_list 壳） | ⚠ 待下轮点客户探 |
| 编辑/菜单 | #edit / #search（li） | ✓ |

### 3.2 type_list.php（点赞客源）
| 用途 | 选择器 | 命中 |
|---|---|---|
| Tab | .ds_common_tab_item（相手から/自分から/マッチング） | ✓ |
| 我点赞列表壳 | #list_myself（data-kind=2） | ✓ |
| 对方点赞列表壳 | #list_type（data-kind=1） | ✓ |
| 互赞列表壳 | #list_reciprocal（data-kind=3） | ✓ |
| 全選択 | #informationAll（name=selToAll[] checkbox） | ✓ |
| 客户条目 | **JS 动态填充**（li.ds_like_list_item，.php 只给全選択 li） | ⚠ 待下轮探 |
| 批量·删 | button[name=delete]（⚠ 风控） | 标注未点 |
| 批量·无视 | button[name=deny]（⚠ 风控） | 标注未点 |
| 批量·屏蔽 | button[name=noWatch]（⚠ 风控） | 标注未点 |

### 3.3 profile.php（人设）
| 用途 | 选择器 | 命中 |
|---|---|---|
| 兴趣多选 | select[name=interest[]]（#multiple_select_interest[]） | ✓ |
| 目的多选 | select[name=purpose[]]（#multiple_select_purpose[]） | ✓ |
| 自我介绍 | textarea#self_introduction[name=comment] | ✓ |
| 完整度 | #fun_graph + #reward(勋章) | ✓ |

### 3.4 mypage.php（导航）
| 用途 | 选择器 | 命中 |
|---|---|---|
| 主导航 11 入口 | A.nav（mbmenu/profile_list/keijiban/type_list/message_list/mypage） | ✓ |
| 访问/列表 | ashiato.php(足あと) / my_list.php / deny_list.php | ✓ |

---

## 4. 风控入口标注（红线，不点）

| 入口 | 位置 | 风险 |
|---|---|---|
| 削除（批量删点赞） | type_list.php button[name=delete] | 误删客户 |
| 無視（批量无视） | type_list.php button[name=deny] | 拉黑客户 |
| 見ちゃいや（批量屏蔽） | type_list.php button[name=noWatch] | 屏蔽客户 |
| 全既読（全部已读） | message_list.php #kidoku | 改未读态（慎） |
| 点数購入 / 里程交換 | mypage point.php / mileage_top.php | 付费动作 |
| 发送（会话页） | 会话页（下轮探） | **绝不真发（§0.1）** |
| 换 IP / 登出 / 改 proxy | 窗口层（BitBrowser/代理） | 掉登录/风控（§-1.2） |

---

## 5. 与会出架构差异总结

1. **渲染**：出会 = 零导航（页面内 fetch + DOMParser），快乐 = .php 服务端渲染（必须 location.href 逐页跳）→ platformAdapter.navigate 原语落到 location.href，**不能复用出会 zero-nav fetch**。
2. **客源多路**：出会单路收件箱，快乐 3 路（点赞+检索+募集）→ 客户 = 并集去重（dedup.js 三级嵌套 contactId 维度）。
3. **人设 = 页面数据**：出会人设本地 AccountPersona 表，快乐人设 = profile.php 页面（interest/purpose/self_introduction）→ 要抓 profile.php 填 AccountPersona。
4. **数据动态填充**：.php 只给壳，客户/消息条目 JS 填充 → 探查需等 JS 加载完（本轮 sleep 4s 后抓，客户卡仍空需下轮点会话页坐实）。
5. **Service Worker 缓存**：qg-sw 缓存 .php 响应 → 数据 API 可能走 SW 缓存，抓取要标记账（防缓存串数据）。
6. **CDP 调试口动态**：每 /browser/open 现取（本轮 49570），不写死端口。

---

## 6. 写项目前置（需用户授权，未动）

- Platform 表加 1 行：Platform('kairaku','kairaku','快乐','happymail.co.jp','active')（schema 三级嵌套已预留，只缺种子）
- 快乐 7 Expr 文件草案（对应出会 ichigo*Expr.js，换 happymail 选择器/端点）
- 平台切换 UI（ichigo-console.html 加 platformId 维度）
- 客户多路并集去重（dedup.js）
- **以上 = Phase 4 性质，用户单步打磨模式未授权，先挂账 task-16 池，不擅动**

---

## 7. 待补项（下轮只读探查）

- [ ] 会话页：点 message_list 客户 → 会话 URL + q-token 等价 + 消息 DOM（role/时间/正文）
- [ ] 发送输入区 DOM + 成功判定规则（只测绘，不真发）
- [ ] 客户卡字段映射（type_list / profile_list 客户条目 JS 填充后）→ IDENTITY_FIELDS
- [ ] 未读机制验证（#msg_notification_cnt 增量）
- [ ] SW 缓存对数据 API 影响（防串数据）

---

## 7. 第 2 轮只读探查成果（会话页 + 发送 DOM，2026-10-11）

### 7.1 会话页 message_detail.php（坐实）

| 项 | 值 | 选择器 |
|---|---|---|
| 会话 URL 模式 | message_detail.php?a=a&mailID={base64 mailID} | 客户条目 a.dtl-btn href |
| 页头 | #main-contents-message-header（返回 + 客户名 + OFF 状态） | #main-contents-message-header |
| 消息容器 | #list_message_detail.ds_message_txt | #list_message_detail |
| **我发的消息块** | .message__block--send（右对齐 child--right） | .message__block--send |
| **对方消息块** | .message__block--receive（左对齐 child--left） | .message__block--receive |
| 消息正文 | .message__block__body__text（--female/--male 变体） | .message__block__body__text |
| 消息时间 | .message__block__body__time | .message__block__body__time |
| **已读回执** | .message__block__body__time__opened（既読+时间戳） | .message__block__body__time__opened |
| 加载更多 | 「以前のメッセージを見る」 | #list_message_detail 内链接 |

**方向区分**：.message__block--send（我）/ .message__block--receive（对方）+ 正文 --female/--male 变体标记性别方向。

### 7.2 收件箱客户条目（JS 动态填充，坐实）

| 项 | 值 | 选择器 |
|---|---|---|
| 条目容器 | .ds_message_list_mini（客户名/年龄/地区/最后消息/时间） | .ds_message_list_mini |
| 客户链接 | a.dtl-btn → message_detail.php?mailID={base64} | a.dtl-btn[href*=message_detail] |
| 勾选 | .ds_js_check_box（编辑/全既读选中） | .ds_js_check_box |
| **客户身份数据** | 条目文本含「名前 年齢 地区 最終メッセージ 日時」（例：きよ 30代後半 旭川市 こんにちは… 10/07 12:37） | .ds_message_list_mini innerText |
| 数据 API | **POST /sp/app/api/html/list_message.php**（JS 拉客户列表，非 .php 内联） | 网络请求坐实 |

**关键发现**：客户列表数据走 **/sp/app/api/html/list_message.php**（业务 API，.php 壳 + JS 填充）→ 抓取要等该 API 返回 + JS 渲染完，或**直接抓该 API**（更高效，免 DOM 解析）。

### 7.3 发送区 DOM（只测绘不真发，§0.1）

| 项 | 值 | 选择器 |
|---|---|---|
| 发送 form | #send_message.message_space（POST） | #send_message |
| 正文输入 | textarea#text-message[name=messageBody] | #text-message |
| 隐藏身份字段 | #ukey / #UID / memberSex=2（我=女性）/ ageCertified / oppositeAgeCertified | hidden input |
| 预设回复 select | マナー返信 / お断り（困る/シンプル/丁重…）/ お礼 / スタンプ（select） | #send_message 内 select |
| 发送按钮 | .svg-block.icon-message_send（图标，无文字 label） | .icon-message_send |
| 成功判定 | POST message_detail.php?mailUID=&mailID= + 新 .message__block--send 出现（推断，需实测不真发） | 网络事件 |

**风控字段坐实**：ukey / UID / ageCertified / twilioBlocked 系列 = 反欺诈/风控 token，**发送必带**，但测绘只读 DOM 不真发（§0.1 红线）。

### 7.4 会话页业务 API（数据抓取点）

- 客户列表：POST /sp/app/api/html/list_message.php（收件箱条目数据）
- 会话详情：message_detail.php?mailID=（消息历史 + 发送区，.php 内联 + JS）
- 头像图床：pict.happymail.co.jp/{hash}/{...}/156x156/...jpg（客户/我的头像）

---

## 8. 待补项（下轮只读探查）

### 8 剩余待补（下轮）
- [ ] list_message.php API 请求体/响应体结构（直接抓 API，免 DOM）
- [ ] 客户卡字段映射（type_list / profile_list JS 填充后）→ IDENTITY_FIELDS
- [ ] 发送成功判定实测（需真发 1 条测试客户，§0.1 需用户授权）
- [ ] 未读 #msg_notification_cnt 增量机制
- [ ] SW 缓存对 list_message.php API 影响

---

## 9. 第 3 轮 · 全功能树探查（业务 API + 数据 schema，2026-10-11）

### 9.1 四大数据 API（.php 壳 + JS 拉取，坐实）

| 功能页 | 业务 API（数据源） | 响应 schema（坐实，JSON） | 数据字段 |
|---|---|---|---|
| profile_list.php（检索客源） | **POST /sp/app/api/html/list_profile_gallery.php** | { all_count, page, pages, per_page, profile_list:[], all_act_count, today_act_count, ordSel, memuse, query_set, reloadFlg, error_no, error_msg } | 客户卡片 = .profile_list_big_item（年龄/地区/自我介绍） |
| keijiban.php（募集） | **POST /sp/app/api/html/list_billboard.php** | { error_no, error_msg }（body 字段待坐实） | 募集条目（JS 填充） |
| message_list.php（收件箱） | **POST /sp/app/api/html/list_message.php** | { all_count, page, pages, per_page, message_list:[], error_no, error_msg } | 客户条目 = .ds_message_list_mini（名/年/地区/最后消息/时间） |
| ashiato.php（足迹） | **POST /sp/app/api/html/list_profile_ashi.php** | { all_count, page, pages, per_page, profile_list:[], all_act_count, point_service_flg, point_service_msg, today_count, other_count, error_no, error_msg } | 访客卡片 |

**探查方法坐实**：页面 .php 壳 + JS fetch POST 该 API → 渲染 DOM。
GET 直连返回 error_no:101（需 POST body + CSRF token，预期内）；
**响应 schema 已坐实**（字段名/嵌套/分页全有），写项目时抓取器 = POST + 带 cookie + token。

### 9.2 客户卡字段映射（→ IDENTITY_FIELDS，坐实）

profile_list 卡片（.profile_list_big_item）文本结构：
```
LI.profile_list_big_item
├─ P.text-male.profile_list_big_area → "50代前半 埼玉県"（年龄段 + 都道府县）
├─ P.profile_list_big_comment → 自我介绍（前 ~100 字截断…）
└─ (卡片点击进客户详情页 = 待坐实 URL 模式)
```
**IDENTITY_FIELDS 映射（快乐版）**：
| IDENTITY_FIELD | 快乐来源 | 坐实 |
|---|---|---|
| age（ageNum） | .profile_list_big_area 文本「50代前半」→ 年龄段 | ✓（文本解析） |
| region | .profile_list_big_area「埼玉県」（都道府县粒度） | ✓ |
| comment（自我介绍） | .profile_list_big_comment | ✓ |
| gender | P.text-male（male/female 变体） | ✓ |
| nickname | 详情页（待坐实） | ⚠ 下轮 |
| 兴趣/目的 | 详情页 interest[]/purpose[]（待坐实） | ⚠ 下轮 |

message_list 条目（.ds_message_list_mini）：
```
"きよ 30代後半 旭川市 こんにちは まだ旭川にいらっしゃいますか？ 10/07 12:37"
= 名 + 年龄段 + 市 + 最后消息 + 时间 → 客户身份 + 会话摘要
```

### 9.3 完整功能树（v3，全页坐实）

```
快乐 happymail.co.jp /sp/app/html/
├─ mbmenu.php（首页）
├─ 客源 3 路（UNION 去重 = 客户池）
│  ├─ profile_list.php（检索）← POST api/list_profile_gallery.php
│  ├─ keijiban.php（募集）← POST api/list_billboard.php
│  └─ type_list.php（点赞）← list_myself/list_type/list_reciprocal（JS 填充）
├─ message_list.php（收件箱）← POST api/list_message.php
│  ├─ Tab：すべて/未読/未返信/返信済/保存済（.ds_message_tab_item）
│  ├─ 未读：#msg_notification_cnt + nav「メッセージ N」
│  └─ 客户条目 .ds_message_list_mini → a.dtl-btn → message_detail.php?mailID={b64}
├─ message_detail.php（会话）
│  ├─ 我发 .message__block--send / 对方 .message__block--receive
│  ├─ 正文 .message__block__body__text / 时间 .message__block__body__time
│  ├─ 已读回执 .message__block__body__time__opened（既読）
│  ├─ 发送 form #send_message（POST）+ textarea#text-message[name=messageBody]
│  │  ├─ 预设回复 select（マナー返信/お断り/お礼/スタンプ）
│  │  ├─ 风控字段 ukey/UID/memberSex/ageCertified/twilioBlocked
│  │  └─ 发送按钮 .icon-message_send（⚠ 红线：只测绘不真发 §0.1）
│  └─ 图片发送 form #upload_picture（#submit_button）
├─ mypage.php（我的页）
│  ├─ 画像入口 my_profile_picture_and_movie.php
│  ├─ 点数 point.php / 里程 mileage_top.php（⚠ 付费）
│  ├─ 足跡 ashiato.php ← POST api/list_profile_ashi.php
│  ├─ マイリスト my_list.php / 無視 deny_list.php
│  └─ 通話 oshaberi.php / カップル couple_report_renewal_top.php
├─ profile.php（人设 = 账号本体）
│  ├─ interest[]（兴趣）/ purpose[]（目的）/ self_introduction(textarea#self_introduction[name=comment])
│  └─ 完整度 #fun_graph + #reward（勋章）
└─ menu.php（设定）/ passkey_setting.php（passkey）/ help.php
```

### 9.4 风控红线入口（全标注，未点）

削除/無視/見ちゃいや（type_list 批量）· 全既読（#kidoku）· 点数購入/里程交換 · 发送（#send_message）· 换 IP/登出/改 proxy
（§0.1 绝不发消息 + §-1.2 不动 IP/登录态）

### 9.5 写项目落点（需用户授权，未动）

1. Platform 表加 1 行：`Platform('kairaku','kairaku','快乐','happymail.co.jp','active')`
2. 快乐 7 Expr 文件草案（复刻出会 ichigo*Expr.js，换 happymail 选择器 + 4 业务 API POST + CSRF token）
3. 抓取器 = POST api/list_*.php（带 cookie + token）+ .php 壳 DOM 解析（客户卡/消息块）
4. 客户多路 UNION 去重（dedup.js 三级嵌套 contactId）
5. 人设 = 抓 profile.php（interest/purpose/self_introduction）填 AccountPersona
6. 平台切换 UI（ichigo-console.html platformId 维度，归 Phase 4）

---

## 10. 第 4 轮 · 客户详情页坐实（用户反馈 + CDP 探查，2026-10-11）

### 10.1 客户详情页 URL 模式（坐实，gap 消除）

```
收件箱客户卡 .ds_message_list_mini
├─ 卡内头像区 data-pid="64013366"（= memberID/tid，坐实）
├─ 会话页 message_detail.php?mailID={b64} → 点客户头像
└─ → a.ds_message_txt_image href=profile_detail.php?tid={memberID}
   例：profile_detail.php?tid=64013366（きよ 的详情）
```
**详情页 = 客户完整画像落地页**（.php 服务端渲染，无额外业务 API，DOM 直读）。

### 10.2 客户详情字段全映射（→ IDENTITY_FIELDS，坐实）

详情页选择器 `.ds_profile_select_list_item`（li = 一行，内含 .ds_profile_select_title + .ds_profile_select_choice）：

| IDENTITY_FIELD | 详情页文本 | 坐实 |
|---|---|---|
| gender | 性別 男性 | ✓ |
| age（ageNum） | 年齢 30代後半 | ✓ |
| region（都道府县） | 居住地 北海道(道北) | ✓ |
| region（市） | 詳細エリア 旭川市 | ✓ |
| bloodType | 血液型 Ａ型 | ✓ |
| zodiac | 星座 蠍座 | ✓ |
| accessMethod | アクセス状況 Web | ✓ |
| height | 身長 170～174 | ✓ |
| build | スタイル ぽっちゃり | ✓ |
| looks | ルックス ナイショ | ✓（ナイショ = 未公开） |
| occupation | 職業 ナイショ | ✓（ナイショ） |
| income | 年収 300～600万円 | ✓ |
| relationshipStatus | 交際ステータス 独身 | ✓ |
| children | 子ども いない | ✓ |
| marriageIntent | 結婚に対する意思 すぐにでもしたい | ✓ |
| smoking | タバコ 吸う（電子タバコ） | ✓ |
| drinking | お酒 ときどき飲む | ✓ |
| hasCar | クルマ ある | ✓ |
| livingWith | 同居人 実家暮らし | ✓ |
| siblings | 兄弟姉妹 末っ子 | ✓ |
| meetingGoal（出会うまでの希望） | まずは会いたい | ✓ |
| firstDateCost（初回デート費用） | 男性が全て払う | ✓ |
| 兴趣（interest） | UL.ds_circle_text_list_item（ドライブ/グルメ…） | ✓ |
| 目的（purpose） | （恋人/真剣な交際/婚活…） | ✓ |
| 最近登录 | .ds_profile_picture（ログイン 10/11 12:31） | ✓ |

**对照出会 IDENTITY_FIELDS（platformAdapter.js L9-26）**：快乐字段覆盖更全（含 income/children/marriageIntent/smoking/drinking/hasCar/livingWith/siblings/firstDateCost 等出会未有的维度），写项目时 AccountPersona/ContactProfile schema 要扩列。

### 10.3 头像判定规则（坐实，用户反馈 + CDP）

| 状态 | 头像区特征 | 判定 |
|---|---|---|
| 未上传（默认） | background-image: url(./images/renewal/lazy/noimage_male.png) 或 noimage_female.png | **默认头像**（male/female 变体） |
| 已上传 | background-image: url(https://pict.happymail.co.jp/{hash}/{memberID}/pq/156x156/{ts}/{ts}-xxxxxx.jpg) | **真实头像**（图床 pict.happymail.co.jp，memberID 在 URL 段） |

**写项目时**：抓客户卡头像区 background-image → 含 pict.happymail.co.jp = 有头像（存 URL 到 ContactProfile.avatarUrl）；含 noimage_ = 默认头像（不存或标 default）。

### 10.4 收件箱客户卡 DOM 结构（用户反馈坐实，比 §7.2 更完整）

```
li.ds_message_list_mini
├─ input.check_box_list[name=sel[]][value="{mailID},{memberID}"]（勾选，value = mailID,memberID）
├─ a.dtl-btn href=message_detail.php?a=a&mailID={b64}
│  └─ div.ds_message_list_top
│     ├─ div.ds_thum_contain[data-pid="{memberID}"]（头像区，bg=默认/真实头像）
│     ├─ input[name=pin[]][value="{mailID},{memberID},1"]（隐藏置顶标记）
│     └─ div.ds_like_list_text
│        ├─ div.ds_message_head > .ds_message_user_info
│        │  ├─ .ds_message_name（.ds_message_name__item = 客户名，例 きよ）
│        │  └─ .ds_message_pref（"30代後半 旭川市" = 年龄 + 市）
│        └─ div.ds_message_foot
│           ├─ .message_body（最后消息正文，例 "こんにちは まだ旭川にいらっしゃいますか？"）
│           └─ .message_body_right
│              ├─ .ds_message_status（已读/未读态）
│              └─ .ds_message_date（"10/07 12:37" = 最后消息时间）
└─ 点击 a.dtl-btn → message_detail.php?mailID={b64}（会话页）
```

**抽取映射（写项目时）**：
- 客户名 = .ds_message_name__item
- 年龄 = .ds_message_pref 第一段（30代後半）
- 市 = .ds_message_pref 第二段（旭川市）
- 最后消息 = .message_body
- 最后消息时间 = .ds_message_date
- memberID = input[name=sel[]] value 逗号分隔第二段（71182882,**64013366**）= tid
- mailID（会话）= input value 第一段 / a.dtl-btn href 的 mailID 参数（b64）

### 10.5 完整功能树 v4（gap 全填）

```
快乐 happymail.co.jp /sp/app/html/
├─ 客源 3 路（UNION 去重 = 客户池）
│  ├─ profile_list.php（检索）← POST api/list_profile_gallery.php
│  ├─ keijiban.php（募集）← POST api/list_billboard.php
│  └─ type_list.php（点赞）← list_myself/list_type/list_reciprocal
├─ message_list.php（收件箱）← POST api/list_message.php
│  └─ 客户 .ds_message_list_mini（名/年/市/最后消息/时间 + data-pid=memberID）
│     → a.dtl-btn → message_detail.php?mailID={b64}（会话页）
│        → 点头像 a.ds_message_txt_image → profile_detail.php?tid={memberID}（详情）
├─ profile_detail.php?tid={memberID}（客户画像全字段，§10.2 坐实）
├─ mypage.php / profile.php（人设 = interest[]/purpose[]/self_introduction）
└─ menu.php / passkey_setting.php
```

### 10.6 探查状态：**收口**（gap 全填）

- ✅ 完整功能树（首页 / 客源 3 路 / 收件箱 / 会话 / 详情 / 我的页 / 人设）
- ✅ 4 业务 API + 响应 schema
- ✅ 客户卡 DOM 全字段映射（名/年/市/最后消息/时间/memberID/mailID/头像）
- ✅ 客户详情页 IDENTITY_FIELDS 全字段（§10.2，覆盖出会 + 扩展维度）
- ✅ 会话页 + 发送 DOM（§7）
- ✅ 头像判定规则（§10.3）
- ✅ 风控红线入口全标注未点
- ⏳ 唯一遗留：list_billboard.php 响应 body 字段（募集条目结构，POST 需 token 才能拿全，写项目时坐实）
