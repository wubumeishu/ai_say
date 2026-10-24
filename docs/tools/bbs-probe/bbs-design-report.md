# 出会平台 BBS（帖子/动态）模块 · 完整设计探测报告
> 总控 2026-10-23 CDP 只读探测（窗口 2315e879「不能删」，CDP 端口 50227）。
> 全部只读：只抓 DOM/HTML/AJAX 端点/表单结构，不发帖、不删除、不编辑。
> 证据：本目录 10+ 份 raw HTML + 本文件。

## 一、页面地图（含跳转流转）

| 页面 | URL | 角色 | 关键设计 |
|---|---|---|---|
| 主菜单 | /menu.html | 入口 | 「募集」板块有 2 个 tab（ピュア募集 / 大人の募集），每个 tab 下「見る」→ show_bbs.html?q=、「書く」→ show_write_list.html?q= |
| 帖子列表（看） | /bbs/show_bbs.html?q=<token> | 浏览帖子 | **AJAX 动态加载**：点 genre tab → POST /bbs/ajax_show_slider_list.html（参数 count=15&page=1&prefId=24&targetGenreId=<g>&hokkaidoFlag=0）→ 返回 HTML 填入 #storedDisplay。帖子卡片 = .recruit-list |
| 帖子详情 | /bbs/show_bbs_detail.html?q=<token> | 看单帖 | 发帖人信息（data-id=帖子ID，data-name=昵称）+ 帖子正文（AJAX 异步加载到 #data_0）+ 操作区「メッセージを送信する」「通報する」「無視する」 |
| 写帖子入口 | /bbs/show_write_list.html?q=<token> | 选 genre | 8 个 genre 入口（.subMenu a.jump → show_write.html?q=）：全国男女メル友/地域メル友/今から遊ぼ/友達恋人合コン/まずは食事から/ミドルエイジ/画像付きの募集。底部「募集を見る」「募集履歴」 |
| 帖子表单（写/改） | /bbs/show_write.html?q=<token> | 发帖/编辑 | **单表单 POST** /bbs/exec_routing_bbs_write.html。编辑复用同表单（is_edit=1 + identifier=帖子ID） |
| 招募历史 | /bbs/show_bbs_write_list.html | 我的帖子 | 3 tab（ピュア/大人/会える日）+ 空状态 .noMessage「募集に投稿がありません」。**当前账号 0 历史帖，条目 DOM 未抓到** |
| 地区移动 | /bbs/show_bbs_area_move.html?q=<token> | 改查看地区 | 47 都道府县 + 北海道 4 分区选择（纯文本列表，非 select），改的是「查看地区」非 profile 住址 |

## 二、帖子卡片 DOM（show_bbs.html 列表项，15 个/页）

```html
<div class="recruit-list">                <!-- 一条帖子 -->
  <div class="recruit-1">                 <!-- 顶部：genre 标签 + 时间/浏览数 -->
    <span class="cat-btn cat5">今から遊ぼ</span>
    <div class="view-date">
      <span class="view">[img] 3</span>   <!-- 浏览次数 -->
      <span class="date">[img] 10/18 12:37</span>
    </div>
  </div>
  <div class="recruit-list-link">
    <div class="recruit-list-img">        <!-- 发帖人头像 -->
      <div class="recruit-list-thumb">
        <a href="/sns/snsprofile/show_profile.html?q=...">
          <img src="//images.194964.com/snsprofr/....jpg">
        </a>
      </div>
    </div>
    <a href="/bbs/show_bbs_detail.html?q=<base64>" class="recruit-list-txt">
      <div class="recruit-list-name man-title-color">なにか...</div>  <!-- 帖子标题 -->
      <div class="recruit-list-age">
        <span class="online-icon online-icon1"></span>              <!-- 在线状态 -->
        かっちゃん 56歳
      </div>
      <div class="recruit-list-home">[img]伊勢市</div>               <!-- 地区 -->
      <div class="recruit-list-photo">[img][x] 2</div>               <!-- 图片数 -->
    </a>
  </div>
</div>
```
- 卡片整块 = .recruit-list（含 1 个 .recruit-list-link）
- 标题 = .recruit-list-name；发帖人 = .recruit-list-age（昵称+年龄）；地区 = .recruit-list-home
- 详情 href 是 base64 token（show_bbs_detail.html?q=...），**不能持久缓存**（token 时效）
- 头像/详情链接都可跳 snsprofile/show_profile.html（跨模块复用客户画像）

## 三、帖子表单（写/改，show_write.html）

