# 出会平台（sp.194964.com / イククル）· 全域 DOM 结构拓扑图
> 总控 2026-10-25 CDP 只读全量探测（窗口 2315e879，CDP 54346 API）。
> 全部只读：零导航副作用（导航仅切窗口自身标签页，未点保存/提交/发消息）、零写状态。
> 证据：本目录 60+ 份 raw HTML + JSON + 截图（profile_*/search_*/calendar_*/ashiato_*/diary_*/ranking_*/type_*/mylist_*/oshaberi_*/pappy_*/mypage_*）。

## 〇、总览：模块地图（7 大域 · 40+ 页面 · 30+ AJAX/表单端点）

| 域 | 入口 | 页面数 | 机制 |
|---|---|---|---|
| MyPage 核心枢纽 | /mypage.html | 7 | 子模块：intro/basic/leisure/companionship/image_register |
| 资料编辑（snssetting/config） | 各编辑页 | 5 | 表单 POST / AJAX（data-action）混用 |
| 头像/相册管理 | /sns/snssetting/show_image_register.html | 2 | multipart 表单 POST + 删图确认页 |
| 流量雷达（足迹/被看） | /sns/snsashiato/show.html | 2 | 静态列表 + 批量删 AJAX（data-action） |
| 主动出击（搜索/匹配） | /sns/snssearch/show_faces.html + /profile/profilesearch | 4 | data-* 卡片 + POST ajax_profile_list.html + 高级搜索表单 |
| 线下转化（日历/会える日） | /calendar/show_mylist.html | 2 | FullCalendar 日历 + POST show_mine/regist + 删 POST ajax_delete_pref |
| 其他业务模块 | タイプ/日記/ランキング/電話 | 8 | 静态列表 + 删类型 AJAX |
| Pappy（共通点/找 Pappy） | /pappy/exec_pappy_redirect.html | 1 | 外链跳 www.pappy.jp（跨域） |

---

## 一、MyPage 核心枢纽

### 1.1 /mypage.html（账号摘要枢纽页）
**页面特征**：无表单（纯展示 + 导航 hub）。26 个链接。核心入口：

| 入口 | href | 功能 |
|---|---|---|
| プロフィールの確認・変更 | /sns/snsmypage/show_profile.html | 资料总览（§1.2） |
| 追加（G 充值） | /point/purchase/show_top.html | 点数 |
| 交換（G→F 点） | /point/ptfemale/show_main_menu.html | 点数兑换 |
| あしあと | /sns/snsashiato/show.html | 足迹（§4.1） |
| 設定している日を確認 | /calendar/show_mylist.html | 日历（§5.1） |
| お相手探し | /sns/snssearch/show_faces.html | 找对象（§3.1） |
| タイプ | /sns/snstype/show_typed_list.html | 类型（§6.4） |
| Pappy | /pappy/exec_pappy_redirect.html | Pappy（§7） |
| 各種設定 | /config/settingprof/show_setting_top.html | 设置聚合页 |

**DOM 选择器**：底部导航 .bottom-nav-item（5 tab：お相手探し/募集/メッセージ/タイプ/マイページ）；
未读徽标 .caution（例：タイプ 99）；顶部点数 .header_gold_value。

### 1.2 /sns/snsmypage/show_profile.html（资料总览，含 6 段「設定する」入口）
**机制**：纯展示页（0 form），所有编辑走外链。页面结构 = 6 个 .block：
| 区块 | 标题 | 编辑入口 | 保存机制 |
|---|---|---|---|
| 头像/相册 | プロフィール設定 | .btn-addchange → /sns/snssetting/show_image_register.html | 见 §1.5 |
| 自己紹介 | 自己紹介 | .block-title a → /sns/snssetting/show_edit_profile_intro.html | 传统 Form POST |
| 基本资料 | 基本プロフィール | a → /config/settingprof/show_profile_setting.html | 传统 Form POST |
| 詳細プロフィール | 詳細プロフィール | a → /sns/snssetting/show_edit_profile.html | 传统 Form POST |
| 大人の交際 | 大人の交際 | a → /config/settingprof/show_companionship.html | AJAX POST（无 form） |
| 兴趣 | 興味あること（趣味・共通点） | a → /sns/snssetting/show_edit_leisure.html | AJAX（data-action） |

**头像轮播**：.myprofile-gallery > .profimage-list（owl-carousel），主图 #profBigImg0（background-image），
切换 changeMainImage(4)；头像缩略 .profimage-list .owl-item img。

### 1.3 自己紹介编辑（/sns/snssetting/show_edit_profile_intro.html）
**保存机制**：传统 Form POST（非 AJAX）。
表单结构：
```html
<form method="post" action="/sns/snssetting/exec_edit_profile_intro.html">
  <input type="hidden" name="identifier">
  <textarea name="introduction">自由コメント/趣味/誰似/髪型/気質/望むタイプ/マイブーム/特技/休日は/車/夢/恋人/タバコ</textarea>
  <select name="introductionPublicFlag">0 全员公开 / 1 仅我的好友 / 2 不公开</select>
  <button type="submit" class="greenButton form-btn">更新する</button>
</form>
```
**关键字段**：textarea.name=introduction（无 maxlength）；select.name=introductionPublicFlag（0/1/2）。

### 1.4 基本资料（/config/settingprof/show_profile_setting.html）
**保存机制**：传统 Form POST → /config/settingprof/exec_profile_setting.html。
**字段全表（含取值范围）**：
| 字段 | 类型 | 取值 |
|---|---|---|
| name | text | 昵称（ともね） |
| birthDate | hidden(date) | 1988-05（selectdate 联动） |
| height | select | 0非公开/1<150/2 150-154/3 155-159/4 160-164/5 165-169/6 170-174/7 175-179/8≥180 |
| style | select | 0非公开/1纤细/2普通/7丰满/8巨乳/9nicebody/10小胸/6圆润/11胖/12微胖/13很胖 |
| blood | select | 0非公开/1 A型/2 B型/3 O型/4 AB型 |
| looks | select | 0非公开/9可爱系/10美人系/11性感系/12大姐姐系/13女高中生系/14水系/15搞笑系/37清冷系/38清爽系/6治愈系/39熟女系/40天然系/41小恶魔系/42中性的/43妹妹系/44萌系/45萝莉系/23街头系/46辣妹系/47大小姐系/25视觉系/26费洛蒙系/29 B系/30休闲系/31摩登系/48色气可爱/49里原系/50神秘系/33朋克摇滚/51小动物/52知性/53大姐姐辣妹/54女性/55名门/19秋叶原系/8其他 |
| city | select | 14 个三重县城市（津市 558…伊賀市 571） |
| married | select | 0秘密/1未婚/4交往中/2已婚/5复杂关系/6分居/3离婚 |
| birthCity/occupation/income/constellation/cigarette/alcohol/freeTime/ageFrom/ageTo/fStyle/child/eyes/cup/bust/waist/hip/car | hidden | 默认 0（联动子表单填） |
| 提交 | button | 更新する（greenButton） |

