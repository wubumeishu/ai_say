# 快乐平台（happymail.co.jp）全域 DOM 结构拓扑图

> 总控产出 · 2026-10-25 · 只读探查（18595 窗口「不能删」，CDP 动态调试口 64690）
> 纪律：全程零发消息 / 零改登录态 / 零换 IP / 零点风控入口（删除/无视/屏蔽/全读/付费）。
> POST 仅用于读数据 API（list_* 拉取列表，与页面自身行为一致）。
> 状态：**测绘图 v5（收口版）**，覆盖 12 个 .php 页面 + 7 业务 API + 完整表单 Selector。

---

## 0. 平台基元（坐实事实）

| 项 | 值 | 来源 |
|---|---|---|
| 平台名 | 快乐 / ハッピーメール / happymail | CDP title「ハッピーメール」 |
| 域名 | https://happymail.co.jp（/sp/app/html/*.php + /sp/app/api/html/*.php） | CDP + 直连 200 |
| 测试窗口 | BitBrowser seq 18595（id 1ccd4351a6fe4482…，name「不能删」，status=0 停止态→本轮 /browser/open 打开） | /browser/list 坐实 |
| CDP 连接 | /browser/open 返回**动态调试口**（本轮 64690，每次现取）→ /json/list 找 type=page url 含 happymail.co.jp 的 target | 实测 |
| 渲染模型 | **.php 服务端渲染 + jQuery + template.js**（client-side JS 填充客户/消息条目） | 页面实测 |
| Service Worker | qg-sw（happymail.co.jp/sp/app/html/qg-sw.*.js）缓存层，存在 | CDP targets |
| 账号主体 | 窗口已登录（operUserName aiyuechuan，proxy IPDeep JP 219.100.37.239，session-2675356000-sessiontime-90） | /browser/list |
| 设备指纹 | 核心产品 chrome coreVersion 144，ostype Android，os Linux armv81 | /browser/list |

---

## 1. 完整页面地图（12 页全坐实）

