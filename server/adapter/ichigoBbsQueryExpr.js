// 出会 BBS 帖子查询表达式（ichigoBbsQueryExpr.js）· 模块3「查」
// 在 sp.194964.com 页面上下文执行（必须已登录，cookie 有效）。
// 设计：直接 POST /bbs/ajax_show_slider_list.html（平台前端点 genre tab 时调用的同一端点），
//       拿返回的 subject（HTML 片段）解析成结构化帖子数组。比导航抓 DOM 更稳、更快、不销毁 CDP 上下文。
// 传参：第 1 参 = 目标页 URL 或 null（当前页，需 sp.194964.com 域）
//       第 2 参 = opts 对象 { genre, page, count, prefId, hokkaidoFlag, board }
//         genre: 数字 genreId（ピュア 7 个 / 大人 9 个，缺省用页面默认）
//         board: 'pure' | 'adult'（决定 targetGenreId 的板块，缺省 pure）
// 返回 Promise<{ ok, posts[], total, page, genre, fetchedAt, via }>
//   posts[i] = { id, title, name, age, home, views, date, cat, photoCount, profileHref, detailHref }
//   解析失败 → ok:false + reason（不抛错，调用方转降级）
(function(url, opts) {
  var O = opts || {};
  var doc = document;
  var out = { ok: false, posts: [], via: 'bbs-ajax-query' };

  // 1. 找 #nav-tab 的 data-url（AJAX 端点，缺省 /bbs/ajax_show_slider_list.html）
  var navTab = doc.getElementById('nav-tab');
  var ajaxUrl = O.ajaxUrl || (navTab ? navTab.getAttribute('data-url') : '') || '/bbs/ajax_show_slider_list.html';
  if (String(location.hostname || '').indexOf('194964.com') === -1) {
    out.reason = 'not-on-platform-domain';
    out.note = '需在 sp.194964.com 页面上下文执行（当前 ' + location.hostname + '）';
    return Promise.resolve(out);
  }

  // 2. POST ajax 端点（credentials:include 带 cookie）
  var params = {
    count: String(O.count || 15),
    page: String(O.page || 1),
    prefId: String(O.prefId || 24),
    targetGenreId: String(O.genre || 5),
    hokkaidoFlag: String(O.hokkaidoFlag || 0)
  };
  var body = Object.keys(params).map(function(k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');

  return fetch(ajaxUrl, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body
  }).then(function(resp) {
    return resp.text().then(function(text) {
      out.httpStatus = resp.status;
      if (resp.status !== 200) { out.reason = 'http-' + resp.status; out.note = 'AJAX 端点返回 ' + resp.status; return out; }
      // 3. 解析返回（JSON，subject 字段是 HTML 片段；兼容直接返回 HTML）
      var subject = text;
      var json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      if (json && json.subject) subject = json.subject;
      // 解析失败（非 HTML / 登录态失效）
      if (String(subject || '').indexOf('recruit-list') === -1 && String(subject || '').length < 100) {
        out.reason = 'no-posts-in-response';
        out.note = 'AJAX 响应无帖子内容（可能登录态失效/参数错）';
        out.rawHead = String(subject || '').slice(0, 200);
        return out;
      }
      // 4. 用 DOMParser 解析 subject HTML 片段
      var parser = new DOMParser();
      var frag = parser.parseFromString('<div id="__bbs__">' + subject + '</div>', 'text/html');
      var cards = frag.querySelectorAll('#__bbs__ .recruit-list');
      var posts = [];
      cards.forEach(function(card) {
        var p = {};
        var nameEl = card.querySelector('.recruit-list-name');
        var ageEl = card.querySelector('.recruit-list-age');
        var homeEl = card.querySelector('.recruit-list-home');
        var viewEl = card.querySelector('.view');
        var dateEl = card.querySelector('.date');
        var catEl = card.querySelector('.cat-btn');
        var photoEl = card.querySelector('.recruit-list-photo');
        var linkEl = card.querySelector('a.recruit-list-txt, a[href*="show_bbs_detail"]');
        var imgEl = card.querySelector('.recruit-list-thumb a');
        p.title = nameEl ? String(nameEl.textContent || '').trim() : '';
        p.name = '';
        p.age = '';
        if (ageEl) {
          var ageText = String(ageEl.textContent || '').trim().replace(/\s+/g, ' ');
          var mm = ageText.match(/^(\S+)\s+(\d+)\s*歳/);
          if (mm) { p.name = mm[1]; p.age = mm[2]; }
          else { p.name = ageText; }
        }
        p.home = homeEl ? String(homeEl.textContent || '').trim().replace(/\s+/g, ' ') : '';
        p.views = viewEl ? String(viewEl.textContent || '').trim() : '';
        p.date = dateEl ? String(dateEl.textContent || '').trim() : '';
        p.cat = catEl ? String(catEl.textContent || '').trim() : '';
        p.photoCount = photoEl ? String(photoEl.textContent || '').trim().replace(/\s+/g, '') : '';
        p.detailHref = linkEl ? (linkEl.getAttribute('href') || '') : '';
        p.profileHref = imgEl ? (imgEl.getAttribute('href') || '') : '';
        if (p.profileHref && p.profileHref.charAt(0) === '/') p.profileHref = 'https://sp.194964.com' + p.profileHref;  // 补全域名(资料卡链接相对路径)
        if (p.detailHref && p.detailHref.charAt(0) === '/') p.detailHref = 'https://sp.194964.com' + p.detailHref;
        // 头像(.recruit-list-thumb img, //images.194964.com 相对协议 → https)
        var thumbImg = (card && card.querySelector) ? card.querySelector('.recruit-list-thumb img') : null;
        if (thumbImg) { var _av = thumbImg.getAttribute('src') || ''; if (_av.indexOf('//') === 0) _av = 'https:' + _av; p.avatarUrl = _av; }
        // 在线点颜色(.recruit-list-age 内 .online-iconN 的 N 档)
        var onEl = (ageEl && ageEl.querySelector) ? ageEl.querySelector('.online-icon') : null;
        if (onEl) { var onM = String(onEl.className || '').match(/online-icon(\d)/); if (onM) p.onlineIcon = onM[1]; }
        p.hasPhoto = p.photoCount.indexOf('x') !== -1 || p.photoCount.indexOf('枚') !== -1;
        posts.push(p);
      });
      out.ok = true;
      out.posts = posts;
      out.total = posts.length;
      out.page = O.page || 1;
      out.genre = O.genre || 5;
      out.board = O.board || 'pure';
      out.fetchedAt = new Date().toISOString();
      if (posts.length === 0) { out.reason = 'empty'; out.note = '该 genre 当前无帖子（或登录态失效）'; }
      return out;
    });
  }).catch(function(e) {
    out.reason = 'fetch-error';
    out.note = String(e && e.message || e);
    return out;
  });
})(__URL__, __BBS_OPTS__);
