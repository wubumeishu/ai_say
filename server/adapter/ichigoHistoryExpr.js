(async function() {
  var url = __URL__;
  function clean(s) {
    return String(s || '').replace(/\r/g, '').replace(/[ \t\u3000]+/g, ' ').replace(/\n{2,}/g, '\n').replace(/^\s+|\s+$/g, '');
  }
  function timeOf(el) {
    if (!el) return { time: '', read: false };
    var t = el.innerText || '';
    var read = /既読/.test(t);
    var m = t.match(/(\d{1,2}):(\d{2})/);
    return { time: m ? (m[1].length < 2 ? '0' + m[1] : m[1]) + ':' + m[2] : '', read: read };
  }
  function dateOf(el) {
    if (!el) return '';
    var m = String(el.innerText || '').match(/(\d{1,2})\/(\d{1,2})/);
    if (!m) return '';
    return (m[1].length < 2 ? '0' + m[1] : m[1]) + '/' + (m[2].length < 2 ? '0' + m[2] : m[2]);
  }
  try {
    var resp = await fetch(url, { credentials: 'include' });
    var html = await resp.text();
    var doc = new DOMParser().parseFromString(html, 'text/html');

    var msgs = [];
    var curDate = '';
    // 按文档顺序遍历：日期分隔符 + 消息块
    var nodes = doc.querySelectorAll('.txtDateBoxChat, .blockChatOther, .blockChatOwner');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var cls = String(el.className || '');
      if (/txtDateBoxChat/.test(cls)) { curDate = dateOf(el); continue; }

      var isOther = /blockChatOther/.test(cls);
      var bubble = el.querySelector('.bubble_other, .bubble_owner, .bubble');
      if (!bubble) continue;

      // 引用块（★元の書き込み）单独取出，正文里剔除
      var quote = '';
      var spaceEl = bubble.querySelector('.space');
      if (spaceEl) { quote = clean(spaceEl.innerText); }

      var body;
      if (spaceEl) {
        var clone = bubble.cloneNode(true);
        var cs = clone.querySelector('.space');
        if (cs && cs.parentNode) cs.parentNode.removeChild(cs);
        body = clean(clone.innerText);
      } else {
        body = clean(bubble.innerText);
      }
      if (!body && !quote) continue;

      var tm = timeOf(el.querySelector('.boxTimeChatOther, .boxTimeChatOwner, [class*="boxTimeChat"]'));
      var nameEl = el.querySelector('.tName');
      msgs.push({
        from: isOther ? 'peer' : 'self',
        text: body,
        quote: quote || null,
        time: (curDate ? curDate + ' ' : '') + tm.time,
        read: isOther ? true : tm.read,
        name: nameEl ? clean(nameEl.innerText) : '',
        messageId: el.getAttribute('data-messageid') || null
      });
    }

    // 头像 + profile 链接
    var av = doc.querySelector('.boxAvatarOther img, .faceImg img');
    var avatarUrl = av ? (av.getAttribute('src') || '') : '';
    if (avatarUrl && avatarUrl.indexOf('//') === 0) avatarUrl = 'https:' + avatarUrl;
    var prof = doc.querySelector('a[href*="show_profile"]');
    var headName = '';
    var hn = doc.querySelector('.tName');
    if (hn) headName = clean(hn.innerText);

    return {
      ok: true, url: url, count: msgs.length, messages: msgs,
      avatarUrl: avatarUrl, avatarIsDefault: !av || /no_?image/.test(avatarUrl),
      profileUrl: prof ? prof.href : null,
      headName: headName, htmlLen: html.length
    };
  } catch (e) {
    return { ok: false, url: url, err: String(e && e.message || e) };
  }
})()