**子表单（「設定」按钮触发的二级弹窗/子页）**：style_button/looks_button/occupation_button/birthCity_button/freeTime_button/constellation_button/fStyle_button/carrier_button。

### 1.5 头像/相册管理（/sns/snssetting/show_image_register.html）
**机制**：2 个 multipart 表单 + 删图确认页（无 AJAX）。
```
#face  form → POST /sns/snssetting/exec_face_image_register.html
  <input type="file" name="imageFile" id="fileupload" accept="image/*">
  <input type="hidden" name="compressImageData">（canvas 压缩）
  <button type="submit" class="blue-box">画像を登録する</button>

#other form → POST /sns/snssetting/exec_profile_image_register.html
  <input type="file" name="imageFile" id="fileupload2" accept="image/*">
```
**删图交互**：每张已传图右侧 <a class="btnTrash" href="/sns/snssetting/show_delete_image_confirm.html?q=...">（带 base64 token）
→ 删图确认页 → exec 删除。**限 2 张 face + 3 张 other**（「あと N 枚登録できます」文案）。

### 1.6 兴趣（趣味・共通点）编辑（/sns/snssetting/show_edit_leisure.html）
**机制**：AJAX（非表单提交）。
```html
<form data-action="/sns/snssetting/ajax_edit_leisure.html" action="/other/javascript/show_popup.html" method="post">
  <input type="hidden" name="identifier" value="main">
  <input type="hidden" name="mode" value="2">
  <input type="hidden" name="categoryId[]" id="category2" value="2" disabled>
  ...（38 个 categoryId[] hidden，覆盖 0-35）...
  <button type="submit" class="button center popButton">（提交触发 AJAX）</button>
</form>
```
**兴趣图标网格**：table.mainTable > td.imgTd（每个 <td> 含 <input type=hidden disabled name=categoryId[]> +
双 <img>：主图 + checkImg（选中时 toggle display））。点击 td 切换 .checkImg 显隐，提交时 JS 读所有
categoryId[]（hidden disabled 的 value 在 toggle 时动态改）。
**保存结果**：AJAX 回 JSON → 页面弹 /other/javascript/show_popup.html（mfp 弹窗）展示成功/失败。

### 1.7 大人の交際（/config/settingprof/show_companionship.html）
**机制**：纯 AJAX（无 form 包裹），jQuery 直接 POST。
```js
function setCompanionship() {
  $.ajax({ type: "POST", url: '/config/settingprof/exec_companionship.html',
           data: { dateId: $('input[name=dating1]:checked').val(),
                   meetId: $('input[name=dating2]:checked').val() } });
}
```
**字段**：radio dating1（0 未选/1仅餐/2先餐/3随对方/99其他）+ radio dating2（0 未选/1先见/2合见/3消息后见）。
当前账号：dating1=99*，dating2=1*。

---

## 二、（§1.3-1.7 已覆盖资料编辑）

---

## 三、主动出击引擎（搜索与匹配）

### 3.1 お相手探し（/sns/snssearch/show_faces.html）
**机制**：data-* 卡片静态渲染 + 滑动手势触发 AJAX。
**页面结构**：
```html
<div class="tablink has-pappy-link">  <!-- 4 tab -->
  ログイン順（当前 active） / 登録順 / 共通点（→ /profile/leisuresearch/show_select_category.html） / Pappyで探す（→ /pappy/exec_pappy_redirect.html）
</div>
<div id="storedDisplay">
  <div id="data_0" data-thumbnail="..." data-name="..." data-age="57歳" data-pref="三重" data-city="津市" data-certify="1" data-id="12612558" data-type="0"></div>
  <div class="photo-item-new">
    <span class="thumb-overlay" onclick="startShowProfileList(0, 1, 1, 0)">
      <img src="..._200.jpg">
    </span>
    <div class="photo-name">三重 57歳</div>
    <div class="photo-desc">自己紹介节选</div>
  </div>
  ...（48 个 data_N 卡片/页）
</div>
```
**滑动看资料**：点 thumb-overlay → startShowProfileList(idx, addFaceImage, accessFrom, directionType) →
内部调 showProfileList() → **POST /sns/snsprofile/ajax_profile_list.html**：
```js
$.ajax({ url: '/sns/snsprofile/ajax_profile_list.html', type: 'POST',
  data: { targetReMemberIdList: ids.join('\t'),  // tab 分隔的 data-id 列表
          showIndex: 0, addFaceImage: 1, accessFrom: 1, directionType: 0 } })
```
返回 { status:'success', subject:HTML片段 } → 填 #profileSlide（全屏资料滑动层）。
**核心卡片选择器**：#storedDisplay > div[id^=data_]（data-id=会员ID）+ .photo-item-new（展示卡）。

### 3.2 高级搜索（/profile/profilesearch/show_profile_search.html）
**机制**：传统 Form POST → /profile/profilesearch/exec_routing_profile_search.html。
**完整筛选字段表**：
| 字段 | 类型 | 取值 |
|---|---|---|
| ageFrom / ageTo | select | 0指定なし/1 18-19/2 20前半/3 20后半/4 30前半/5 30后半/6 40前半/7 40后半/8 50前半/9 50后半/10 60以上 |
| heightFrom / heightTo | select | 0指定なし/1<150/2 150-154/3 155-159/4 160-164/5 165-169/6 170-174/7 175-179/8≥180 |
| income | select | 0指定なし/1≤100万/2 100-300/3 300-600/4 600-1000/5 1000-2000/6 2000-5000/7 5000-1亿/8≥1亿 |
| child | select | 0指定なし/1有/2无 |
| car | select | 0指定なし/1有/2有(摩托)/3无 |
| alcohol | select | 0指定なし/1喝/2偶尔/3不喝 |
| cigarette | select | 0指定なし/1抽/2偶尔/3不抽 |
| image | select | 0指定なし/1无图/2有图 |
| fAgeFrom / fAgeTo | select | 0指定なし/1 18-19/2 20前半/3 20半ば/4 20后半/5 30前半/6 30半ば/7 30后半/8 40前半/9 40半ば/10 40后半/11 50前半/12 50半ば/13 50后半/14 60以上 |
| dateId | select | 0指定なし/1仅餐/2先餐/3随对方/99其他 |
| meetId | select | 0指定なし/1先见/2合见/3消息后见 |
| married[] | checkbox×6 | 1未婚/4交際中/2既婚/5复杂/6分居/3离婚 |
| eyes[] | checkbox×5 | 1/2/3/4/5（单眼皮/双眼皮/内双猫眼/垂眼） |
| blood[] | checkbox×4 | 1 A/2 B/3 O/4 AB |
| freeWord | text | 自由词搜索 |
| sortOrder | radio | 0登录順/1登録順 |
| 提交 | button#input_search_outer | 検索（绿按钮） |

