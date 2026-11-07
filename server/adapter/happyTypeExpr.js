(function() {
  // happymail.co.jp 快乐 · 客源 type_list.php（点赞客源）抓取原语（测绘图 §10.3）
  // 3 tab：#list_myself(我点赞, data-kind=2) / #list_type(对方给我点赞, data-kind=1) / #list_reciprocal(互赞, data-kind=3)
  // 条目 JS 动态填充（.php 只给壳 + 全選択 checkbox selToAll[]）；本 Expr 只读抽取壳 + 已填条目
// 2026-11-03 按实机 DOM 重写选择器：卡片 li.type_list_outer，名字 .ds_like_list_name，
//   年龄+市 .ds_like_list_age（拆 age/city），时间 .ds_like_list_date_last_login_list，头像 .ds_thum_contain
  // 风控边界：批量 削除/deny/noWatch 按钮（#informationAll + 批量 form）= 风控红线入口，本文件只标注不触发
  function readList(id) {
    var shell = document.getElementById(id);
    if (!shell) return [];
    var cards = shell.querySelectorAll('li.type_list_outer, .type_list_outer, li[type_list]');
    if (cards.length === 0) cards = shell.querySelectorAll('li:not(.all_check):not(.list_description)');
    var items = Array.prototype.slice.call(cards).map(function(li) {
      var name = li.querySelector('.ds_like_list_name, .ds_type_name, .type_name, .member_name');
      var date = li.querySelector('.ds_like_list_date_last_login_list, .ds_type_year, .year');
      var ageEl = li.querySelector('.ds_like_list_age, .ds_type_age');
      var ageText = ageEl ? ageEl.innerText.trim() : '';
      // 拆 age/city（如「50代半ば 札幌市」「20代前半 北海道(道央)」）
      var mAge = ageText.match(/^(\d+[代〜ー-]?(?:前半|半ば|後半)?\s*)/);
      var age = mAge ? mAge[1].trim() : '';
      var city = ageText.replace(age, '').trim();
      var detailRows = Array.prototype.slice.call(li.querySelectorAll('.ds_like_list_item, .ds_common_profile_detail_list_text'))
        .map(function(el) { return el.innerText.trim(); }).filter(Boolean).join(' / ').slice(0, 300);
      var thumb = li.querySelector('.ds_thum_contain img, img');
      var thumbBg = li.querySelector('.ds_thum_contain');
      var bg = thumbBg ? (String(thumbBg.style.backgroundImage || '').replace(/url\(['"]?/,'').replace(/['"]?\)/,'')) : '';
      var avatarUrl = (thumb && thumb.src) ? thumb.src : bg;
      var avatarIsDefault = !avatarUrl || /noimage_|\.svg|svgz_icon/i.test(avatarUrl);
      var lastLoginEl = li.querySelector('.ds_like_list_date_last_login_list');
      var lastLogin = lastLoginEl ? lastLoginEl.innerText.trim() : '';
      // 平台真实在线点（.last_login_icon_detail_* 的背景色）：绿=在线 黄=不常在线 灰=离线
      var dotEl = li.querySelector('.last_login_icon_detail_small_list, .last_login_icon_detail_picture_big, [class*=last_login_icon]');
      var onlineDot = null;
      if (dotEl) {
        var rawBg = (dotEl.getAttribute('style') || '');
        var mBg = rawBg.match(/background-color:\s*(#[0-9a-fA-F]{3,8}|\w+)/);
        var bgHex = mBg ? mBg[1].trim() : '';
        if (bgHex) {
          onlineDot = /2AB788/i.test(bgHex) ? 'green' : (/F3B117/i.test(bgHex) ? 'yellow' : (/D3D3D3/i.test(bgHex) ? 'gray' : bgHex.toLowerCase()));
        }
      }
      return {
        name: name ? name.innerText.trim() : '',
        age: age,
        region: city,
        avatarUrl: avatarIsDefault ? '' : avatarUrl,
        avatarIsDefault: avatarIsDefault,
        likeTime: date ? date.innerText.trim() : '',
        lastLogin: lastLogin,
        onlineDot: onlineDot,
        detail: detailRows,
        raw: li.innerText.trim().replace(/\n+/g, ' | ').slice(0, 300)
      };
    }).filter(function(x) { return x.name && !/すべてを選択/.test(x.raw); });
    return items;
  }
  var tabs = [
    { id: 'list_myself', label: '自分から(我点赞)', dataKind: 2, items: readList('list_myself') },
    { id: 'list_type', label: '相手から(对方给我)', dataKind: 1, items: readList('list_type') },
    { id: 'list_reciprocal', label: 'マッチング(互赞)', dataKind: 3, items: readList('list_reciprocal') }
  ];
  // 全選択 checkbox（批量操作载体，只读标注）
  var selAll = document.querySelector('input[name="selToAll"]');
  // 批量 form（风控红线入口标注，不触发）
  var batchForm = document.querySelector('form[action*="type_list"]');
  var batchBtns = batchForm ? Array.from(batchForm.querySelectorAll('button,input[type=submit]')).map(function(b) {
    return { label: b.innerText ? b.innerText.trim() : (b.value || ''), type: b.name || '' };
  }) : [];
  return {
    tabs: tabs,
    selToAllPresent: !!selAll,
    // 风控红线（§10.3）：以下按钮为批量删/无视/屏蔽入口，本 Expr 只读不触发
    riskControlEntries: {
      delete: '削除（批量删除点赞）',
      deny: '無視（无视/拉黑）',
      noWatch: '見ちゃいや（屏蔽）',
      note: '风控红线入口，本轮未点；自动化不触发批量风控操作'
    },
    batchButtons: batchBtns
  };
})()