```html
<form action="/bbs/exec_routing_bbs_write.html" method="post" id="formID">
  <input type="hidden" name="identifier">       <!-- 帖子ID（编辑时填） -->
  <input type="hidden" name="targetGenreId">    <!-- genre（5/1/3/4/19/6/17/98） -->
  <input type="hidden" name="prefId">           <!-- 都道府县（24=三重） -->
  <input type="hidden" name="is_edit">          <!-- 0=新发 1=编辑 -->
  <input type="hidden" name="point">            <!-- 消耗点数 -->
  <textarea name="title" class="inputTextAreaRd titleBbs">  <!-- タイトル 30文字以内 -->
  <textarea name="body"  class="inputTextAreaRd">           <!-- 内容 500文字以内 -->
  <input type="file" name="imageFile" id="fileupload">      <!-- 可选图片 -->
  <input type="hidden" name="uploadFlg">
  <input type="hidden" name="imageDeleteFlg">
  <button type="submit" name="write"    class="greenButton width60">募集する</button>
  <button type="submit" name="confirm"  class="button width60">確認する</button>
</form>
```
- **标题 ≤30 字、正文 ≤500 字**（平台硬限制，页面文本明示）
- 2 个 submit 按钮：先点「募集する」（name=write）→ 二次确认「確認する」（name=confirm）
- 编辑 = is_edit=1 + identifier=帖子ID，复用同一表单（**改帖不用找单独编辑页**）
- 防封规则：**「投稿した募集は1時間経過後に再募集可能です」**（发帖后 1 小时冷却）

## 四、8 个 genre tab（show_write_list.html 的 .subMenu）

| genreId | 名称 |
|---|---|
| 1 | 全国男女メル友 |
| 3 | 地域メル友 |
| 5 | 今から遊ぼ |
| 4 | 友達・恋人・合コン |
| 19 | まずは食事から |
| 6 | ミドルエイジ |
| 17 | 画像付きの募集 |
| 98 | 出会いチャンス |

## 五、关键设计判断（决定 RPA 架构）

1. **「查」走 AJAX 端点**：帖子列表不是静态 HTML，是 POST /bbs/ajax_show_slider_list.html 返回 HTML 片段。RPA 查帖子 = 直接 POST 这个端点（参数 count/page/prefId/targetGenreId），比导航抓 DOM 更稳、更快、不销毁 CDP 上下文。
2. **token 时效短**：所有 ?q= 都是动态生成的，手抄/缓存必撞「システムエラー 99-00001」。RPA preflight 必须先实时导航 menu/write_list 拿新鲜 token（与 ichigoBlockExpr.js 的「点 編集 保留 token」同模式）。
3. **发帖/改帖 = 单表单 POST**：和 ichigoSendExpr.js 真发机制同构（填字段 → 点 submit → 处理确认）。可复用「填 textarea + 点按钮 + 检测确认页」的 RPA 套路。
4. **删除帖子的 DOM 入口仍未探到**：招募历史当前 0 帖，看不到帖子条目上的「編集/削除」按钮。这是唯一盲区，需账号有历史帖才能抓。
5. **详情页「メッセージを送信する」是跨模块动作**：帖子详情可直达聊天（module 1 的 send-live 域），模块 3 要预留接口但不混入发帖逻辑。

## 六、防封线索（模块 3 核心机制）

- 平台明写 **1 小时冷却**（再募集可能）→ 应落库为 GovernanceRule 或 AccountPersona 发帖冷却字段
- 帖子消耗 point（表单有 point 字段，当前账号 50pt）→ 发帖有成本，RPA 应带点数检查
- 编辑复用表单 → 「改帖」不额外消耗冷却时间（推测，需实测）

## 七、Genre 分类纠正（总控 2026-10-23 指正 + 2026-10-25 数字 ID 补齐）

帖子分 **2 个板块**，genre 列表各自独立：

**ピュア募集**（7 个 genre，show_write_list.html?q=Zlo2amdM...）：
| genreId | 名称 |
|---|---|
| 1 | 全国男女メル友 |
| 3 | 地域メル友 |
| 5 | 今から遊ぼ |
| 4 | 友達・恋人・合コン |
| 19 | まずは食事から |
| 6 | ミドルエイジ |
| 17 | 画像付きの募集 |

**大人の募集**（9 个 genre，show_write_list.html?q=cm1BMlxO...，数字 ID 于 2026-10-25 实测补齐）：
| genreId | 名称 |
|---|---|
| 7 | すぐ会いたい |
| 8 | 大人の出会い |
| 9 | 既婚者募集 |
| 10 | メールＨ |
| 11 | ミドルエイジ |
| 12 | アブノーマル |
| 14 | 同性愛 |
| 18 | 画像付きの募集 |
| 20 | まずは食事から |