```
快乐 happymail.co.jp /sp/app/html/
├─ mbmenu.php（首页 Home，导航中枢）
│  ├─ 导航 11 入口（.nav A）
│  │  ├─ ホーム          → mbmenu.php
│  │  ├─ プロフ検索      → profile_list.php
│  │  ├─ 募集            → keijiban.php
│  │  ├─ タイプ          → type_list.php
│  │  ├─ メッセージ      → message_list.php
│  │  ├─ マイページ      → mypage.php
│  │  ├─ 購入（点数）    → point.php（⚠ 付费红线）
│  │  ├─ 交換（里程）    → mileage_top.php（⚠ 付费红线）
│  │  ├─ 北海道(道央)    → area.php
│  │  ├─ 未登録          → fortuneJump.php（占い）
│  │  └─ パスキー案内    → important_detail.php?infoId=22382
│  ├─ 业务 API：POST api/list_billboard.php（首页横幅，count=1，billboard_genre=A04）
│  └─ 广告：Google Ads / LINE / Appier / DoubleClick / Facebook Pixel
│
├─ 客源 3 路（UNION 去重 = 客户池）
│  ├─ profile_list.php（检索客源）
│  │  ├─ POST api/list_profile_gallery.php（count=20，all_count=1002，pages=51）
│  │  ├─ 客户卡 .profile_list_big_item（年龄/地区/自我介绍，JS 填充）
│  │  └─ 筛选：search_type / pickup_free / content_name / query_no
│  │
│  ├─ keijiban.php（募集）
│  │  ├─ POST api/list_billboard.php（count=10，all_count=300，pages=30，billboard_genre=A04）
│  │  ├─ 条目 JS 填充（募集主题/成员名/地区/最后消息）
│  │  └─ 写入口：keijiban_write.php?k=0|1（⚠ 风控红线，未点）
│  │
│  └─ type_list.php（点赞）
│     ├─ POST api/typelist.php（tab_select=2；type_sita=对方给我，type_sareta=我点赞，type_ryoomoi=互赞）
│     ├─ 列表壳：#list_myself(data-kind=2)/#list_type(data-kind=1)/#list_reciprocal(data-kind=3)
│     ├─ 全選択：#informationAll（name=selToAll[] checkbox）
│     └─ 批量操作：button[name=delete/deny/noWatch/read/pinning]（⚠ 风控红线，未点）
│
├─ message_list.php（收件箱）
│  ├─ POST api/list_message.php（count=5，all_count=6，pages=2）
│  ├─ Tab（.ds_message_tab_item）：すべて/未読/未返信/返信済/保存済
│  ├─ 未读：#msg_notification_cnt（hidden）+ #msg_notification_addition（hidden）+ nav「メッセージ N」
│  ├─ 客户条目 .ds_message_list_mini（JS 填充，.php 只给壳）
│  │  ├─ input[name=sel[]][value="{mailID},{memberID}"]（勾选，如 71182882,40447426）
│  │  ├─ a.dtl-btn → message_detail.php?a=a&mailID={base64 mailID}
│  │  │  └─ div.ds_message_list_top
│  │  │     ├─ div.ds_thum_contain[data-pid="{memberID}"]（头像区，bg=默认/真实头像）
│  │  │     ├─ input[name=pin[]][value="{mailID},{memberID},1"]（隐藏置顶标记）
│  │  │     └─ div.ds_like_list_text
│  │  │        ├─ .ds_message_head > .ds_message_user_info
│  │  │        │  ├─ .ds_message_name > .ds_message_name__item（客户名，例 はるき）
│  │  │        │  └─ .ds_message_pref（"20代前半 札幌市" = 年龄段 + 市）
│  │  │        └─ .ds_message_foot
│  │  │           ├─ .message_body（最后消息正文，例「会いたいです！」）
│  │  │           └─ .message_body_right
│  │  │              ├─ .ds_message_status（既読/未読态）
│  │  │              └─ .ds_message_date（"昨日"/"10/23 17:24"）
│  │  └─ 点 a.dtl-btn → 会话页
│  └─ 批量操作：#kidoku（全既読）/ #edit / #search（⚠ 全既読改未读态，未点）
│
├─ message_detail.php（会话页）
│  ├─ URL 模式：message_detail.php?a=a&mailID={base64 mailID}
│  ├─ 页头：#main-contents-message-header（返回 + 客户名 + OFF 状态）
│  ├─ 消息容器：#list_message_detail.ds_message_txt
│  │  ├─ 我发的消息块：.message__block--send（右对齐 child--right）
│  │  ├─ 对方消息块：.message__block--receive（左对齐 child--left）
│  │  ├─ 正文：.message__block__body__text（--female/--male 变体）
│  │  ├─ 时间：.message__block__body__time
│  │  ├─ 已读回执：.message__block__body__time__opened（既読+时间戳）
│  │  └─ 加载更多：「以前のメッセージを見る」链接
│  ├─ 业务 API：POST api/get_profile_fixed_phrase.php（toProfileId={memberID}）
│  │  └─ 响应 = 客户完整画像 JSON（40+ 字段，见 §4.3）
│  ├─ 发送 form：#send_message（41 字段，见 §3.2；⚠ 只测绘不真发）
│  └─ 图片发送 form：#upload_picture（input#upload_file[type=file] + button#submit_button）
│
├─ profile_detail.php?tid={memberID}（客户画像全字段）
│  ├─ 服务端渲染（.php 内联，无额外业务 API，DOM 直读）
│  ├─ 选择器 .ds_profile_select_list_item（li = .ds_profile_select_title + .ds_profile_select_choice）
│  ├─ 坐实字段：性別/年齢/居住地/詳細エリア/アクセス状況/身長/スタイル/ルックス
│  │  + 兴趣（.ds_circle_text_list_item）/ 目的 / 最近登录（.ds_profile_picture）
│  └─ 头像判定：bg 含 pict.happymail.co.jp = 真实头像；含 noimage_male/female.png = 默认头像
│
├─ mypage.php（我的页）
│  ├─ 画像入口：my_profile_picture_and_movie.php
│  ├─ 点数/里程：point.php / mileage_top.php（⚠ 付费红线）
│  ├─ 列表：ashiato.php(足あと) / my_list.php(マイリスト) / deny_list.php(無視)
│  └─ 其他：oshaberi.php(通話募集) / couple_report_renewal_top.php / passkey_setting.php
│
├─ ashiato.php（足迹）
│  ├─ POST api/list_profile_ashi.php（direction=0，all_count=100，pages=20，today_count=1）
│  └─ 访客卡片（同 .profile_list_big_item 结构）
│
├─ profile.php（人设 = 账号本体）
│  ├─ form#profile_submit（90 字段，见 §3.4）
│  ├─ 完整度：#fun_graph + #reward（勋章）+ profileAdequacyPresent.php
│  └─ 业务 API：POST api/get_notification_banner_info.php（未读/通知汇总）
│
└─ menu.php（设定）/ help.php / important_from_support.php / latest_information_event.php
```

---

## 2. 7 业务 API（坐实请求体 + 响应 schema）

| 功能页 | 业务 API | 请求体（POST form-data） | 响应 schema（坐实） |
|---|---|---|---|
| mbmenu.php（首页） | **POST /sp/app/api/html/list_billboard.php** | token, offset=1, count=1, billboard_genre=A04, searchType=0, content_name=home_billboard_gallery, memuse=false, HTTP_X_HAPPY_USER_AGENT | { error_no, error_msg, offset, billboard_search_result[], page, pages, reloadFlg } |
| profile_list.php（检索） | **POST /sp/app/api/html/list_profile_gallery.php** | token, offset=1, count=20, query_no, search_type=3, content_name, pickup_free=0, memuse=false | { error_no, all_count, page, pages, per_page, profile_list[], all_act_count, today_act_count, query_set, reloadFlg, ordSel, memuse } |
| keijiban.php（募集） | **POST /sp/app/api/html/list_billboard.php** | token, offset=1, count=10, billboard_genre=A04, sel_area_type=0, searchType=0, memuse=false | { error_no, offset, billboard_search_result[], page, pages, reloadFlg } |
| type_list.php（点赞） | **POST /sp/app/api/html/typelist.php** | token, offset=1, count=10, tab_select=2, memuse=false | { error_no, tab_select, type_sita[], type_sareta[], type_ryoomoi[], page, pages } |
| message_list.php（收件箱） | **POST /sp/app/api/html/list_message.php** | token, offset=1, count=5, member_seq_id, prOp=1, fid, memuse=false | { error_no, all_count, page, pages, per_page, message_list[], error_msg } |
| profile.php（人设） | **POST /sp/app/api/html/get_notification_banner_info.php** | token, page=profile.php | { message_count, message_notification_count, type_count, type_notification_count, nenrei_ng, billboard_promotion } |
| message_detail.php（会话） | **POST /sp/app/api/html/get_profile_fixed_phrase.php** | token, toProfileId={memberID} | 客户完整画像 JSON（40+ 字段，见 §4.3） |

