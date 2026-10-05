(async function() {
  var url = __URL__;   // null = 用当前页面；字符串 = 页面内 fetch 该 URL
  function tierOf(el) {
    if (!el) return null;
    var c = String(el.className || '');
    if (/online-icon1/.test(c)) return 'online';
    if (/online-icon2/.test(c)) return 'recent';
    if (/online-icon3/.test(c)) return 'away';
    if (/online-icon4/.test(c)) return 'long';
    return null;
  }
  function qOf(href) {
    var m = String(href || '').match(/[?&]q=([^&#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  try {
    var doc;
    if (url) {
      var resp = await fetch(url, { credentials: 'include' });
      var html = await resp.text();
      doc = new DOMParser().parseFromString(html, 'text/html');
    } else {
      doc = document;
    }

    var rows = Array.from(doc.querySelectorAll('a[href*="show_history"]'));
    var out = [];
    rows.forEach(function(a) {
      var box = a.closest('.bgMiddle') || a.closest('li') || a.parentElement;
      if (!box) return;
      var timeEl = box.querySelector('.timeContribute');
      var timeTxt = timeEl ? timeEl.innerText.replace(/\s+/g, ' ').trim() : '';
      var nameEl = box.querySelector('.namelstProf');
      // innerText 在 DOMParser 文档里不可靠（<br> 不产生换行）→ 用 textContent + 正则
      var nameRaw = nameEl ? (nameEl.textContent || nameEl.innerText || '') : '';
      var flat = nameRaw.replace(/[\u2642\u2640]/g, '').replace(/[\s\u3000]+/g, ' ').trim();
      var ageM = flat.match(/(\d{1,2})歳/);
      var regM = flat.match(/(東京都|北海道|京都府|大阪府|.{2,3}県)/);
      // 名字 = "NN歳" 之前的部分；没有年龄则取第一个词
      var nameM = flat.match(/^(.+?)\s*\d{1,2}歳/);
      var name = (nameM ? nameM[1] : (flat.split(' ')[0] || '')).replace(/^[\u2642\u2640\s]+/, '').trim();
      var avatarEl = box.querySelector('.contentsImgContribute img');
      var avatarUrl = avatarEl ? (avatarEl.getAttribute('src') || '') : '';
      if (avatarUrl.indexOf('//') === 0) avatarUrl = 'https:' + avatarUrl;
      var avatarIsDefault = !avatarEl || /no_?image/.test(avatarUrl);
      var msgEl = box.querySelector('.textComment p') || box.querySelector('.textComment');
      var lastMsg = msgEl ? msgEl.innerText.trim().replace(/^[「」"]+|[「」"]+$/g, '') : '';
      var href = a.getAttribute('href') || '';
      out.push({
        contactId: qOf(href),
        historyUrl: a.href,
        name: name,
        age: ageM ? ageM[1] + '歳 ' + (regM ? regM[1] : '') : (regM ? regM[1] : ''),
        ageNum: ageM ? parseInt(ageM[1], 10) : null,
        region: regM ? regM[1] : '',
        lastMsg: lastMsg,
        lastMsgTime: timeTxt,
        onlineTier: tierOf(box.querySelector('.online-icon')),
        avatarUrl: avatarUrl,
        avatarIsDefault: avatarIsDefault
      });
    });

    // 分页器：所有页的 URL（用于抓第 2 页及以后）
    var pageUrls = [];
    var curPage = null;
    var pag = doc.querySelector('.navPaginator');
    if (pag) {
      Array.from(pag.querySelectorAll('li')).forEach(function(li) {
        var cls = String(li.className || '');
        var a = li.querySelector('a');
        var txt = (li.innerText || '').replace(/\s+/g, ' ').trim();
        if (/currentPage/.test(cls)) { curPage = txt; return; }
        if (a && a.href && /^\d+$/.test(txt)) pageUrls.push({ page: parseInt(txt, 10), url: a.href });
      });
    }
    return {
      contacts: out,
      pageUrls: pageUrls,
      currentPage: curPage ? parseInt(curPage, 10) : 1,
      href: url || location.href
    };
  } catch (e) {
    return { contacts: [], pageUrls: [], err: String(e && e.message || e) };
  }
})()
