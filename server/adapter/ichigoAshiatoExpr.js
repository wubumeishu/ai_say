'use strict';
// 出会 足迹（あしあと）列表抓取表达式 v3（ichigoAshiatoExpr.js）· 模块4「流量雷达」
// 在 sp.194964.com 的 /sns/snsashiato/show.html（别人看我）或 show_mine.html（我看别人）执行。
// 设计：只读抓当前页 .type--list 卡片 + 返回 nextTokenHref（供 deepScrape 外部翻页）
// 传参：第 1 参 = null；第 2 参 = opts { maxItems, direction }
// 返回 Promise<{ ok, footmarks[], total, direction, nextQuery, prevQuery, via }>
(function(url, opts) {
  var O = opts || {};
  var doc = document;
  var out = { ok: false, footmarks: [], via: 'ashiato-expr' };

  if (String(location.hostname || '').indexOf('194964.com') === -1) {
    out.reason = 'not-on-platform-domain';
    out.note = '需在 sp.194964.com 足迹页执行（当前 ' + location.hostname + '）';
    return Promise.resolve(out);
  }
  var path = String(location.pathname || '');
  if (path.indexOf('snsashiato') === -1) {
    out.reason = 'not-on-ashiato-page';
    out.note = '需在 /sns/snsashiato/show.html 或 show_mine.html 执行（当前 ' + path + '）';
    return Promise.resolve(out);
  }
  out.direction = path.indexOf('show_mine') !== -1 ? 'mine' : 'received';

  var cards = Array.prototype.slice.call(doc.querySelectorAll('.type--list'));
  var footmarks = [];
  cards.forEach(function(card) {
    var f = { footmarkId: null, name: '', age: '', city: '', source: '', time: '', onlineIcon: null, profileHref: '', avatarUrl: '', desc: '' };
    var cb = card.querySelector('input[type=checkbox][name="targetFootmarkId[]"]');
    if (cb) f.footmarkId = cb.getAttribute('value') || null;
    var nameEl = card.querySelector('.type-list-name');
    if (nameEl) f.name = String(nameEl.textContent || '').trim();
    var ageEl = card.querySelector('.type-list-age');
    if (ageEl) {
      var t = String(ageEl.textContent || '').trim().replace(/\s+/g, ' ');
      var m = t.match(/(\d+)\u5c4a\s*\/(\s*([^\s]+))?/);
      if (m) { f.age = m[1]; f.city = (m[3] || '').trim(); }
      else f.age = t;
    }
    var stepEl = card.querySelector('.type-list-footstep');
    if (stepEl) {
      var st = String(stepEl.textContent || '').trim().replace(/\s+/g, ' ');
      var tm = st.match(/(\d{1,2}\/\d{1,2}\s*\d{1,2}:\d{2})\s*$/);
      if (tm) { f.time = tm[1]; f.source = st.slice(0, st.lastIndexOf(tm[1])).trim(); }
      else f.source = st;
    }
    var onEl = card.querySelector('[class*=online-icon]');
    if (onEl) {
      var om = String(onEl.className || '').match(/online-icon(\d)/);
      f.onlineIcon = om ? 'online-icon' + om[1] : 'online-icon';
    }
    var linkEl = card.querySelector('a.type-list-link') || card.querySelector('a[href*="show_profile"]');
    if (linkEl) {
        var _ph = linkEl.getAttribute('href') || '';
        if (_ph.charAt(0) === '/') _ph = 'https://sp.194964.com' + _ph;  // 补全域名(资料卡链接为相对路径)
        f.profileHref = _ph;
      }
      // 自我介绍(.type-list-desc .desc-txt)
      var _desc = card.querySelector('.type-list-desc .desc-txt') || card.querySelector('.type-list-desc');
      if (_desc) f.desc = clean(_desc.innerText);
      // 头像(.type-list-thumb img, //images.194964.com 相对协议 → 补 https)
      var _img = card.querySelector('.type-list-thumb img') || card.querySelector('.type-list-img img');
      if (_img) {
        var _av = _img.getAttribute('src') || '';
        if (_av.indexOf('//') === 0) _av = 'https:' + _av;
        f.avatarUrl = _av;
      }
    footmarks.push(f);
  });

  var nextA = doc.querySelector('.nextBtn a');
  out.nextQuery = nextA ? nextA.getAttribute('href') || null : null;
  var prevA = doc.querySelector('.prevBtn a');
  out.prevQuery = prevA ? prevA.getAttribute('href') || null : null;

  out.ok = true;
  out.footmarks = footmarks;
  out.total = footmarks.length;
  out.page = path;
  out.fetchedAt = new Date().toISOString();
  if (footmarks.length === 0) { out.reason = 'empty'; out.note = '当前足迹页本页无条目'; }
  return Promise.resolve(out);
})(__URL__, __ASHIATO_OPTS__);