⚠️ 注意：大人的 genre ID 数字与ピュア**不连续**（7/8/9/10/11/12/14/18/20），13/15/16/17 缺号——说明平台全局 genre 字典是统一编号，ピュア/大人の只是按板块展示子集。RPA 发帖时 targetGenreId 直接传对应数字即可（POST /bbs/ajax_show_slider_list.html 与 exec_routing_bbs_write.html 都认）。
数字 ID 实测方法：导航到各 show_write.html 编辑表单页（等待 9s 让 input[name=targetGenreId] 渲染）→ 读该 hidden input 的 value。

## 八、扩展探测（非招募模块的同类页面，总控 2026-10-23 要求）

> 这些页面的**删除机制全部同构**（checkbox + チェックを削除 + 确认页），
> 模块 1 拉黑 5 步 RPA 的 selector 可直接套用。

### 8.1 タイプ（点赞）模块 — /sns/snstype/

| 页 | URL | 设计 |
|---|---|---|
| タイプされた | /sns/snstype/show_typed_list.html | 10 条/页，.type--list 条目 + checkbox + 删除表单 |
| タイプした | /sns/snstype/show_type_list.html | 同上（我点赞的人） |
| 両想い | /sns/snstype/show_mutual_list.html | 同上（互相点赞） |

- 条目容器：.type--list（含 .type-list-check > input[type=checkbox][name=targetSnsMemberId[]] + .type-list-link > .type-list-img / .type-list-name / .type-list-age / .type-list-date）
- 删除：勾选 checkbox → form POST /sns/snstype/delete_type_list.html → button「チェックを削除する」（.button.width70）
- **与出会拉黑 5 步完全同构**（checkbox + 提交按钮 + 确认页），可直接复用 ichigoBlockExpr.js 的 Step2/3/4/5 逻辑，只改 selector（targetSnsMemberId[] vs targetReMemberId[]）
- 条目跳转：.type-list-link → /profile/typesearch/ajax_set_type_read.html?q=（AJAX 已读标记）或 /sns/snsprofile/show_profile.html?q=（资料页）

### 8.2 お相手探し（资料搜索）— /sns/snssearch/

| 页 | URL | 设计 |
|---|---|---|
| 顔面検索 | /sns/snssearch/show_faces.html | 48 张头像九宫格（.photo-item-new × 48），3 tab（津市を表示中 / ログイン順 / 登録順） |
| 综合搜索 | /profile/profilesearch/show_profile_search.html | **大表单 44 输入**：地区/年龄/身高/婚姻(married[] 多选)/孩子/眼睛(eyes[])/收入/空闲时间…，POST /profile/profilesearch/exec_routing_profile_search |

- 头像九宫格：.photo-item-new > .photo-item-thumb（img）+ .photo-name + .photo-desc，跳 snsprofile/show_profile.html?q=
- 综合搜索表单可复用为「按条件找客户」RPA（填 select/checkbox → 点 検索する → 抓结果页），但模块 3 暂不需要
- 新人搜索：/sns/snssearch/show_search.html?q=

### 8.3 あしあと（足迹/访客）— /sns/snsashiato/

| 页 | URL | 设计 |
|---|---|---|
| 足迹列表 | /sns/snsashiato/show.html | 20 条/页，.type--list 条目（**与タイプ页同结构**）+ 删除表单 |
| 自己的足迹 | /sns/snsashiato/show_mine.html | 我访问过的人 |
| 全删确认 | /sns/snsashiato/show_delete_all_confirm.html | 批量删除确认页 |

- 条目：.type-list-check > checkbox + .type-list-link → snsprofile（访问来源：プロフィール検索・その他より / タイプより）
- 删除：勾选 → form POST /other/javascript/show_popup.html（22 输入）→「チェックを削除」+「すべて削除する」

### 8.4 日記（SNS 动态）— /sns/snsdiary/

| 页 | URL | 设计 |
|---|---|---|
| 看（全部） | /sns/snsdiary/show_search.html | 地区筛选 + .list-item 日记条目（.type-list-title / .type-list-view） |
| 写 | /sns/snsdiary/show_mydiary_form.html | **表单 POST /sns/snsdiary/show_write_confirm.html**（8 输入）：标题 + 本文 + アダルト要素 checkbox + 公开范围（全体/会員/友達/非公开）+ 下書き + 评论设置 |
| 写确认 | /sns/snsdiary/show_write_confirm.html | 二次确认（写帖子同款 2 按钮） |
| 我的日记 | /sns/snsdiary/show_mydiaries.html | 我的帖子列表（编辑/删除入口） |
| 日记详情 | /sns/snsdiary/show_diary_detail.html?q= | 日记正文 + 「いいね！」（POST /sns/snsdiary/exec_cheer.html?q=）+ 评论区（POST show_comment_diary_confir，250 字限制，按钮「内容確認」「投稿する」）+「サポートに通報する」 |

