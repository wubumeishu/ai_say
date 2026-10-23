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