**响应字段示例（坐实）**：
- list_message.message_list[]：message_id, from/to_member_seq_id, pin("71182882,40447426,1"), pinning, message_tab, opened_on, replied_on, category, message_body, attached_stamp, member_nickname, member_seq_id, member_sex, member_age, member_thumbnail, created_on, member_residence, mailID(b64), seq_id, my_seq_id, to_seq_id, msg_id, token, translated_message_body, 等 40+ 字段
- list_profile_gallery.profile_list[]：member_seq_id, member_age, member_residence, member_beginner, member_sex_number, member_thumbnail, member_thumbnail_high, member_appeal_point, member_d, type_sita_flag, login_icon_color, offset, is_banner
- list_billboard.billboard_search_result[]：billboard_id, billboard_genre_name, billboard_genre_code, billboard_subject, billboard_write_date, billboard_read_count, billboard_my_read, billboard_chance, billboard_photo/tel_use/tel_time/sound, member_seq_id, member_sex_number, member_sex, member_name, member_age, member_residence, member_thumbnail, billboard_cnt, diary_cnt, toukou_pictures/movies, member_memo, scene_name_list, scene_bold_list
- typelist.type_sareta[]：member_age, member_residence, member_thumbnail, my_member_seq_id, to_member_seq_id, profile_type_id, tab_select, opened_on, ent_date, type_on, member_nickname, member_sex_number, member_memo, member_memocategory, member_job, member_height, member_annual_income, member_style, keisai_msg/pict/tnso/voice_count, diary_cnt, toukou_*, member_album_*_count, show_greybox, login_icon_color
- list_profile_ashi.profile_list[]：member_seq_id, target("aite"), member_age, action_seq_id, member_sex_number, member_nickname, member_residence, member_job, member_annual_income, member_height, member_style, member_memo, opened_on, action_created_on, action_updated_on, member_thumbnail, favorite_profile, member_profile_*_count, keisai_*_count, diary_cnt, toukou_*, member_album_*_count, show_greybox, login_icon_color
- get_profile_fixed_phrase：member_seq_id, member_sex("♂"/"♀"), member_nickname, member_memo, member_beginner, profile_picture_url, no_image_url, picture_id, member_comment, member_appeal, member_interest[], member_interest_list{interest,purpose,most_purpose,common}, member_personality[], member_age, member_residence_pref, member_residence_city, member_birth_area, member_blood, member_seiza, member_last_loged_in, member_height, member_style, member_type, member_bustsize, member_job, member_money, member_child, member_tabaco, member_sake, member_car, member_carrier, member_housemate, member_brother, member_hope_before_meet, member_first_date_cost, hope_age_1/2, hope_height_1/2, hope_style_1/2, hope_marriage, hope_style, hope_child, hope_tabaco, hope_sake, hope_car, hope_blood, hope_seiza, seiza_url, member_marriage, taikai, member_sex_number, _def{foreign_language}, member_educational_background, member_holiday, member_intention_to_marry, not_specified, pid, login_icon_color, login_message, is_safe_mode, encrypted
- get_notification_banner_info：message_count, message_notification_count, message_addition, type_count, type_notification_count, nenrei_ng, billboard_promotion

**API 通用约束**：
1. 全部需 **CSRF token**（POST body 字段 token = 会话 UID，如 7511801846add9de35f5f94.33165234.s0.1）
2. 全部需 **cookie**（credentials: include，会话态）
3. 全部需 **HTTP_X_HAPPY_USER_AGENT=HappyHills/Web/8.3.0**（UA 伪装）
4. 响应统一 error_no（0=成功，101=缺 token/body，预期内）+ error_msg
5. 数据 API **不内联 .php**（.php 壳 + JS fetch POST → 渲染 DOM），抓取可直接 POST 该 API（带 cookie+token，更高效免 DOM 解析）
6. GET 直连 API 返回 error_no:101（需 POST body + token，预期内）

---

## 3. 全模块核心表单 Selector + 字段结构图

### 3.1 message_list.php（收件箱批量 form）
```
form (no-id) POST → message_list.php
├─ input[type=checkbox][name=selToAll[]]#informationAll（全選択）
├─ input[type=checkbox][name=sel[]] × N（客户勾选，value="{mailID},{memberID}"，JS 填充）
├─ input[type=hidden][name=pin[]] × N（置顶标记，value="{mailID},{memberID},1"）
├─ button[name=delete]（⚠ 批量删除）
├─ button[name=deny]（⚠ 批量无视）
├─ button[name=noWatch]（⚠ 批量屏蔽）
├─ button[name=read]#kidoku（⚠ 全既読）
├─ button[name=pinning]#pinning（隐藏，置顶）
├─ input[type=hidden][name=action]
└─ input[type=hidden][name=pin_flg]
```