**子表单触发按钮**（type=submit，name 前缀 *_button）：
selectedArea_button（地域/市区町村变更）、style_button（风格）、looks_button（类型）、occupation_button（职业）、birthCity_button（出身地）、freeTime_button（空闲时间）、constellation_button（星座）、fStyle_button（体型）、carrier_button（手机运营商）。
**重置**：button#condition_reset → POST /profile/profilesearch/exec_reset.html。

### 3.3 共通点（/profile/leisuresearch/show_select_category.html）
**机制**：图标网格选兴趣 → 跳结果页。
```
.picGrid > .picCategory > a → /profile/leisuresearch/show_result_gallery.html?q=<base64 token>
  <img src="//images.194964.com/leisure/category/<id>/<id>_1.png" class="picList">
```
**结果页**（show_result_gallery.html）：与 §3.1 同构（#storedDisplay + data_N + .photo-item-new，48 卡/页），
同样走 POST /sns/snsprofile/ajax_profile_list.html。

### 3.4 新人検索（/sns/snssearch/show_search.html）
**机制**：带 ?q=<token>，无 token 时返回「システムエラー 99-00001」+ 返回按钮。
入口只能从 menu.html 的「新人検索」链接带 token 跳转（token 时效）。
**RPA 要点**：preflight 先导航 menu.html 拿新鲜 token 再跳。

---

## 四、流量雷达（足迹与被看）

### 4.1 足迹·最近（/sns/snsashiato/show.html）
**机制**：静态列表 + 批量删 AJAX（data-action）。
```html
<form data-action="/sns/snsashiato/ajax_delete_confirm.html" action="/other/javascript/show_popup.html" id="footmark" method="post">
  <input type="hidden" name="identifier" value="footmark">
  <div class="type--list list-male">  <!-- 一条足迹 -->
    <input type="checkbox" name="targetFootmarkId[]" value="2627707054">
    <a href="/sns/snsprofile/show_profile.html?q=..." class="type-list-link">
      <div class="type-list-footstep"><img src="icon_footprint.png"> 来源（プロフィール検索・その他/募集/类型等）
        <div class="type-list-date">10/25 14:58</div></div>
      <div class="type-list-img"><div class="type-list-thumb"><img></div></div>
      <div class="type-list-txt">
        <div class="type-list-name">こうき</div>
        <div class="type-list-age"><span class="online-icon">…</span> 25歳/尾鷲市</div>
        <div class="type-list-gallery"></div>
        <div class="type-list-desc"><div class="desc-txt">对方自我介绍节选</div></div>
      </div>
    </a>
  </div>
  ...（20 条/页）
  <input type="submit" name="submit1" value="チェックを削除" class="button width70 popButton">
</form>
<form id="form2" action="/sns/snsashiato/show_delete_all_confirm.html">
  <input type="submit" name="submit2" value="すべて削除する" class="button width70">
</form>
```
**批量删**：勾 checkbox → 点「チェックを削除」→ AJAX POST ajax_delete_confirm.html（弹确认）→ 回 show.html。
**全删**：点「すべて削除する」→ 跳 show_delete_all_confirm.html → 确认。
**数据源**：本账号今日访问 33 人（页内「本日の訪問者数 33人」文案）。
**反撩价值**：.type-list-link → 直达对方 profile（可加类型/发消息），.type-list-footstep 给来源上下文。

### 4.2 我的足迹（/sns/snsashiato/show_mine.html）
**机制**：同 §4.1，checkbox 名 targetFootmarkId[]，批量删走 /sns/snsashiato/ajax_delete_mine_confirm.html，
全删走 /sns/snsashiato/show_delete_mine_all_confirm.html。结构完全镜像。

### 4.3 「被看」数据源
**结论**：本账号未单独暴露「閲覧/被看」独立页。被看数据通过 ① 足迹页「本日の訪問者数」文案 +
② 资料页 .view（帖子浏览量）体现。无专门 AJAX 端点。

---

## 五、线下转化漏斗（日历与会える日）

### 5.1 我的会える日（/calendar/show_mylist.html）
**机制**：FullCalendar（fullcalendar-daygrid）渲染月历 + 点日期 toggle + saveBtn AJAX。
```html
<div class="calendar-meet">
  <div class="location-wrapper">会いたい地域 <a id="select-pref-name">三重</a>
    <input type="hidden" name="adds" id="adds" value="24">  <!-- prefId -->
  </div>
  <div id="calendar" class="fc fc-ltr fc-unthemed">  <!-- FullCalendar 容器 -->
    <div class="fc-day-grid">
      <td class="fc-day-top fc-thu fc-past" data-date="2026-10-01">…</td>
      <td class="fc-day-top fc-future" data-date="2026-10-26">…</td>  <!-- 可选 -->
    </div>
  </div>
  <a id="saveBtn" class="btn-calendar disabled">この内容で設定する</a>  <!-- 点击日期后启用 -->
</div>
```
**开日历**：点 .popup-calendar → AJAX POST /calendar/show_mine.html（空 body）→
回 { status:1, subject:JSON }（JSON 含 {calendar: {prefId: [dateStr,...]} }）→ reflectDisplay 把已选日期
标红（.fc-highlight）。
**选日期**：点 .fc-day-top.fc-future → toggle .fc-highlight + 维护 selectDate/deleteDate 对象
（key = prefId + '-' + dateStr）→ saveBtn 启用。
**保存**：点 #saveBtn → 推断 POST /calendar/regist.html（页面 script 引用，参数 selectDate/deleteDate/adds=prefId）。
**删已排日**：.day-meet-list 内 .btn-release → 弹确认 → AJAX POST .day-meet[data-url]（= /calendar/ajax_delete_pref.html）
body {aeruId, prefId}。
**当前账号**：0 已排（.day-meet-list 数量=0，显示「会える日が設定されていません」）。

