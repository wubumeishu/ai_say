(function() {
  // happymail.co.jp 快乐 · 客源 profile_list.php（检索客源）抓取原语（测绘图 §10.1 响应 schema）
  // POST /sp/app/api/html/list_profile_gallery.php 返回 .profile_list_big_item 卡片数组
  // 卡片字段：.profile_list_big_area（年齢+地区）/ .profile_list_big_comment（自我介绍）/ P.text-male（性别）
  // 本 Expr 只读 DOM 抽取（若页面已渲染卡片列表）；卡片为空时回空数组（JS 动态填充未到时不编造）
  var cards = Array.from(document.querySelectorAll('.profile_list_big_item')).map(function(el) {
    var area = el.querySelector('.profile_list_big_area');
    var comment = el.querySelector('.profile_list_big_comment');
    var name = el.querySelector('.profile_list_big_name, .member_name, .ds_name');
    var img = el.querySelector('img');
    var isDefaultAvatar = img ? /noimage_/.test(img.src || '') : true;
    // 性别：P.text-male（男）/ P.text-female（女）
    var sexMale = el.querySelector('.text-male');
    var sexFemale = el.querySelector('.text-female');
    // 地区/年龄：.profile_list_big_area 内文本（如「28歳 神奈川」）
    var areaTxt = area ? area.innerText.trim() : '';
    return {
      name: name ? name.innerText.trim() : '',
      area: areaTxt,                       // 年齢+地区（原始文本，下游解析）
      selfIntro: comment ? comment.innerText.trim() : '',
      sex: sexMale ? 'male' : (sexFemale ? 'female' : ''),
      avatarUrl: img ? img.src : '',
      avatarIsDefault: isDefaultAvatar,
      raw: el.innerText.trim().replace(/\n+/g, ' | ').slice(0, 200)
    };
  });
  var hasCards = cards.length > 0;
  return {
    cards: cards,
    count: cards.length,
    // POST 请求体参考（cookie + 检索条件，本 Expr 只读不发起）
    postRef: {
      url: '/sp/app/api/html/list_profile_gallery.php',
      note: 'cookie 会话态；检索条件（年齢/地区/興味）走 query/body，CSRF token 由页面带'
    },
    // 卡片未渲染（JS 填充未到时）不编造，回 hasCards=false 让上层判断
    note: hasCards ? '' : 'cards 为空：列表由 JS 填充，需页面渲染完成后抓取'
  };
})()