### 3.2 message_detail.php（发送 form，41 字段坐实）
```
form#send_message POST → message_detail.php?mailUID=&mailID={b64}
│
│ 可见字段（3）：
│ ├─ textarea#text-message[name=messageBody]（maxl=800，正文输入）
│ ├─ select#manner[name=manner]（マナー返信/お断り/お礼/スタンプ 预设回复）
│ └─ button.icon-message_send（发送按钮，⚠ 红线：只测绘不真发）
│
│ 隐藏字段（38，风控 token 系列，发送必带）：
│ ├─ 身份/反欺诈：ukey("51620882_6add9efad1297") / UID(会话ID) / memberSex=2(我=女性)
│ ├─ 年龄认证：ageCertified(1) / oppositeAgeCertified(1)
│ ├─ Twilio 通話风控：userTwilioBlocked / oppositeTwilioBlocked /
│ │   twilioBlockedMsgList(JSON) / registeredCtTel / ctTelRegisteredFlg(1) /
│ │   twilioPointMinimum(-30) / twilioAppType(0)
│ ├─ 首条消息标记：fstMsgTempFlg(1) / firstMsgSaveFlg(0) / firstMsgReplyFlg(1) /
│ │   firstMsgBoardFlg / firstMsgSaveNo / fromMessageListFlg / messageSendToBillboardFlg
│ ├─ 贴纸/礼貌回复：stampUrl / stampType / mannerFlag / mannerReply / mannerReplyType
│ ├─ 路由：billboardId / janlName / mailUID / index / isMyToukouRouteFlag /
│ │   isRevokePopupView(0) / stashMsgText / placeholderToName
│ ├─ 通話号码：talkTelNo(0924064317) / talkTelNo2(0120975555) /
│ │   talkTelNoStr / talkTelNo2Str / receptionTimeDefault(6) / talkReceptionTimeCancel(0)
│ └─ 完整字段名清单 → json/12-message-detail-2.forms-full.json
```

### 3.3 upload_picture（图片发送 form）
```
form#upload_picture POST → message_detail.php?a=a&mailID={b64}
├─ input#upload_file[name=upload_file][type=file]（hide_uploader）
├─ button.ds_round_btn_solid（切换内容）
└─ button#submit_button.ds_round_btn_shadow_blue（提交）
```

### 3.4 profile.php（人设 form，90 字段坐实）
```
form#profile_submit POST → profile.php
├─ 多选 select（3）：
│  ├─ select[name=interest[]]#multiple_select_interest[]（兴趣，当前已选：スイーツ/お菓子）
│  ├─ select[name=purpose[]]#multiple_select_purpose[]（目的，当前已选：遊び相手）
│  └─ select[name=personality[]]#multiple_select_personality[]（性格）
├─ 单选 select（26）：age / area / city / member_birth_area / blood_type /
│  constellation / height / style / type / bust_size / job /
│  educational_background / holiday / marriage / child /
│  intention_to_marry / tobacco / liquor / car / housemate / brother /
│  hope_before_meet / first_date_cost / hope_age_low / hope_age_high /
│  hope_height_low / hope_height_high / hope_child / hope_car
├─ 多选 select（6）：hope_style[] / hope_relationship[] / hope_tobacco[] /
│  hope_liquor[] / hope_blood[] / hope_constellation[]
├─ textarea#self_introduction[name=comment]（自我介绍，当前空）
├─ radio（43）：input[type=radio][name=appeal-*]（アピールポイント）
├─ hidden（6）：post_area / post_city / resize_done_trigger /
│  from_mypage_flag / auto_save_popup_flag / +1
└─ button.ds_round_btn_shadow_blue（保存）
```

### 3.5 type_list.php（点赞批量 form）
```
form (no-id) POST → type_list.php
├─ input[type=checkbox][name=selToAll[]]#informationAll
├─ input[type=checkbox][name=sel[]] × N（JS 动态填充）
├─ button[name=delete]（⚠ 删除） / button[name=deny]（⚠ 无视） / button[name=noWatch]（⚠ 屏蔽）
└─ input[type=hidden][name=action]
```

---

## 4. 客户卡字段映射（→ IDENTITY_FIELDS，坐实）

### 4.1 收件箱客户卡（.ds_message_list_mini）
| IDENTITY_FIELD | 选择器 / 来源 | 坐实 |
|---|---|---|
| nickname | .ds_message_name__item | ✓（例：はるき） |
| age（ageNum） | .ds_message_pref 第一段（"20代前半"） | ✓（文本解析） |
| region（市） | .ds_message_pref 第二段（"札幌市"） | ✓ |
| lastMsg | .message_body | ✓（例：会いたいです！） |
| lastMsgTime | .ds_message_date | ✓（"昨日"/"10/23 17:24"） |
| memberID（tid） | input[name=sel[]] value 逗号第二段（40447426） | ✓ |
| mailID（会话 b64） | a.dtl-btn href 的 mailID 参数 | ✓ |
| avatar | .ds_thum_contain bg（pict.happymail.co.jp = 真实，noimage_ = 默认） | ✓ |