### 5.2 对方会える日（/calendar/show_list.html）
menu.html「会える日 → 見る」入口。展示对方已注册可会日（本账号侧未深入，需登录对方视角）。

---

## 六、其他业务模块

### 6.1 类型（/sns/snstype/show_typed_list.html）
**机制**：静态列表 + 批量删 AJAX。
```
form.delete → POST /sns/snstype/delete_type_list.html
  <input type="checkbox" name="targetSnsMemberId[]" value="5103428">（每卡 1 个）
  <button id="deleteButton" class="button width70">チェックを削除する</button>
.type--list.list-male（一条）：
  .type-list-name（昵称）.type-list-age（51歳/四日市市）
  a → /profile/typesearch/ajax_set_type_read.html?q=<token>（标「已看」端点）
```
**当前账号**：10 条类型，全 list-male。

### 6.2 日記·写（/sns/snsdiary/show_mydiary_form.html）
**机制**：传统 Form POST。
```
form → POST /sns/snsdiary/show_write_confirm.html
  <input type="text" name="title" class="inputTxtRd">
  <textarea name="body" class="inputTextAreaRd"></textarea>
  <input type="checkbox" name="adultFlag">（含露骨内容）
  <select name="publicFlag">1 全员 / 2 会员 / 3 好友 / 4 非公开 / 6 下書き</select>
  <select name="commentReceptFlag">0 不收 / 1 收</select>
  <input type="submit" value="書き込む" id="submit1">
```

### 6.3 日記·看（/sns/snsdiary/show_search.html）
**机制**：静态 20 条 + 搜索表单。
```
form.form1 → POST /sns/snsdiary/show_search_result.html
  <input type="text" name="targetSearchText">（全文检索）
.list-item.list-female / .list-item.list-male（日记卡）
```
日记明细页 /sns/snsdiary/show_diary_detail.html（raw_diary_detail.html 已存档）。

### 6.4 ランキング（/sns/snsranking/show_home.html）
**机制**：静态排行 + tab（综合/男/女）。
```
.lstTab > .tab#tabList1(総合) / #tabList2(男) / #tabList3(女)
.contentsContribute（一条）：
  .iconRank1/2/3（全国 N 位）
  .namelstProf（性别+昵称+年龄+城市+N访问）
  .textCommentRank p（简介节选）
  a.greenButton → /sns/snsprofile/show_profile.html?q=<token>
```

### 6.5 電話（/oshaberi/talk/show_tel_main.html）
**机制**：外链 App + 3 通话频道（フリートーク/セクシートーク/その他）→ /oshaberi/talk/show_tel_room.html?q=<token>。
通知轮询：#notification data-url=/oshaberi/talk/ajax_notification_tel.html。
**特点**：需装 App（App Store 链接），网页端仅入口。

### 6.6 我的列表（/sns/snsmylist/show_my_friends.html / show_bookmarks.html）
**机制**：静态 tab（フレンド/申請中/承認待ち）+ 空态「マイフレンドはいません」。
好友管理 /sns/snsmylist/show_my_friends_setting.html；マイリスト TOP /sns/snsmylist/show_my_list.html。
未读徽标 .caution（99）。

### 6.7 Pappy（/pappy/exec_pappy_redirect.html → www.pappy.jp/fromikuyo/?key=...）
**机制**：跨域外链（不属出会平台 DOM）。本账号 Pappy 通知入口在 mypage「Pappyから通知が届きました」。
Pappy 搜索结果（共通点引擎）走 Pappy 域，出会侧仅入口。

---

## 七、AJAX/表单端点总表（RPA 核心资产）

### 7.1 资料域
| 端点 | 方法 | 用途 |
|---|---|---|
| /sns/snssetting/exec_edit_profile_intro.html | Form POST | 保存自我介绍 |
| /config/settingprof/exec_profile_setting.html | Form POST | 保存基本资料 |
| /sns/snssetting/show_edit_profile.html | 传统 Form POST | 保存详细资料 |
| /sns/snssetting/ajax_edit_leisure.html | AJAX POST（data-action） | 保存兴趣（弹 popup） |
| /config/settingprof/exec_companionship.html | AJAX POST | 保存大人的交際（dateId/meetId） |
| /sns/snssetting/exec_face_image_register.html | multipart POST | 上传 face 头像 |
| /sns/snssetting/exec_profile_image_register.html | multipart POST | 上传 other 相册图 |
| /sns/snssetting/show_delete_image_confirm.html?q=... | 确认页 → exec | 删图（token 时效） |

### 7.2 流量域
| 端点 | 方法 | 用途 |
|---|---|---|
| /sns/snsashiato/ajax_delete_confirm.html | AJAX POST（data-action） | 批量删足迹（弹确认） |
| /sns/snsashiato/show_delete_all_confirm.html | Form POST | 全删足迹确认页 |
| /sns/snsashiato/ajax_delete_mine_confirm.html | AJAX POST | 批量删我的足迹 |
| /sns/snsashiato/show_delete_mine_all_confirm.html | Form POST | 全删我的足迹 |

### 7.3 搜索域
| 端点 | 方法 | 用途 |
|---|---|---|
| /sns/snsprofile/ajax_profile_list.html | AJAX POST | 滑动看资料（targetReMemberIdList/tab 分隔） |
| /profile/profilesearch/exec_routing_profile_search.html | Form POST | 高级搜索提交 |
| /profile/profilesearch/exec_reset.html | Form POST | 重置搜索条件 |
| /profile/leisuresearch/show_result_gallery.html?q=... | 页面 | 共通点结果（token 时效） |

### 7.4 日历域
| 端点 | 方法 | 用途 |
|---|---|---|
| /calendar/show_mine.html | AJAX POST（空 body） | 拉已排会える日（回 JSON） |
| /calendar/regist.html | 推断 AJAX POST | 保存/删会える日（selectDate/deleteDate/adds） |
| /calendar/ajax_delete_pref.html | AJAX POST（data-url） | 删指定会える日（aeruId/prefId） |