- 日记 = 出会平台的「动态」模块，和招募帖子是**两套独立系统**（招募=bbs/，日记=snsdiary/）
- 写日记表单 4 公开范围 + アダルト 必须勾选（「違反する場合は通告なく削除します」），RPA 写日记时要带上

## 九、全部删除/下架端点汇总（模块 3 RPA 总表）

| 操作 | 触发页 | 确认页 | 提交 | 备注 |
|---|---|---|---|---|
| 招募帖子编辑 | show_bbs_write_detail.html | show_bbs_write_edit.html?targetBbsId= | POST exec_routing_bbs_write.html（is_edit=1） | title≤30/body≤500，2 按钮 |
| 招募帖子下架（非公开） | show_bbs_write_detail.html「掲載停止」 | exec_bbs_close.html | POST | 不删除，停止展示 |
| 招募帖子删除（单） | 招募历史勾选 checkbox「チェックを削除」 | show_bbs_confirm_delete.html?identifier=delete&targetBbsId= | POST | 确认页「削除する/キャンセル」 |
| 招募帖子删除（全部） | 招募历史「すべて削除する」 | show_bbs_confirm_delete_all.html | POST | 「すべての募集を削除します よろしいですか？」 |
| 类型点赞删除 | タイプされた/した/両想い 勾选 | delete_type_list.html | POST | 同拉黑 5 步 |
| 足迹删除 | あしято 勾选 | show_delete_all_confirm.html | POST | 同类型 |
| 日记点赞 | 日记详情「いいね！」 | exec_cheer.html?q= | POST | 无确认页 |
| 日记评论 | 日记详情评论区 | show_comment_diary_confir.html | POST | 250 字限制 |

## 十、防封设计总结（模块 3 核心机制）

1. **招募 1 小时冷却**（明写「投稿した募集は1時間経過後に再募集可能です」）→ GovernanceRule 落库
2. **帖子消耗 50pt**（point 字段）→ RPA 发帖前检查点数余额
3. **日记/招募分开限频**：两套独立系统，冷却规则可能不同（日记未明写）
4. **编辑复用表单**：改帖 is_edit=1，不额外消耗冷却（推测，需实测）
5. **token 全时效**：?q= 动态生成，RPA preflight 必须实时导航拿新鲜 token
6. **删除确认页仅 POST 可达**：GET 访问 confirm_delete.html 会重定向回列表页，RPA 必须走表单 POST 流程

## 十一、遗留盲区

- **大人の募集 的 9 个 genre ID 未抓全**（只有名称，缺数字 ID）——需在该板块 show_write_list 抓 .subMenu a.jump 的 data-genre
- **招募帖子「下架/非公开」后的恢复入口**未探（exec_bbs_close.html 是下架，恢复在哪未抓）
- **类型/足迹的删除确认页**未单独抓（推测与拉黑同构，需实测）


## 十二、RPA 表达式实现（2026-10-23 落地）

| 操作 | 表达式文件 | 注入占位符 | 触发页 | 提交 |
|---|---|---|---|---|
| 查（列表） | ichigoBbsQueryExpr.js | __BBS_OPTS__ | 任意 194964 域 | POST /bbs/ajax_show_slider_list.html |
| 改/增（编辑） | ichigoBbsWriteExpr.js | __BBS_WRITE_OPTS__ | show_bbs_write_edit.html?targetBbsId= | 填 textarea → button[name=write]「募集する」→ button[name=confirm]「確認する」 |

### 改/增 执行边界（总控定死）
- 目标帖：targetBbsId=178898703
- **删**：首行「はじめまして！真面目な出会いを探して登録しました。」
- **加**：结尾「少しでも気になっていただけたら、お気軽にメッセージをいただけると嬉しいです。」
- 其他一字不动。字数 125/500 ✓

### 防封（模块3 核心）
- 招募 1h 冷却（明写）→ GovernanceRule 待落库
- 帖子消耗 50pt → 发帖前查点数
- 改帖 is_edit=1 复用表单，推测不额外耗冷却（需实测坐实）
- token 全时效 → preflight 实时导航拿新鲜 token

### 待补
- 删帖 RPA（勾选 checkbox → POST show_bbs_confirm_delete.html → 确认页「削除する」）— 与拉黑 5 步同构，ichigoBlockExpr.js selector 直接套，未写（总控未指定测试数据）
- 类型/足迹删除 RPA（同构）— 未写
- 冷却 1h 规则落 GovernanceRule — 未做