### 4.2 客户详情页（profile_detail.php?tid=）
DOM 直读（.ds_profile_select_list_item）坐实 8 行：
性別(男性) / 年齢(20代前半) / 居住地(北海道(道央)) / 詳細エリア(札幌市) /
アクセス状況(Web) / 身長(170～174) / スタイル(がっちり) / ルックス(さわやか系)
+ 兴趣（.ds_circle_text_list_item：スポーツ）/ 目的（遊び相手, 恋人）/ 最近登录（.ds_profile_picture：ログイン 10/24 16:38）
注：详情页 = 客户完整画像落地页，.php 服务端渲染，无额外业务 API，DOM 直读即可；「ナイショ」= 未公开。

### 4.3 get_profile_fixed_phrase.php API（客户完整画像，40+ 字段）
| 字段组 | 字段 | 坐实值示例（はるき tid=40447426） |
|---|---|---|
| 基础 | member_seq_id / member_sex / member_nickname / member_age / member_residence_pref / member_residence_city | 40447426 / ♂ / はるき / 20代前半 / 北海道(道央) / 札幌市 |
| 身体 | member_height / member_style / member_type / member_bustsize | 170～174 / がっちり / さわやか系 / "" |
| 职业/收入 | member_job / member_money | 指定しない / 指定しない |
| 生活 | member_child / member_tabaco / member_sake / member_car / member_housemate / member_brother | 指定しない ×6 |
| 婚恋 | member_marriage / member_intention_to_marry / member_hope_before_meet / member_first_date_cost | 指定しない ×4 |
| 期望 | hope_age_1/2 / hope_height_1/2 / hope_style_1/2 / hope_marriage / hope_child / hope_tabaco / hope_sake / hope_car / hope_blood / hope_seiza | 指定しない ×15 |
| 兴趣 | member_interest[] / member_interest_list{interest,purpose,most_purpose,common} | ["遊び相手"] |
| 头像 | profile_picture_url / no_image_url / picture_id | https://pict.happymail.co.jp/9f88c944/... |
| 其他 | member_last_loged_in / login_icon_color / is_safe_mode / encrypted | 10/24 16:38 / "" / false / (加密串) |

**字段值「指定しない」= 未公开 → 抓取时映射 null（防幻觉，铁律 §6.4 数字只取结构化数据）**

---

## 5. 风控红线入口（全标注，本轮未点）

| 入口 | 位置 | 风险 | 本轮 |
|---|---|---|---|
| 削除（批量删点赞） | type_list.php button[name=delete] | 误删客户 | ⚠ 未点 |
| 無視（批量无视） | type_list.php button[name=deny] | 拉黑客户 | ⚠ 未点 |
| 見ちゃいや（批量屏蔽） | type_list.php button[name=noWatch] | 屏蔽客户 | ⚠ 未点 |
| 全既読 | message_list.php #kidoku | 改未读态（慎） | ⚠ 未点 |
| 点数購入 / 里程交換 | mypage point.php / mileage_top.php | 付费动作 | ⚠ 未点 |
| 发送（会话页） | message_detail.php form#send_message → button.icon-message_send | **绝不真发（§0.1 铁律）** | ⚠ 只测绘 |
| 图片发送 | message_detail.php form#upload_picture → button#submit_button | 强副作用 | ⚠ 未点 |
| 写募集 | keijiban_write.php?k=0/1 | 发帖（风控） | ⚠ 未点 |
| 换 IP / 登出 / 改 proxy | 窗口层（BitBrowser/代理） | 掉登录/风控（§-1.2） | ⚠ 不动 |

---

## 6. 与会出架构差异总结

1. **渲染**：出会 = 零导航（页面内 fetch + DOMParser）；快乐 = .php 服务端渲染 + JS 填充（location.href 逐页跳，或直抓业务 API）
2. **客源多路**：出会单路收件箱；快乐 3 路（点赞+检索+募集）→ 客户 = 并集去重（dedup.js 三级嵌套 contactId 维度）
3. **人设 = 页面数据**：出会人设本地 AccountPersona 表；快乐人设 = profile.php form（90 字段）→ 抓 profile.php 填 AccountPersona
4. **数据动态填充**：.php 只给壳，客户/消息条目 JS 填充 → 直接抓业务 API（更高效）或等 JS 渲染完
5. **CSRF token**：全部 API 需 token（=会话 UID）+ cookie + UA 伪装（HappyHills/Web/8.3.0）
6. **Service Worker 缓存**：qg-sw 缓存 .php 响应 → 数据 API 可能走 SW 缓存，抓取要标记账（防缓存串数据）
7. **CDP 调试口动态**：每 /browser/open 现取（本轮 64690），不写死端口
8. **发送成功判定**：POST message_detail.php?mailUID=&mailID= + 新 .message__block--send 出现（推断，需真发实测，§0.1 未授权）

---

## 7. 写项目前置（需用户授权，未动）