### 7.5 其他
| 端点 | 方法 | 用途 |
|---|---|---|
| /sns/snstype/delete_type_list.html | Form POST | 删类型（targetSnsMemberId[]） |
| /sns/snsdiary/show_write_confirm.html | Form POST | 写日记（两步确认） |
| /sns/snsdiary/show_search_result.html | Form POST | 日记全文检索 |
| /profile/typesearch/ajax_set_type_read.html?q=... | AJAX POST | 标类型「已看」 |
| /oshaberi/talk/ajax_notification_tel.html | AJAX GET（轮询） | 电话通知轮询 |
| /bbs/ajax_show_slider_list.html | AJAX POST | 帖子列表（module 3 已证） |

### 7.6 通用弹窗层
| 端点 | 方法 | 用途 |
|---|---|---|
| /other/javascript/show_popup.html | mfp 弹窗承载页 | 所有 AJAX 确认层（data-action 表单 action 落它，真实端点在 data-action） |

---

## 八、RPA 关键设计判断

1. **资料保存双轨**：传统 Form POST（intro/basic/detailed）+ AJAX POST（leisure/companionship）。
   写代码时按 §7.1 端点逐个封装，leisure/companionship 需模拟 jQuery $.ajax（非表单 submit）。
2. **data-* 卡片是流量池主入口**：#storedDisplay > div[id^=data_]（data-id=会员 ID）→ 滑动手势 →
   POST ajax_profile_list.html。这是「找对象」页与「共通点结果页」共用的核心机制。
3. **token 时效红线**：所有 ?q= base64 token 短效，RPA preflight 必须先导航 menu/mypage 拿新鲜 token。
4. **删足迹/删类型 = AJAX 批量**（checkbox 名 targetFootmarkId[]/targetSnsMemberId[] + data-action 端点）。
5. **日历 = FullCalendar 库**：点日期 toggle .fc-highlight，saveBtn 启用后才可提交。删走 ajax_delete_pref.html。
6. **被看数据无独立 AJAX 端点**：只能通过足迹页文案「本日の訪問者数 N 人」读。
7. **电话模块需 App**：网页端仅入口 + 通知轮询（ajax_notification_tel.html），无法网页真打电话。

---

## 九、未探/盲区（需后续补）

1. /sns/snsmylist/show_my_friends.html 实际有好友时的列表 DOM（当前 0 好友，空态已抓）。
2. /calendar/show_list.html（对方会える日）需登录对方视角或找公开入口。
3. Pappy 结果页（www.pappy.jp 域）跨域未探。
4. 日記明细页（/sns/snsdiary/show_diary_detail.html?q=）未单独抓（raw_diary_detail.html 已存档 module 3）。
5. 被看（閲覧）独立 AJAX 端点未确认——本账号未暴露，需其他账号验证。

---
*探测脚本存档：docs/tools/bbs-probe/_probe_run.js（通用 CDP 执行器）+ _probe_channel.js（底层连接）。
所有 raw/JSON/PNG 见本目录。*

---

## 十、menu.html（首页/路由表）+ show_faces.html 补充深挖（2026-10-25 19:45）

### 10.1 /menu.html（平台功能路由表 · 48 链接 · 无表单）
**角色**：整个出会平台的功能入口路由表。所有模块从这里出发。
**结构**：纯展示 + 导航 hub，无表单，3 个轮播（.slider-wrapper 12 items / .slider 12 items / .sliderPagerBox 4 items）。
**推荐会员轮播**：10 个 a → /sns/snsprofile/exec_profile_redirect.html?q=token（平台推荐"看看这个人"卡片，token 时效）。
**底部导航**：.bottom-nav-item×5（お相手探し/募集/メッセージ/タイプ/マイページ），タイプ 99、マイページ ! 未读徽标。
**功能入口全表（按模块）**：
| 模块 | 入口文案 | href |
|---|---|---|
| 招募·ピュア | 見る / 書く | /bbs/show_bbs.html?q=… / /bbs/show_write_list.html?q=… |
| 招募·大人 | 見る / 書く | /bbs/show_bbs.html?q=…（不同 token） |
| 会える日 | 見る | /calendar/show_list.html |
| 共通点 | 探す | /profile/leisuresearch/show_select_category.html |
| 高级搜索 | お相手検索 | /profile/profilesearch/show_profile_search.html?q=… |
| 新人検索 | 新人検索 | /sns/snssearch/show_search.html?q=… |
| 电话 | 話す | /oshaberi/talk/show_tel_main.html |
| Pappy | 探す | /pappy/exec_pappy_redirect.html |
| 日記·看 | 見る | /sns/snsdiary/show_search.html |
| 日記·写 | 書く | /sns/snsdiary/show_mydiary_form.html |
| 排行榜 | 見る | /sns/snsranking/show_home.html |
| 点数 | 追加/交換 | /point/purchase/show_top.html / /point/ptfemale/show_main_menu.html |
| 设置 | 各種設定 | /config/settingprof/show_setting_top.html |
| 其他 | 友紹介/お問い合わせ/利用規約/ダイレクトログイン | /affiliate/… / /other/contact/… / /other/term/… / /registration/login/show_login_direct.html |

