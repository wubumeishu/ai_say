(function() {
  var contacts = Array.from(document.querySelectorAll('a[href*="show_history"]')).map(function(a) {
    var row = a.closest('li') || a.closest('div');
    while (row && row.querySelectorAll('a[href*="show_history"]').length !== 1) row = row.parentElement;
    var txt = (row ? row.innerText : (a.innerText || '')).trim().replace(/\n+/g, ' | ').slice(0, 200);
    var on = row ? row.querySelector('.online-icon') : null;
    var tier = null;
    if (on) {
      var cls = String(on.className || '');
      if (/online-icon1/.test(cls)) tier = 'online';
      else if (/online-icon2/.test(cls)) tier = 'recent';
      else if (/online-icon3/.test(cls)) tier = 'away';
      else if (/online-icon4/.test(cls)) tier = 'long';
    }
    var img = row ? row.querySelector('img[src*="snsprofr"], .mainProfShadow img, [class*="profile-img"] img, [class*="head-img"] img') : null;
    var avatar = img && img.src ? img.src : '';
    var avatarIsDefault = !img || /icon_noimage_/.test(img.src || '');
    return { raw: txt, link: a.href, onlineTier: tier, avatarUrl: avatar, avatarIsDefault: avatarIsDefault };
  });
  var nav = Array.from(document.querySelectorAll('div.bottom-nav-item')).map(function(div) {
    var c = div.querySelector('span.caution');
    var l = div.querySelector('a.bottom-nav-item-txt');
    return { label: l ? l.innerText.trim() : '', badge: c ? c.innerText.trim() : '', href: l ? l.getAttribute('href') : '' };
  });
  var pag = document.querySelector('.navPaginator');
  var pages = pag ? Array.from(pag.querySelectorAll('a,li')).map(function(e) {
    var isCur = e.className && /currentPage/.test(e.className);
    var a = e.querySelector('a') || e;
    return { text: (e.innerText || '').trim(), isCurrent: isCur, href: a.href || (a.getAttribute && a.getAttribute('href')) || '' };
  }).filter(function(x) { return x.text; }) : [];
  return { contacts: contacts, nav: nav, pages: pages };
})()
