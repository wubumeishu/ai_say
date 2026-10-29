'use strict';
// 出会 タイプ（P2 点赞待回）候选抓取表达式 v4（ichigoLikeExpr.js）· 外部翻页
// 抓 3 个独立 Tab 页当前页数据；翻页由 deepScrape 外部循环驱动（每页重新 navigate 平台生成 token URL，token 永不自拼）：
//   /sns/snstype/show_typed_list.html   タイプされた（别人给我点赞，P2 待回）
//   /sns/snstype/show_type_list.html   タイプした（我给别人的，回赞判断）
//   /sns/snstype/show_mutual_list.html 両想い（互相点赞，最高价值）
// 设计：
//   * 只读抓当前页 .type--list 卡片（targetSnsMemberId[] + 在线图标 + 昵称/年龄/城市/时间）
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
    var f = { tab: tab, memberId: null, name: '', age: '', city: '', source: tab === 'mutual' ? '両想い' : (tab === 'received' ? 'タイプされた' : 'タイプした'), time: '', onlineIcon: null };
    var cb = el.querySelector('input[name="targetSnsMemberId[]"]');
    if (cb) f.memberId = cb.value || null;
    var step = el.querySelector('.type-list-footstep');
    if (step) f.time = (step.textContent || '').trim().replace(/\s+/g, ' ');
    var on = el.querySelector('[class*=online-icon]');
    if (on) {
      var m = String(on.className || '').match(/online-icon(\d)/);
      f.onlineIcon = m ? 'online-icon' + m[1] : 'online-icon';
    }
    var txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
    var nameM = txt.match(/\d{1,2}\/\d{1,2}\s*\d{1,2}:\d{2}\s*([^\d/\u5c4a]+?)\s*(\d+)\u5c4a/);
    if (nameM) { f.name = nameM[1].trim(); f.age = nameM[2]; }
    var cityM = txt.match(/\d+\u5c4a\/([\u4e00-\u9fff\u3042-\u309c\u30a2-\u30f6]+)/);
    if (cityM) f.city = cityM[1];
    var timeM = txt.match(/(\d{1,2}\/\d{1,2}\s*\d{1,2}:\d{2})/);
    if (timeM) f.time = timeM[1];
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