### 10.2 /sns/snssearch/show_faces.html（お相手探し · 补充深挖）
**页面特征**：数据层已有 48 张 data-N 卡片（data-id/name/age/pref/city/certify/type）+ POST /sns/snsprofile/ajax_profile_list.html。本次补充 UI 层细节。
**顶部分数栏**：#header_point_value（50pt）+ #header_gold_value（577G）+ 追加/交換 链接。
**搜索条件栏（.searchbar）**：
- .searchlink > a → /sns/snssearch/show_face_setting.html?q=token（**筛选条件设置页**，文案「津市を表示中」= 当前筛选城市）
- .listButtonFace > a → show_faces.html?q=新token（列表视图切换，同页内换排序/视图）
**新增端点**：/sns/snssearch/show_face_setting.html?q=token（筛选条件设置页，本次未深入，下一步可补）。
**全局变量（页面级，RPA 可直接读，比解析 DOM 快且稳）**：
- var memberIdList = "22793353,12612558,..."（48 个会员 ID 逗号列表 = 当前页全部 data-id 的合集）
- var myname = ともね（账号昵称）、mycertify = "1"（认证标志）
- var myTemplateList / defaultTemplateList（模板列表，当前空）
**滑动资料层**：#profileSlideWrapper > #profileSlide（空容器，滑动看资料时由 ajax_profile_list.html 返回 HTML 填入）。
**「会いたい」待确认弹窗**：#popup_aitai_message > #send_aitai_btn（「はい、送信する」）+ #cancel_aitai_btn（取消）——点它会触发对某会员的「会いたい」消息，**强副作用，RPA 必须走 send-live 人工确认流**。
**4 tab 结构（.tablink-item）**：
| tab | href | 说明 |
|---|---|---|
| ログイン順（active） | /sns/snssearch/show_faces.html?q=token | 按登录时间排序 |
| 登録順 | /sns/snssearch/show_faces.html?q=token | 按注册时间排序 |
| 共通点 | /profile/leisuresearch/show_select_category.html | 按兴趣分类 |
| Pappyで探す | /pappy/exec_pappy_redirect.html | 跨域跳 Pappy |
**底部导航**：.bottom-nav-item×5，.item-active 标记当前（お相手探し active）。
**RPA 要点**：
1. window.memberIdList 全局变量 = 最快的会员 ID 列表来源（不用逐张解析 48 DOM 卡）。
2. 筛选入口 show_face_setting.html 是独立的筛选表单页（与 §3.2 高级搜索 show_profile_search.html 是**两个不同入口**，下一步补 show_face_setting.html 的字段结构）。
3. #send_aitai_btn「会いたい」是强副作用消息入口（对特定会员发起会いたい），需人工确认。
4. 列表视图切换（.listButtonFace）= 带新 token 的同页跳转，不产生导航副作用。

### 10.3 本次新增存档
- menu_01_raw.html / menu_01_structure.json / menu_01.png（menu 首页全量结构）
- search_02_faces_raw.html / search_02_faces_tabs.json（faces 筛选栏 + tab + 全局变量）
---

## 十一、加深探测补充段（2026-10-25 20:30）

### 11.1 show_face_setting.html（faces 筛选表单 · GET Form）
**端点**：GET /sns/snssearch/exec_face_setting.html（非 POST，区别于 §3.2 的 POST 高级搜索）
**字段（17 inputs，2 表单：search + reset）**：
| 字段 | 类型 | 取值 |
|---|---|---|
| ageFrom / ageTo | select | 0 指定なし / 1 18-19 / 2 20前半 / 3 20后半 / 4 30前半 / 5 30后半 / 6 40前半 / 7 40后半 / 8 50前半 / 9 50后半 / 10 60以上 |
| 提交 | button#search | "1"（绿按钮） |
| 重置 | button#reset | "reset"（灰按钮） |
**入口**：show_faces.html 的 `.searchlink a`（文案「津市を表示中」→ 点击进此页）。
**RPA 要点**：GET 表单 = 参数走 URL query string，比 POST 简单，直接拼 query 即可。

### 11.2 /calendar/show_list.html（对方会える日 · 展现形式）
**机制**：FullCalendar 渲染对方已注册可会日 + 12 张 list-search 卡片（对方名册）。
**卡片结构**（.list-search.list-male / .list-female）：
- .list-img > a → /sns/snsprofile/show_profile.html?q=token（头像 → 对方 profile）
- .list-desc > .desc-txt（自我介绍节选）+ .list-desc-age（年龄）
- **关键隐藏层**：`div#aeru_<ID> data-name data-memberid data-type data-pref data-prefid data-aeruid data-thumbnail data-month data-day`
  - `data-aeruid` = 会える日 记录 ID（删/改用它）
  - `data-memberid` = 会员 ID（跨域去重锚点，与 data-id 对应）
  - `data-month`/`data-day` = 对方注册的可会日
- **「会いたい」按钮**：`span#calendar_<aeruid>.btn-wantmeet onclick="sendAeruMessageConfirm(<aeruid>);"`
  - 点它 → 弹确认 → 对某会员发「会いたい」消息（**强副作用，走 send-live 确认流**）
  - 已发则显示 `.btn-wantmeet.meetdisable`（aitai-off.png）
**JS 端点**：`/calendar/show_mine.html`（拉数据）+ `/calendar/regist.html`（保存/删）
**入口**：menu.html「会える日 → 見る」/ mypage.html「設定している日を確認」

### 11.3 忽略列表（/sns/snsmylist/show_ignore_list.html）
**机制**：传统 Form POST → /sns/snsmylist/exec_remove_ignore.html。
**字段**：
- checkbox `targetReMemberIdList[]`（每个忽略对象 1 个，value=会员 ID）
- button「無視解除」(type=submit)
**当前账号**：0 条忽略（空态）。
**RPA 要点**：勾选 → 点「無視解除」→ POST 解除忽略。

### 11.4 不在列表（/sns/snsmylist/show_notsees_list.html）
**机制**：无表单（0 form），空态文案「40人まで登録できます。」。
**作用**：「不在」= 让对方看不到自己的足迹/不显示在某些列表（隐私屏蔽），与「忽略」（不接收对方消息）不同。
**上限**：40 人。

### 11.5 好友申请（/sns/snspending/show_friend_request.html）+ 审批（show_friend_approve.html）
**机制**：静态列表页，当前账号 0 条（空态）。
**tab 结构**（my_friends.html）：フレンド / 申請中（show_friend_request.html）/ 承認待ち（show_friend_approve.html）
**RPA 要点**：有申请/审批时列表 DOM 未抓到（需账号有好友数据），后续补。

### 11.6 日記详情（/sns/snsdiary/show_diary_detail.html）
**机制**：传统页面（无 AJAX，全静态），token 时效。
**结构**：
- `#titleDiaryDetail`（标题，span.womanTitle / .manTitle）
- `#bgOthers`：icon_view（N 人看过）+ icon_comment_gray（N 条评论）+ 时间
- `#textDiaryDetail` > p（正文，含 <br> 换行）
- `#btnOthersDiaryDetail`：
  - `#btnGood` → a.exec_cheer.html?q=token（点赞，GET 链接，**强副作用**）
  - `#btnComment`（a#comment，跳评论区）
  - `#numberComment`（评论数）
- `#btnPageDiaryDetail`：前の日記 / 日記一覧（show_diaries.html?q=）/ 次の日記
- `#btnReport` → show_report_home.html（支持举报）
- 投稿者 profile 块：.contentsContribute.contributor
  - `.cbName`（昵称）+ 城市/年龄
  - 「メッセージを送る」→ /mail/inbox/show_history.html?q=token（**直达对方聊天页**，跨模块动作）
  - 「プロフを見る」→ /sns/snsprofile/exec_profile_redirect.html?q=token
