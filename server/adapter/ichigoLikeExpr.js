'use strict';
// 出会 タイプ（P2 点赞待回）候选抓取表达式 v5（ichigoLikeExpr.js）· 外部翻页
// 抓 3 个独立 Tab 页当前页数据；翻页由 deepScrape 外部循环驱动（每页重新 navigate 平台生成 token URL，token 永不自拼）：
//   /sns/snstype/show_typed_list.html   タイプされた（别人给我点赞，P2 待回）
//   /sns/snstype/show_type_list.html   タイプした（我给别人的，回赞判断）
//   /sns/snstype/show_mutual_list.html 両想い（互相点赞，最高价值）
// 设计（v5 · 2026-11-01 按实机 DOM 重写）：
//   * 只读抓当前页 .type--list 卡片（不点资料卡、零副作用）
//   * 卡片 DOM 真实结构（实机坐实）：
//       .type-list-check input[name="targetSnsMemberId[]"]  → memberId
//       .type-list-footstep .type-list-date                 → 点赞时间
//       .type-list-img .type-list-thumb img                 → 头像 src
//       .type-list-txt .type-list-name                      → 名字（+ new 标识 icon_new_2.png）
//       .type-list-txt .type-list-age span                  → 在线图标 + 「19歳/桑名市」
//       .type-list-txt .type-list-desc .desc-txt            → 自我介绍（部分卡片有）
//       a.type-list-link                                      → 资料卡链接（?q= token）
//   * 返回 nextQuery = .nextBtn a 的 href（相对 ?q= token，平台生成）→ deepScrape 拼全 URL navigate
//   * 返回 prevQuery = .prevBtn a 的 href（供回退/确认非首页）
// 传参：第 1 参 = null；第 2 参 = opts { tab }
// 返回 Promise<{ ok, likes[], total, tab, nextQuery, prevQuery, via }>
(function(url, opts) {
  var O = opts || {};
  var doc = document;
  var out = { ok: false, likes: [], via: 'like-expr' };

  if (String(location.hostname || '').indexOf('194964.com') === -1) {
    out.reason = 'not-on-platform-domain';
    return Promise.resolve(out);
  }
  var path = String(location.pathname || '');
  var tab = 'unknown';
  if (path.indexOf('show_typed_list') !== -1) tab = 'received';
  else if (path.indexOf('show_type_list') !== -1) tab = 'sent';
  else if (path.indexOf('show_mutual_list') !== -1) tab = 'mutual';
  out.tab = tab;

  var cards = Array.prototype.slice.call(doc.querySelectorAll('.type--list'));
  var likes = [];
  cards.forEach(function(el) {
    var f = {
      tab: tab,
      memberId: null,
      name: '',
      age: '',
      city: '',
      onlineIcon: null,
      avatarUrl: null,
      profileUrl: null,
      selfIntro: null,
      isNew: false,
      time: '',
      source: tab === 'mutual' ? '両想い' : (tab === 'received' ? 'タイプされた' : 'タイプした')
    };

    // 1) memberId
    var cb = el.querySelector('input[name="targetSnsMemberId[]"]');
    if (cb) f.memberId = cb.value || null;

    // 2) 头像 src（.type-list-thumb img）
    var thumbImg = el.querySelector('.type-list-thumb img');
    if (thumbImg) {
      var src = thumbImg.getAttribute('src') || '';
      f.avatarUrl = src ? ('https:' + src.replace(/^https?:\/\//, '')) : null;
    }

    // 3) 名字（.type-list-name 文本，去掉 new 图标）+ isNew 标识
    var nameEl = el.querySelector('.type-list-name');
    if (nameEl) {
      // 名字文本 = 去掉 img 后的文本
      var txt = (nameEl.textContent || '').replace(/\s+/g, ' ').trim();
      f.name = txt || '';
      var newIcon = nameEl.querySelector('img[src*="icon_new"], img[src*="new"]');
      f.isNew = !!newIcon;
    }

    // 4) 年龄/地区 + 在线图标（.type-list-age）
    var ageBlock = el.querySelector('.type-list-age');
    if (ageBlock) {
      var onSpan = ageBlock.querySelector('.online-icon');
      if (onSpan) {
        var m = String(onSpan.className || '').match(/online-icon(\d)/);
        f.onlineIcon = m ? 'online-icon' + m[1] : 'online-icon';
      }
      // 「19歳/桑名市」或「54歳/愛知」
      var ageTxt = (ageBlock.textContent || '').replace(/\s+/g, ' ').trim();
      var am = ageTxt.match(/(\d+)歳\s*\/?\s*([^\s]+)?/);
      if (am) {
        f.age = am[1];
        f.city = am[2] || '';
      }
    }

    // 5) 自我介绍（.type-list-desc .desc-txt，部分卡片有）
    var descEl = el.querySelector('.type-list-desc .desc-txt, .type-list-desc span');
    if (descEl) {
      var dtxt = (descEl.textContent || '').trim();
      if (dtxt) f.selfIntro = dtxt;
    }

    // 6) 资料卡链接（a.type-list-link href → 全 URL）
    var linkEl = el.querySelector('a.type-list-link');
    if (linkEl) {
      var href = linkEl.getAttribute('href') || '';
      if (href) f.profileUrl = (href.indexOf('http') === 0 ? href : ('https://sp.194964.com' + href));
    }

    // 7) 点赞时间（.type-list-footstep .type-list-date）
    var dateEl = el.querySelector('.type-list-footstep .type-list-date, .type-list-footstep');
    if (dateEl) {
      f.time = (dateEl.textContent || '').trim().replace(/\s+/g, ' ');
    }

    likes.push(f);
  });

  // 翻页 token（平台生成的相对 ?q= href；不自己拼 token）
  var nextA = doc.querySelector('.nextBtn a');
  out.nextQuery = nextA ? nextA.getAttribute('href') || null : null;
  var prevA = doc.querySelector('.prevBtn a');
  out.prevQuery = prevA ? prevA.getAttribute('href') || null : null;

  out.ok = true;
  out.likes = likes;
  out.total = likes.length;
  out.page = path;
  out.fetchedAt = new Date().toISOString();
  if (likes.length === 0) { out.reason = 'empty'; out.note = '当前 ' + tab + ' tab 本页无数据'; }
  return Promise.resolve(out);
})(__URL__, __LIKE_OPTS__);