- Platform 表加 1 行：Platform('kairaku','kairaku','快乐','happymail.co.jp','active')（schema 三级嵌套已预留，只缺种子）
- 快乐 7 Expr 文件草案（对出会 ichigo*Expr.js，换 happymail 选择器 + 7 业务 API POST + CSRF token）
- 抓取器 = POST api/list_*.php（带 cookie + token + UA）+ .php 壳 DOM 解析（客户卡/消息块）
- 客户多路 UNION 去重（dedup.js 三级嵌套 contactId）
- 人设 = 抓 profile.php form（90 字段）填 AccountPersona
- 平台切换 UI（ichigo-console.html platformId 维度，归 Phase 4）
- **以上 = Phase 4 性质，用户单步打磨模式未授权，先挂账 task-16 池，不擅动**

---

## 8. 探查状态：**收口（v5 全坐实）**

- ✅ 完整功能树（12 .php 页面全坐实：mbmenu / profile_list / keijiban / type_list /
  message_list / message_detail×2 / profile_detail / ashiato / mypage / profile / menu）
- ✅ 7 业务 API + 请求体 + 响应 schema 全坐实（list_message / list_profile_gallery /
  list_billboard / typelist / list_profile_ashi / get_profile_fixed_phrase /
  get_notification_banner_info）
- ✅ 客户卡 DOM 全字段映射（名/年/市/最后消息/时间/memberID/mailID/头像）
- ✅ 客户详情页 IDENTITY_FIELDS 全字段（8 行基础 + 兴趣/目的/最近登录）
- ✅ 会话页 + 发送 form 41 字段（含全部风控 token）
- ✅ 人设 form 90 字段（3 多选 + 26 单选 + 6 多选 + textarea + 43 radio + 6 hidden）
- ✅ 头像判定规则（pict.happymail.co.jp = 真实，noimage_ = 默认）
- ✅ 风控红线入口全标注未点
- ✅ 存档：12 raw HTML + 18 JSON + 12 截图（docs/survey-happymail-20261025/）

### 唯一遗留
- [ ] 发送成功判定实测（需真发 1 条测试客户，§0.1 需用户授权）
- [ ] 未读 #msg_notification_cnt 增量机制（本轮 unread=0，需有未读时验证）
- [ ] SW 缓存对 list_message.php API 影响（防串数据）

### 存档目录
```
docs/survey-happymail-20261025/
├─ meta.json（窗口/调试口/纪律）
├─ html/（12 页 raw HTML）
├─ json/（18 份 API 响应 + 表单结构 + DOM 抽取）
├─ shots/（12 张截图）
└─ report/全域DOM结构拓扑图.md（本文件）
```


---

## 9. v5.1 补丁 · 全量坐实（2026-10-25 第 2 轮增量）

### 9.1 全量消息 API（坐实，比 DOM 可靠）
POST /sp/app/api/html/message_detail.php
Body: token={UID}&offset={1..N}&count={10|50}&member_seq_id={对方tid}&my_profile_id={我的pid}&memuse=true&HTTP_X_HAPPY_USER_AGENT=HappyHills/Web/8.3.0

响应 schema（坐实）：
  error_no / error_msg / all_count(会话总消息数) / page / pages / per_page /
  member_nickname / member_seq_id /
  message_list[]（同 list_message.message_list[] 字段：seq_id, from/to_member_seq_id, snd_del, message_subject, member_nickname, translate_show_flg, translated_message_body, message_body, attached_stamp, ...）/
  twilio_use_flag / twilio_type / twilio_message_type / call_type（通話字段）

  「以前のメッセージを見る」触发器坐实：
  - 元素：label.message__load__label#btn-load（父 div.message__load.hidden）
  - 属性：data-count=10, data-next=2, data-pages=1, data-page=1, data-mid={我的pid}, data-tid={对方tid}, data-skey={会话key}（skey=f7ab2d52a0cd442bb4fa9039da033ec0）
  - 点击 → POST 上述 API（offset=data-next 翻页）→ 追加消息块到 #list_message_detail

  全量拉取：直接 POST offset=1&count=50 一次拿全（all_count≤50 时 pages=1），比逐页点 DOM 可靠。

### 9.2 收件箱全量 API（count=100 一次拉全）
POST /sp/app/api/html/list_message.php
Body: token={UID}&offset=1&count=100&member_seq_id=&prOp=1&fid=&memuse=false&HTTP_X_HAPPY_USER_AGENT=HappyHills/Web/8.3.0
响应：{ error_no, all_count, page, pages, per_page, message_list[]（40+ 字段/条）}

  token 来源坐实：会话 UID 7511801846add9de35f5f94.33165234.s0.1 可跨页复用（收件箱页无 window.uid 全局，但已知 UID 直连 API 成功 200）。

### 9.3 客户详情页 IDENTITY_FIELDS（第 2 客户 tid=51053024 全量坐实，22 行）
  性別 / 年齢 / 居住地 / 出身地 / 血液型 / アクセス状況 /
  身長 / スタイル / 年収 / タバコ / お酒 / クルマ /
  出会うまでの希望 / 初回デート費用 /
  期望组：年齢(20代前半〜30代後半) / 身長 / スタイル(ふつう,やや細め,細め,ナイスバディー) / タバコ / お酒 / クルマ / 血液型 / 星座
  兴趣（.ds_circle_text_list_item）：ドライブ,グルメ,お酒,ショッピング,スポーツ,カラオカ,遊び相手,恋人,大人の交際,優しい,決断力がある,穏やか,落ち着いている,謙虚

  比 §4.2 首客户（tid=40447426，8 行）多 14 项（首客户多为「ナイショ」未公开，第 2 客户公开度高）。
  抓取映射规则：DOM .ds_profile_select_list_item 直读，「ナイショ」/「指定しない」→ null。