- `#commentList`（评论区，接受评论时可见）
**RPA 要点**：
1. 点赞 = 点 `#btnGood`（GET exec_cheer.html，token 时效）
2. 写评论 = 滚到 #comment 区（评论表单未在 raw 里，接受评论时可见，需补）
3. 跨模块：详情页可直达聊天（show_history.html?q=），Ai SAY 做「看日记 → 打招呼」链路时
4. 日記検索页（show_search.html）有 24 条 a[href*=diary]，其中 show_friends.html / show_ranking_pure.html / show_diary_detail.html 是 3 类不同入口

### 11.7 本次新增存档
- face_setting_01_raw.html / face_setting_01_form.json / face_setting_01.png（faces 筛选表单全字段）
- calendar_03_show_list_raw.html / calendar_03_show_list_form.json（对方会える日 卡片 + aeruid 隐藏层）
- mylist_03_ignore_form.json / mylist_03_ignore_raw.html（忽略列表）
- mylist_04_notsees_form.json / mylist_04_notsees_raw.html（不在列表）
- pending_01_friend_req_* / pending_02_friend_approve_*（好友申请/审批）
- diary_05_detail_form.json / diary_05_detail_raw.html / diary_05_detail.png（日記详情全结构）
- calendar_02_regist.json（日历保存/删除机制细节）
---

## 十二、右侧「三点菜单」全动作探测（2026-10-26）

> 入口：会员资料页（show_profile.html）右上角 `a#popup-menu-link.popup-modal`（三个点图标）
> 目标：`#popup-modal-<memberId>`（Magnific Popup 内联弹窗，DOM 常驻但 mfp-hide 隐藏）
> 本账号实测目标：AAA（24032927，41 岁 德岛，日记作者）

### 12.1 弹窗 DOM 全结构

```html
<a class="popup-modal" href="#popup-modal-<memberId>" id="popup-menu-link"></a>

<div id="popup-modal-<memberId>" class="white-popup-block">
  <ul class="btn-inner-popup">
    <li><a href="/sns/snsmylist/show_add_my_friend_confirm.html?q=<token>">友達申請する</a></li>
    <li><a href="/sns/snsmylist/exec_add_bookmark.html?q=<token>">お気に入りに入れる</a></li>
    <li><a href="/memo/memosetting/exec_routing_memo.html?q=<token>">メモする</a></li>
    <li><a data-url="/sns/snsmylist/ajax_ignore_regist.html?q=<token>"
           href="/other/javascript/show_popup.html" class="popup-modal-close popLink">無視する</a></li>
    <li><a href="/sns/snsprofile/show_report_home.html?q=<token>">通報する</a></li>
  </ul>
  <a class="popup-modal-close" href="#">キャンセル</a>
  <button title="Close (Esc)" type="button" class="mfp-close">×</button>
</div>
```

### 12.2 五动作机制对照表

| 动作 | 目标端点 | 机制 | 副作用级别 |
|---|---|---|---|
| 友達申請する | /sns/snsmylist/show_add_my_friend_confirm.html?q= | 传统跳转确认页（两步） | 中（发好友申请） |
| お気に入りに入れる | /sns/snsmylist/exec_add_bookmark.html?q= | 传统跳转直达执行 | 中（加书签） |
| メモする | /memo/memosetting/exec_routing_memo.html?q= | 传统跳转（写备注） | 低 |
| **無視する** | **data-url=/sns/snsmylist/ajax_ignore_regist.html?q=** | **AJAX（popLink + data-url，Common.js 拦截 .popLink 点击发 $.post，不进确认页）** | 中（可逆：忽略列表可解除） |
| 通報する | /sns/snsprofile/show_report_home.html?q= | 传统跳转（举报流程） | 高（不可逆，慎用） |

### 12.3 忽略机制坐实（与 §11.3 闭环）

- **加入忽略**：资料页三点菜单「無視する」→ AJAX POST /sns/snsmylist/ajax_ignore_regist.html?q=<token>
  - q token 是**该会员专属**（与其他动作共用同一 token 体系，短效）
  - 走 mfp 弹窗层（href=/other/javascript/show_popup.html 是弹窗承载页，真实请求在 data-url）
- **解除忽略**：/sns/snsmylist/show_ignore_list.html 的 form1 → POST /sns/snsmylist/exec_remove_ignore.html
  - 勾选 `targetReMemberIdList[]`（value=会员 ID，本账号 memberId 可从资料页 `span[data-memberid]` / `a#likeBtn<id>` 读）→ 点「無視解除」
  - **完整闭环**：可加可删，适合测试
- 会员 ID 锚点：资料页 `span[data-memberid="24032927"]` ×2 + `a#likeBtn24032927`，与日历页 `data-memberid` 同构（跨域去重锚点再验证）

### 12.4 写日记全字段（§6.2 深化）

```
form → POST /sns/snsdiary/show_write_confirm.html（两步：先写后确认页）
  input[type=text].title  name=(无) class=inputTxtRd top0 w94  <!-- 标题 -->
  textarea.body           name=body class=inputTextAreaRd top0 w94  <!-- 正文，max=-1 无限 -->
  input[type=checkbox].adultFlag   value=1  <!-- 含露骨内容 -->
  select publicFlag    1=全体公开 / 2=会员のみ / 3=朋友のみ / 4=非公开 / 6=下書き
  select commentReceptFlag  0=不接受 / 1=接受
  input[type=submit]#submit1.greenButton value=書き込む
```
- **publicFlag=6（下書き）= 安全测试项**：写草稿不外发，验证链路无副作用
- 测试帖子建议：publicFlag=6 下書き + commentReceptFlag=0，验证后可在日记列表删除

### 12.5 本次新增存档

- popup_menu_structure.json / ignore_probe_profile_raw.html（资料页三点弹窗全 DOM + 目标会员 AAA 数据）
- ignore_probe_button.json / ignore_probe_commonjs.json（忽略按钮机制 + data-url 结构）
- ignore_list_probe.json（忽略列表页确认：0 条空态 + 解除表单）
- diary_write_full_form.json / diary_write_full_raw.html（写日记全字段 + 选项值）
---

## 十三、忽略测试实测记录（2026-10-26 · 总控批准）

