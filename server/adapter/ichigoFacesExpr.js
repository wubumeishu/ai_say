// 出会 お相手探し（show_faces）会员列表抓取表达式（ichigoFacesExpr.js）· 模块5「主动出击引擎」
// 在 sp.194964.com 的 /sns/snssearch/show_faces.html（或共通点结果页 show_result_gallery.html）上下文执行。
// 设计：
//   * 优先读 window.memberIdList（48 个会员 ID 的逗号列表，页面级全局，最快最稳）
//   * 解析 #storedDisplay > div[id^=data_] 卡片的 data-* 属性（data-id/name/age/pref/city/certify/type）
//   * 不触发滑动手势、不点 thumb-overlay——纯静态抓取，零副作用
// 传参：第 1 参 = null（当前页）；第 2 参 = opts { sortBy, maxItems }
// 返回 Promise<{ ok, members[], count, page, fetchedAt, via }>
//   members[i] = { memberId, name, age, pref, city, certify, type, thumb, cardId }
(function(url, opts) {
  var O = opts || {};
  var doc = document;
  var out = { ok: false, members: [], via: 'faces-expr' };

  if (String(location.hostname || '').indexOf('194964.com') === -1) {
    out.reason = 'not-on-platform-domain';
    out.note = '需在 sp.194964.com 找对象页执行（当前 ' + location.hostname + '）';
    return Promise.resolve(out);
  }
  var onFaces = /show_faces|show_result_gallery/.test(String(location.pathname || ''));
  if (!onFaces) {
    out.reason = 'not-on-faces-page';
    out.note = '需在 /sns/snssearch/show_faces.html 或 /profile/leisuresearch/show_result_gallery.html 执行（当前 ' + location.pathname + '）';
    return Promise.resolve(out);
  }
  // 1) 全局 memberIdList（逗号列表）
  var ids = [];
  if (Array.isArray(window.memberIdList)) ids = window.memberIdList.slice();
  else if (typeof window.memberIdList === 'string' && window.memberIdList.length > 0) {
    ids = window.memberIdList.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  }
  out.memberIdListLen = ids.length;
  // 2) data-* 卡片（data_N 本身是空 div，真正图标在后续兄弟 .photo-item-new 里，按 index 对应）
  var cards = Array.prototype.slice.call(doc.querySelectorAll('#storedDisplay > div[id^=data_]'));
  var photoItems = Array.prototype.slice.call(doc.querySelectorAll('.photo-item-new'));
  var max = O.maxItems || cards.length;
  var members = [];
  cards.slice(0, Math.max(0, max)).forEach(function(el, idx) {
    // online-icon 可能在卡片内（若平台改结构），也可能在兄弟 .photo-item-new[idx] 里
    var _iconHost = el.querySelector('[class*=online-icon]');
    if (!_iconHost && photoItems[idx]) _iconHost = photoItems[idx].querySelector('[class*=online-icon]');
    var _faceIconCls = _iconHost ? String(_iconHost.className || '') : '';
    var _faceIconM = _faceIconCls.match(/online-icon(\d)/);
    var _faceLabelEl = el.querySelector('#online-label, .online-label');
    if (!_faceLabelEl && photoItems[idx]) _faceLabelEl = photoItems[idx].querySelector('#online-label, .online-label');
    members.push({
      cardId: el.id,
      memberId: el.getAttribute('data-id') || null,
      name: el.getAttribute('data-name') || '',
      age: el.getAttribute('data-age') || '',
      pref: el.getAttribute('data-pref') || '',
      city: el.getAttribute('data-city') || '',
      certify: el.getAttribute('data-certify') || '',
      type: el.getAttribute('data-type') || '',
      thumb: (el.getAttribute('data-thumbnail') || '').slice(0, 120),
      iconClass: _faceIconM ? 'online-icon' + _faceIconM[1] : (_iconHost ? 'online-icon' : null),
      onlineLabel: _faceLabelEl ? String(_faceLabelEl.textContent || '').trim() : ''
    });
  });
  // 3) 若 DOM 卡不足（如刚加载），用 memberIdList 补齐骨架
  if (members.length === 0 && ids.length > 0) {
    ids.forEach(function(mid, i) {
      members.push({ cardId: 'data_' + i, memberId: mid, name: '', age: '', pref: '', city: '', certify: '', type: '', thumb: '' });
    });
  }
  out.ok = true;
  out.members = members;
  out.count = members.length;
  out.page = String(location.pathname || '');
  out.fetchedAt = new Date().toISOString();
  if (members.length === 0) {
    out.reason = 'empty';
    out.note = '当前页无会员卡片（可能未加载完或无结果）';
  }
  return Promise.resolve(out);
})(__URL__, __FACES_OPTS__);