### 9.4 更新后探查状态
  - [已坐实] 全量消息 API（POST message_detail.php，比 DOM 可靠）
  - [已坐实] 收件箱全量 API（count=100 一次拉全）
  - [已坐实] 客户详情页全量字段（2 客户对比：首客户 8 行，第 2 客户 22 行）
  - [已坐实] token 跨页复用机制（会话 UID 直连 API 成功）
  - [已坐实] skey（会话 key）= label#btn-load data-skey 属性（f7ab2d52...）
  - 唯一遗留（需用户授权或特定条件）：
    - [ ] 发送成功判定实测（需真发 1 条测试客户，§0.1 需用户授权）
    - [ ] 未读 #msg_notification_cnt 增量机制（本轮 unread=0，需有未读时验证）
    - [ ] SW 缓存对 list_message.php API 影响（防串数据）

### 9.5 更新存档目录
  docs/survey-happymail-20261025/
  ├── meta.json（窗口/调试口/纪律）
  ├── html/（14 页 raw HTML，新增 13-message-detail / 14-profile-detail-all）
  ├── json/（26 份：API 响应 + 表单结构 + DOM 抽取 + 全量坐实）
  ├── shots/（14 张截图，新增 13-message-detail-all / 14-profile-detail-all）
  └── report/全域DOM结构拓扑图.md（本文件）
---

## 10. v5.2 补丁 · 全量实测 + 引流全流程坐实（2026-10-27）

> 本轮从「只读测绘」推进到「引流全流程实测」：人设→客户→资料卡→聊天→足迹→帖子正文→生成话术→真发→撤回，全链路 API 坐实。铁律守住：发送/撤回均经用户逐次确认。

### 10.1 业务 API 扩到 13 个（本轮新增 4 个）

| # | API | 端点 | 作用 | 本轮坐实 |
|---|---|---|---|---|
| 1 | 收件箱全量 | POST /sp/app/api/html/list_message.php | 全客户列表（count=100 一次拉全） | ✓ |
| 2 | 会话全量 | POST /sp/app/api/html/message_detail.php | 单客户全量消息（offset+count 翻页） | ✓ |
| 3 | 检索客源 | POST /sp/app/api/html/list_profile_gallery.php | 检索 1002 条 | ✓ |
| 4 | 募集 BBS | POST /sp/app/api/html/list_billboard.php | 全量招募池 300 条 | ✓ |
| 5 | 点赞三路 | POST /sp/app/api/html/typelist.php | type_sita/sareta/ryoomoi | ✓ |
| 6 | 足迹 | POST /sp/app/api/html/list_profile_ashi.php | 别人浏览过我 | ✓ |
| 7 | 客户画像 | POST /sp/app/api/html/get_profile_fixed_phrase.php | 40+ 字段 JSON 直出 | ✓ |
| 8 | 通知汇总 | POST /sp/app/api/html/get_notification_banner_info.php | 未读/通知 | ✓ |
| 9 | **客户帖子列表** | **POST /sp/app/api/html/get_profile_billboard.php** | 某客户的招募帖（direction=1&member_seq_id） | ✓ 新增 |
| 10 | **单帖详情** | **POST /sp/app/api/html/get_billboard.php** | 帖子正文 billboard_body + 标签 scene_name_list + 电话 | ✓ 新增 |
| 11 | **真发** | **POST /sp/app/api/html/send_message.php** | 发消息（body 带 ukey/UID/风控字段） | ✓ 新增 |
| 12 | **撤回状态** | **POST /sp/app/api/html/getTextMessageRevokeStatus.php** | 查某条消息能否撤回 | ✓ 新增 |
| 13 | **撤回** | **POST /sp/app/api/html/revokeTextMessage.php** | 执行撤回（messageId） | ✓ 新增 |

**token 分域坐实**：读数据 API（1-8）用会话 UID（7511801846…）；发帖域（9/10）和发送/撤回域（11-13）用独立 token（47429141…，从页面动态获取）。写项目时按域分组取 token。

### 10.2 发送链路（坐实）

```
进会话页 message_detail.php?a=a&mailID={b64}
└─ form#send_message（41 字段，含 ukey/UID/memberSex/ageCertified/twilio* 风控隐藏字段）
   ├─ textarea#text-message[name=messageBody]（maxl=800，支持 \n 换行→渲染 <br>）
   ├─ 点 button.icon-message_send（.svg-block）
   └─ 确认层 popupContent「この内容で送信します。宜しいですか？」→ 点 button「送信する」
→ POST /sp/app/api/html/send_message.php（status=200）+ 新 .message__block--send 出现 + textarea 清空 + 尾部「未読 HH:MM」标记
```

**成功判定（4 信号，非推断）**：① send_message.php=200 ② 新 send 块出现 ③ textarea 清空 ④ 未読标记。messageId 从新块 input[name=messageId] 取。

**换行格式规则**：话术生成时按短句换行（\n 分隔），发送时 textarea 保留 \n，平台自动转 <br> 多行渲染。生成器默认输出换行版。

