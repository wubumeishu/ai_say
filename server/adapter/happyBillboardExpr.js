(function() {
  // happymail.co.jp 快乐 · 客源 keijiban.php（募集/掲示板）v2 实机 DOM 重写（2026-11-06）
  // 卡片真实结构（实测坐实）：.ds_user_post_link_item_bill
  //   帖子标题 = .ds_post_title
  //   发帖时间 = .ds_post_date
  //   发帖人   = .ds_post_body_name_bill
  //   年龄+市  = .ds_post_body_age（如「30代後半 札幌市中央区」→ 拆 age/city）
  //   阅读数   = .billboard_read
  //   头像     = .ds_thum_contain
  var cards = Array.prototype.slice.call(document.querySelectorAll('.ds_user_post_link_item_bill, .ds_user_post_link_bill'));
  var items = cards.map(function(li) {
    var name = li.querySelector('.ds_post_body_name_bill, .member_name, .ds_like_list_name');
    var title = li.querySelector('.ds_post_title');
    var date = li.querySelector('.ds_post_date, .ds_like_list_date_last_login_list');
    var ageEl = li.querySelector('.ds_post_body_age, .ds_like_list_age');
    var ageText = ageEl ? ageEl.innerText.trim() : '';
    var mAge = ageText.match(/^(\d+[代〜ー-]?(?:前半|半ば|後半)?\s*)/);
    var age = mAge ? mAge[1].trim() : '';
    var city = ageText.replace(age, '').trim();
    var readsEl = li.querySelector('.billboard_read, .ds_post_viewNo');
    var reads = readsEl ? readsEl.innerText.trim() : '';
    var thumb = li.querySelector('.ds_thum_contain img, img');
    var thumbBg = li.querySelector('.ds_thum_contain');
    var bg = thumbBg ? (String(thumbBg.style.backgroundImage || '').replace(/url\(['"]?/,'').replace(/['"]?\)/,'')) : '';
    var avatarUrl = (thumb && thumb.src) ? thumb.src : bg;
    var avatarIsDefault = !avatarUrl || /noimage_|\.svg|svgz_icon/i.test(avatarUrl);
    var dot = li.querySelector('.last_login_icon_detail_small_list, .last_login_icon_detail_picture_big, [class*=last_login_icon]');
    var onlineDot = null;
    if (dot) {
      var rawBg = (dot.getAttribute('style') || '');
      var mBg = rawBg.match(/background-color:\s*(#[0-9a-fA-F]{3,8}|\w+)/);
      var bgHex = mBg ? mBg[1].trim() : '';
      if (bgHex) onlineDot = /2AB788/i.test(bgHex) ? 'green' : (/F3B117/i.test(bgHex) ? 'yellow' : (/D3D3D3/i.test(bgHex) ? 'gray' : bgHex.toLowerCase()));
    }
    var detailRows = Array.prototype.slice.call(li.querySelectorAll('.ds_like_list_item, .ds_profile_list_text, .common_list_item'))
      .map(function(el) { return el.innerText.trim(); }).filter(Boolean).join(' / ').slice(0, 300);
    return {
      name: name ? name.innerText.trim() : '',
      subject: title ? title.innerText.trim() : '',
      writeDate: date ? date.innerText.trim() : '',
      reads: reads,
      age: age,
      region: city,
      avatarUrl: avatarIsDefault ? '' : avatarUrl,
      avatarIsDefault: avatarIsDefault,
      onlineDot: onlineDot,
      detail: detailRows,
      raw: li.innerText.trim().replace(/\n+/g, ' | ').slice(0, 300)
    };
  }).filter(function(x) { return x.name || x.subject; });

  return {
    items: items,
    count: items.length,
    postRef: { url: '/sp/app/api/html/list_billboard.php', note: '募集帖, 按 genre tab 分组' }
  };
})()