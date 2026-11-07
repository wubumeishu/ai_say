(function() {
  // happymail.co.jp 快乐 · 客源 profile_list.php（检索客源）v2 实机 DOM 重写（2026-11-06）
  // 卡片真实结构（实测坐实）：.ds_user_post_link_item_r（10 张/页）
  //   名字   = .ds_like_list_name（.container_right 下）
  //   时间   = .ds_like_list_date_last_login_list
  //   年龄+市 = .ds_like_list_age（如「40代前半 旭川市」→ 拆 age/city）
  //   详情   = .ds_post_body / .ds_profile_list_text（职业/收入/身高/风格/简介）
  //   头像   = .ds_thum_contain（svgz_icon = 默认头像）
  //   在线点 = .last_login_icon_detail_small_list / _picture_big（background-color 绿/黄/灰）
  var cards = Array.prototype.slice.call(document.querySelectorAll('.ds_user_post_link_item_r'));
  var items = cards.map(function(li) {
    var name = li.querySelector('.ds_like_list_name, .member_name, .ds_post_body_name_small');
    var date = li.querySelector('.ds_like_list_date_last_login_list, .ds_like_list_date_last_login_list');
    var ageEl = li.querySelector('.ds_like_list_age, .ds_post_body_age_small');
    var ageText = ageEl ? ageEl.innerText.trim() : '';
    var mAge = ageText.match(/^(\d+[代〜ー-]?(?:前半|半ば|後半)?\s*)/);
    var age = mAge ? mAge[1].trim() : '';
    var city = ageText.replace(age, '').trim();
    // 详情行: .ds_post_body_common_item / .ds_profile_list_text 内的文本
    var detailRows = Array.prototype.slice.call(li.querySelectorAll('.ds_post_body_common_item, .ds_profile_list_text, .common_list_item'))
      .map(function(el) { return el.innerText.trim(); }).filter(Boolean).join(' / ').slice(0, 300);
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
    return {
      name: name ? name.innerText.trim() : '',
      age: age,
      region: city,
      avatarUrl: avatarIsDefault ? '' : avatarUrl,
      avatarIsDefault: avatarIsDefault,
      onlineDot: onlineDot,
      sex: li.querySelector('.text-male') ? 'male' : (li.querySelector('.text-female') ? 'female' : ''),
      likeTime: date ? date.innerText.trim() : '',
      detail: detailRows,
      raw: li.innerText.trim().replace(/\n+/g, ' | ').slice(0, 300)
    };
  }).filter(function(x) { return x.name && !/すべてを選択|検索条件/.test(x.raw); });

  return {
    items: items,
    count: items.length,
    postRef: { url: '/sp/app/api/html/list_profile_gallery.php', note: '检索客源, all_count 1002' }
  };
})()