### 10.3 撤回链路（坐实）

```
消息块内 button.revokeTextMessage（删除图标，仅自己发的、对方未读、时间够近时显示）
└─ 点 → remodal 确认层「送信取消について」（.modal-confirm「送信取消」/ .modal-cancel「キャンセル」）
   文案：・取り消したことはお相手にも表示されます（撤回对对方可见）
        ・状況によってはお相手が内容を確認できる場合がございます（对方可能已看到部分）
→ 点「送信取消」→ POST getTextMessageRevokeStatus.php（查状态）+ POST revokeTextMessage.php（执行，messageId）
→ 该消息从会话列表消失（API all_count 减 1），DOM 变「削除済み」占位
```

**撤回条件**：发送时间够近 + 对方未读 + 自己发的。撤回对对方可见，且对方可能已看到部分内容（平台明示）。

### 10.4 引流全流程（本轮实测坐实）

```
0 人设      → profile.php form#profile_submit（90 字段）+ get_notification_banner_info（未读）
1 找客户    → list_message.php（全客户）/ list_profile_gallery / typelist / list_profile_ashi（足迹=主动看我的人）= 客源 4 路 UNION
2 资料卡    → get_profile_fixed_phrase.php（40+ 字段 JSON）
3 聊天记录  → message_detail.php（全量消息，含 translated_message_body / twilio 通話字段）
4 客户帖子  → get_profile_billboard（列表）+ get_billboard（正文+标签）【新增客源情报维度】
5 生成话术  → 三要素（人设+画像+上下文）组装 → 多维度选项（推进/暂不/认真/观望）+ 思考过程 + 原文+译文 + 消息判断
6 确认发送  → 用户逐次确认 → send_message.php（换行格式）
7 撤回兜底  → 不满意/发错 → revokeTextMessage.php（对方未读时）
```

**客源 4 路**（本轮按用户要求把「足迹」并入）：点赞 typelist + 检索 profile_gallery + 募集 billboard + **足迹 ashiato（主动浏览过我的人）**，UNION 去重 = 客户池。足迹路数据 = list_profile_ashi.php（all_count=100，today_count）。

### 10.5 话术生成规则（沉淀，供 C 阶段/自动化复用）

1. **输入三要素**：账号人设（profile.php）+ 客户画像（get_profile_fixed_phrase）+ 消息上下文（message_detail 全量）+ 客户帖子（get_billboard）+ 足迹（list_profile_ashi）。
2. **思考过程 5 维度**：时间因素（当前时段 vs 对方活跃时段）/ 撤回因素（若刚撤回过，轻描淡写带过不主动提）/ 人设因素（姐姐感、温柔不老气）/ 意向因素（对方帖子+兴趣权重→推进见面 or 认真交往）/ 竞争因素（对方帖子回复数=其他女性竞争者）。
3. **多维度选项**（不挤单一维度）：①推进·明天见 ②推进·周末 ③先交往后见面（认真向）④轻快唤回+LINE。每档给原文+译文+理由。
4. **格式**：每句一行（\n 分隔），发送保留换行。
5. **铁律**：AI 只生成草稿，真发走「建议→用户确认→执行」，未确认绝不发（§0.1）；撤回仅对方未读时可用，且对对方可见。

### 10.6 防误发/防误撤校验（自动化必带）

- **发送前**：会话页 header 必须含目标客户名 + 存在 #send_message textarea，否则中止；拉全量聊天确认目标消息未发过（防重复）。
- **撤回前**：目标 messageId 块必须存在 + 有 .revokeTextMessage 按钮（无按钮=已超撤回时限/对方已读/非本人消息）。
- **token 分域**：读数据 API 与发送/撤回 API 用不同 token，写项目按域分组动态获取。

### 10.7 本轮存档

```
docs/survey-happymail-20261025/flow-haruki/
├─ 0-persona.json            当前账户人设
├─ 1-inbox-all.json        收件箱全量
├─ 2-haruki-profile.json   客户资料卡 40+ 字段
├─ 3-haruki-chat-all.json  全量聊天记录
├─ 4-ashiato.json          足迹
├─ 6-haruki-billboards*.json 客户帖子列表/全量
├─ 8-haruki-recuits*.json   帖子详情
├─ 11-his-recruit-bodies.json 4 帖正文+标签
├─ 5-reply-v2-multi.json   多维度话术（思考过程+4 选项）
├─ 16-sent-record.json     第③条发送记录
├─ 17-revoke-record.json   撤回记录
└─ 18-sent-v2-record.json  第③条换行版发送记录
```

### 10.8 探查状态：v5.2 全链路收口

- ✅ 13 业务 API 全坐实（含读/发/撤三类）
- ✅ 发送链路 + 撤回链路 + 换行格式全坐实
- ✅ 引流全流程（人设→客源 4 路→画像→聊天→帖子→话术→发送→撤回）实测闭环
- ✅ 话术生成规则 + 防误发/防误撤校验沉淀
- 遗留（需授权/特定条件）：未读 #msg_notification_cnt 增量（需有未读时验证）/ SW 缓存对 API 影响 / 是るき侧他人私信正文（隐私边界，需本人账号）
