'use strict';
// 出会 正在聊（P1 最高优先级）候选抓取表达式（ichigoChatExpr.js）
// 在 sp.194964.com 的 /mail/inbox/show_mailbox.html（收件箱）上下文执行。
// 设计：
//   * 抓 a[href*="show_history"] 会话卡（收件箱列表项）
//   * 每卡：昵称（raw 文本解析）+ 在线图标 online-icon1~4 + 未读标记
//   * 只读，不点、不发消息
// 传参：第 1 参 = null（当前页）；第 2 参 = opts { maxItems }
// 返回 Promise<{ ok, chats[], unreadCount, via }>
(function(url, opts) {
  var O = opts || {};
  var doc = document;
  var out = { ok: false, chats: [], via: 'chat-expr' };

  if (String(location.hostname || '').indexOf('194964.com') === -1) {
    out.reason = 'not-on-platform-domain';
    out.note = '需在 sp.194964.com 收件箱页执行（当前 ' + location.hostname + '）';
    return Promise.resolve(out);
  }
  if (String(location.pathname || '').indexOf('show_mailbox') === -1) {
    out.reason = 'not-on-inbox-page';
    out.note = '需在 /mail/inbox/show_mailbox.html 执行（当前 ' + location.pathname + '）';
    return Promise.resolve(out);
  }

  var anchors = Array.prototype.slice.call(doc.querySelectorAll('a[href*="show_history"]'));
  var max = O.maxItems || anchors.length;
  var chats = [];
  anchors.slice(0, Math.max(0, max)).forEach(function(a) {
    var row = a.closest('li') || a.closest('div');
    while (row && row.querySelectorAll('a[href*="show_history"]').length !== 1) row = row.parentElement;
    var txt = (row ? row.innerText : (a.innerText || '')).trim().replace(/\n+/g, ' | ');
    var on = row ? row.querySelector('[class*=online-icon]') : null;
    var m = on ? String(on.className || '').match(/online-icon(\d)/) : null;
    var un = row ? row.querySelector('[class*=unread], [class*=unRead], .caution, [class*=red-badge], [class*=red]') : null;
    var c = {
      name: '', age: '', city: '', source: 'メッセージ', lastMsg: '', lastTime: '',
      onlineIcon: m ? 'online-icon' + m[1] : null,
      hasUnread: !!un,
      raw: txt.slice(0, 160),
      link: a.getAttribute('href') || ''
    };
    var parts = txt.split(' | ').map(function(s){ return s.trim(); });
    var namePart = null, ageCityPart = null;
    parts.forEach(function(p) {
      if (/^[\u2642\u2643]/.test(p)) namePart = p;
      else if (p.indexOf('\u5c4a') !== -1 && p.length < 20) ageCityPart = p;
    });
    var lastMsg = null, lastTime = null;
    parts.forEach(function(p) { var mm = p.match(/\u300c[^\u300d]+\u300d/); if (mm && mm[0].length > 4) lastMsg = mm[0].replace(/\u300c/g,'').replace(/\u300d/g,'').trim(); var tm = p.match(/(\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2})/); if (tm) lastTime = tm[1]; });
    if (namePart) c.name = namePart.replace(/^[\u2642\u2643]\s*/, '');
    if (ageCityPart) {
      var am = ageCityPart.match(/(\d+)\u5c4a\s*([\u4e00-\u9fff\u3042-\u309c\u30a2-\u30f6]*)/);
      if (am) { c.age = am[1]; c.city = am[2] || ''; }
      else c.age = ageCityPart;
    }    if (lastMsg) c.lastMsg = lastMsg;
    if (lastTime) c.lastTime = lastTime;
    var rawMC = txt.match(/(\d+)\u5c4a\s*([\u4e00-\u9fff]{1,8})/);
    if (rawMC) { if (!c.age) c.age = rawMC[1]; if (!c.city) c.city = rawMC[2]; }

    chats.push(c);
  });

  out.ok = true;
  out.chats = chats;
  out.total = chats.length;
  out.unreadCount = chats.filter(function(c){ return c.hasUnread; }).length;
  out.page = String(location.pathname || '');
  out.fetchedAt = new Date().toISOString();
  if (chats.length === 0) {
    out.reason = 'empty';
    out.note = '当前收件箱无会话条目（可能无人给你发过消息或登录态失效）';
  }
  return Promise.resolve(out);
})(__URL__, __CHAT_OPTS__);