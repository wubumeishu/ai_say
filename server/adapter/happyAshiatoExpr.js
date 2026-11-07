(function() {
  // happymail.co.jp 快乐 · 客源 ashiato.php（足迹=主动浏览过我的人）v2 实机 DOM 重写（2026-11-06）
  // 卡片真实结构（实测坐实）：li/.ds_user_post_link_item_r
  //   名字   = .ds_like_list_name（.container_right 下）
  //   时间   = .ds_like_list_date_last_login_list（足迹时间 MM/DD HH:MM）
  //   年龄+市 = .ds_like_list_age（如「50代半ば 札幌市」→ 拆 age/city）
  //   详情   = .common_list_item（职业/收入/身高/风格）+ 简介
  //   头像   = .ds_thum_contain（svgz_icon = 默认头像）
  //   在线点 = .last_login_icon_detail_small_list / .last_login_icon_detail_picture_big（background-color 绿/黄/灰）
  // 顶部 2 张 .ds_like_list_item = 汇总（今日の足あと N 人 / 足あとトータル N 人）+ 全选行, 需排除
  var cards = Array.prototype.slice.call(document.querySelectorAll('.ds_user_post_link_item_r, li.ds_user_post_link_item_r'));
  var items = cards.map(function(li) {
    var name = li.querySelector('.ds_like_list_name, .member_name, .nickname');
    var date = li.querySelector('.ds_like_list_date_last_login_list');
    var ageEl = li.querySelector('.ds_like_list_age');
    var ageText = ageEl ? ageEl.innerText.trim() : '';
    var mAge = ageText.match(/^(\d+[代〜ー-]?(?:前半|半ば|後半)?\s*)/);
    var age = mAge ? mAge[1].trim() : '';
    var city = ageText.replace(age, '').trim();
    var detailRows = Array.prototype.slice.call(li.querySelectorAll('.common_list_item, .ds_profile_list_text_head .common_list_item'))
      .map(function(el) { return el.innerText.trim(); }).filter(Boolean).join(' / ').slice(0, 300);
    var thumb = li.querySelector('.ds_thum_contain img, img');
    var thumbBg = li.querySelector('.ds_thum_contain');
    var bg = thumbBg ? (String(thumbBg.style.backgroundImage || '').replace(/url\(['"]?/,'').replace(/['"]?\)/,'')) : '';
    var avatarUrl = (thumb && thumb.src) ? thumb.src : bg;
    var avatarIsDefault = !avatarUrl || /noimage_|\.svg|svgz_icon/i.test(avatarUrl);
    // 在线点色
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
      footTime: date ? date.innerText.trim() : '',
      avatarUrl: avatarIsDefault ? '' : avatarUrl,
      avatarIsDefault: avatarIsDefault,
      onlineDot: onlineDot,
      detail: detailRows,
      raw: li.innerText.trim().replace(/\n+/g, ' | ').slice(0, 300)
    };
  }).filter(function(x) { return x.name && !/すべてを選択|今日の足あと|足あとトータル/.test(x.raw); });

  // 顶部汇总（今日の足あと N 人 / 足あとトータル N 人）
  var summary = document.querySelectorAll('.ds_like_list_item');
  var summaryTexts = Array.prototype.slice.call(summary).map(function(el) { return el.innerText.trim().replace(/\n+/g, ' ').slice(0, 80); });

  return {
    items: items,
    count: items.length,
    summary: summaryTexts,
    postRef: { url: '/sp/app/api/html/list_profile_ashi.php', note: '足迹=主动看我的人,all_count=100,per_page=5' }
  };
})()