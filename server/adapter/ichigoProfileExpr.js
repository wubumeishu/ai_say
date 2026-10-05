(function() {
  var o = { url: location.href, title: document.title, raw: (document.body && document.body.innerText || '').slice(0, 4000) };
  o.interestIcons = Array.from(document.querySelectorAll('.interest-item img.affinity_img_icon, .interest-item img[src*="leisure/category"], .interest-item img[src*="affinity"]')).map(function(img) {
    var src = img.src || '';
    var m = src.match(/leisure\/category\/(\d+)|(birthCity_\d+)/);
    return m ? m[1] : null;
  }).filter(Boolean);
  var head = document.querySelector('[class*="profile-img"] img, [class*="head-img"] img, .mainProfShadow img, .namelstProf img, img[src*="snsprofr"]');
  o.avatarUrl = head && head.src ? head.src : '';
  o.avatarIsDefault = !head || /icon_noimage_/.test(head.src || '');
  var onIcon = document.querySelector('.online-icon');
  o.onlineTier = null;
  if (onIcon) {
    var cls = String(onIcon.className || '');
    if (/online-icon1/.test(cls)) o.onlineTier = 'online';
    else if (/online-icon2/.test(cls)) o.onlineTier = 'recent';
    else if (/online-icon3/.test(cls)) o.onlineTier = 'away';
    else if (/online-icon4/.test(cls)) o.onlineTier = 'long';
  }
  o.bbsPosts = Array.from(document.querySelectorAll('.bbs-item')).map(function(it) {
    var a = it.querySelector('a');
    var genre = it.querySelector('.btn-genre');
    var view = it.querySelector('.view');
    var time = it.querySelector('.time');
    var pref = it.querySelector('.pref');
    var city = it.querySelector('.city');
    var txt = it.querySelector('.txt');
    return { link: a ? a.href : null, genre: genre ? genre.innerText.trim() : '', viewCount: view ? view.innerText.trim() : '', time: time ? time.innerText.trim() : '', region: ((pref && pref.innerText.trim()) + ' ' + (city && city.innerText.trim())).trim(), content: txt ? txt.innerText.trim() : '' };
  });
  return o;
})()
