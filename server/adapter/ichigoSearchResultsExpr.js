
'use strict';
// 出会 高级搜索 结果页 卡片抓取表达式（ichigoSearchResultsExpr.js）
// 在 exec_routing_profile_search.html 结果页上下文执行，抓当前页 .member-list / .search-list 卡片
// 返回 { ok, cards[], nextQuery, page, via }
(function(url, opts) {
  var doc = document;
  var out = { ok: false, cards: [], via: 'search-results-expr' };
  if (String(location.hostname || '').indexOf('194964.com') === -1) {
    out.reason = 'not-on-platform-domain';
    return Promise.resolve(out);
  }
  // 结果页卡片选择器（实测后调整）：.member-list-item / .search-list-item / .list-member
  var cards = Array.prototype.slice.call(doc.querySelectorAll('.member-list-item, .search-list-item, .list-member, .profile-list-item, .member-item'));
  if (cards.length === 0) {
    // 兜底：找任何含 .name + .age 的列表项
    cards = Array.prototype.slice.call(doc.querySelectorAll('li[class*=member], div[class*=member] li, .list li'));
  }
  var results = [];
  cards.forEach(function(el) {
    var f = { name: '', age: '', city: '', onlineIcon: null, avatarUrl: null, profileUrl: null, selfIntro: null };
    var nameEl = el.querySelector('.name, .member-name, [class*=name]');
    if (nameEl) f.name = (nameEl.textContent || '').trim().replace(/\s+/g, ' ');
    var ageEl = el.querySelector('.age, [class*=age]');
    if (ageEl) f.age = (ageEl.textContent || '').trim().replace(/\s+/g, ' ');
    var cityEl = el.querySelector('.city, [class*=city], [class*=area]');
    if (cityEl) f.city = (cityEl.textContent || '').trim().replace(/\s+/g, ' ');
    var onEl = el.querySelector('[class*=online]');
    if (onEl) {
      var m = String(onEl.className || '').match(/online-icon(\d)/);
      f.onlineIcon = m ? 'online-icon' + m[1] : 'online-icon';
    }
    var img = el.querySelector('img');
    if (img) f.avatarUrl = img.getAttribute('src') || null;
    var link = el.querySelector('a[href*=show_profile], a[href*=profile]');
    if (link) f.profileUrl = link.getAttribute('href') ? ('https://sp.194964.com' + link.getAttribute('href')) : null;
    var intro = el.querySelector('.intro, .desc, [class*=intro], [class*=desc]');
    if (intro) f.selfIntro = (intro.textContent || '').trim().replace(/\s+/g, ' ');
    if (f.name || f.age) results.push(f);
  });
  out.ok = true;
  out.cards = results;
  out.total = results.length;
  var nextA = doc.querySelector('.nextBtn a, a.next, .pagination a[href*=next]');
  out.nextQuery = nextA ? (nextA.getAttribute('href') || null) : null;
  out.page = String(location.pathname || '');
  out.fetchedAt = new Date().toISOString();
  if (results.length === 0) { out.reason = 'empty'; out.note = '结果页无卡片（可能 DOM 选择器需调整）'; }
  return Promise.resolve(out);
})(__URL__, null);