> 总控批准：忽略测试对象 AAA（24032927）可加可删；日记测试先出文案、总控同意后再发。

### 13.1 实测结果（忽略闭环 ✅ 通过）

| 步骤 | 动作 | 结果 |
|---|---|---|
| 1 | 打开 AAA 资料页（memberId=24032927），确认 `a[data-url*="ajax_ignore_regist"]`（「無視する」）在位 | ✅ |
| 2 | 点「無視する」→ AJAX POST /sns/snsmylist/ajax_ignore_regist.html?q=<token>（Common.js 拦截 .popLink，不进确认页直接生效） | ✅ 按钮点了，页面停留原地 |
| 3 | 回 /sns/snsmylist/show_ignore_list.html 验证 | ✅ 列表新增 checkbox value=**24032927**（AAA）+ value=**22878742**（另一条，本账号之前就存在的忽略） |
| 4 | 勾两个 checkbox → 点「無視解除」（form POST exec_remove_ignore.html） | ✅ 页面重定向回忽略列表 |
| 5 | 重读忽略列表 | ✅ 0 条残留，空态文案「無視リストから削除しました」 |

**结论**：忽略功能完全可逆（可加可删），适合自动化测试。AAA 的忽略已加又已删，账号状态恢复干净。

### 13.2 关键发现

1. **忽略列表页是动态渲染的**：首次抓 `items=0` 但 `checkboxes=[24032927, 22878742]` —— 列表项是 `.list-item` 容器，首次 ENUM 选择器没匹配上，但 checkbox 在。RPA 读忽略列表时**不要靠 .list-item，直接读 `input[type=checkbox][name="targetReMemberIdList[]"]` 的 value** 最稳。
2. **「無視解除」是传统 form POST**（非 AJAX）：`form1 → POST /sns/snsmylist/exec_remove_ignore.html`，提交后跳回忽略列表页（?q= 空），空态文案「無視リストから削除しました」是成功标志。
3. **加忽略 = AJAX（ajax_ignore_regist）；删忽略 = 传统 POST（exec_remove_ignore）** —— 两个方向机制不同，RPA 要分别封装。
4. **22878742 是历史残留忽略**（本账号之前加的，非本次测试对象）。本次测试把它也一起解除了，账号忽略列表清零。

### 13.3 本次新增存档

- ignore_test_step1.json / ignore_test_step2.json / ignore_test_step3.json / ignore_test_step4_verify.json（4 步实测）
- ignore_list_check.json + ignore_list_check.png（忽略列表有数据时的 DOM）
- commonjs_poplink.json（Common.js 探测记录）
---

## 十四、日记测试实测记录（2026-10-26 · 总控批准）

> 总控批准：用ともね人设文案写一篇全体公开日记测试"新建日记"功能，测完删除收尾。

### 14.1 实测结果（新建日记闭环 ✅ 通过，已删除）

| 步骤 | 动作 | 结果 |
|---|---|---|
| 1 | 打开写日记页 /sns/snsdiary/show_mydiary_form.html | ✅ |
| 2 | 填入标题「休日の予定、こんな感じ。」+ 251 字人设正文 + publicFlag=1（全体公開）+ commentReceptFlag=1（受け付ける）+ adultFlag=false | ✅ |
| 3 | 点「書き込む」→ 跳确认页 /sns/snsdiary/show_write_confirm.html（内容正确展示：标题+正文+「公開範囲：全体公開」） | ✅ |
| 4 | 确认页点「書き込む」（form1 → POST /sns/snsdiary/exec_write.html） | ✅ 跳 complete_write.html「日記を投稿しました」 |
| 5 | 回 /sns/snsdiary/show_mydiaries.html 验证 | ✅ 列表出现「10/26 18:43 休日の予定、こんな感じ。… (全体公開) 0件 7閲覧」 |
| 6 | 勾选 checkbox targetDiaryIdList[]=11978450 → 点删除图标 → 确认页 → 点「はい」（POST exec_delete_mydiary.html） | ✅ 跳回 show_mydiaries.html |
| 7 | 重读列表 | ✅ 「日記はありません」，零残留 |

**结论**：新建日记链路完整可测——填表→确认页→发布→列表可见→删除收尾，全程闭环、账号状态干净。

### 14.2 关键发现（RPA 要点）

1. **写日记 = 两步传统 Form POST**：show_mydiary_form.html（填表）→ show_write_confirm.html（确认）→ exec_write.html（执行）。**无 AJAX**，和 BBS 发帖同构（填字段→点 submit→过确认页）。
2. **我的日记列表页 = /sns/snsdiary/show_mydiaries.html**（不是 show_mydiary_list.html，那个是 404/重定向）。列表项含：日期、标题、正文节选、公开范围文案、评论数、浏览数。
3. **删日记 = 勾选 + 确认页**：checkbox `targetDiaryIdList[]`（value=日记 ID，本例 11978450）→ 点删除图标（`a[href*="delete_mydiary_confirm"]`，纯图标无文字）→ 确认页 `show_delete_mydiary_confirm.html` → 点「はい」(form1 → POST exec_delete_mydiary.html)。「いいえ」(form2) 回列表。
4. **日记详情页有「前の日記／次の日記／日記一覧」翻页**（§11.6），日記一覧入口 = show_diaries.html（需 token）。
5. **publicFlag=6（下書き）= 草稿**，不外发，可做"零副作用"链路测试；publicFlag=1（全体公開）= 正常发布可被他人刷到。

### 14.3 人设日记文案（已发布又已删，存档备查）

> 标题：休日の予定、こんな感じ。
> 正文：今日は何の予定もなく、のんびり一日を過ごしました。午前は近所の銭湯で湯に浸かり、その後ゆっくり本を読みながらカフェで過ごしました。夕方からは映画を観ようと思っています。…こんな日常が、もう少し賑やかになるといいなと思います。会話が弾むお相手と、休日にランチに行ったり、温泉を巡ったりすることが理想です。…まずはお気軽にお声かけください。

### 14.4 本次新增存档

- diary_test_filled2.json / diary_test_submit.json / diary_test_exec.json（发布三步）
- diary_confirm_page.json / diary_confirm_raw.html / diary_confirm.png（确认页）
- diary_mydiaries_probe.json / diary_mydiaries_dom.json / diary_mydiaries_full_raw.html（我的日记列表 DOM）
- diary_delete_step1/2/3.json / diary_delete_confirm_page.json / diary_delete_verify.json（删除五步）