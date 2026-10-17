(function() {
  // happymail.co.jp 快乐 · 客户详情 profile_detail.php?tid={memberID} 抓取原语（测绘图 §10.2 全字段坐实）
  // 字段 .ds_profile_select_list_item（全 18+ 字段）+ 兴趣 UL.ds_circle_text_list_item + 最近登录 .ds_profile_picture
  var FIELDS = [
    ['gender', '性別'], ['age', '年齢'], ['region', '居住地'], ['areaDetail', '詳細エリア'],
    ['bloodType', '血液型'], ['zodiac', '星座'], ['height', '身長'], ['style', 'スタイル'],
    ['looks', 'ルックス'], ['occupation', '職業'], ['income', '年収'], ['relationshipStatus', '交際ステータス'],
    ['children', '子ども'], ['marriageIntent', '結婚意思'], ['smoking', 'タバコ'], ['drinking', 'お酒'],
    ['car', 'クルマ'], ['cohabitant', '同居人'], ['siblings', '兄弟姉妹'], ['meetingGoal', '出会う希望'],
    ['firstDateCost', '初回デート費用']
  ];
  var detail = {};
  var items = document.querySelectorAll('.ds_profile_select_list_item');
  items.forEach(function(el) {
    var label = el.querySelector('dt, .label, .name, .field-label');
    var val = el.querySelector('dd, .value, .field-value, .content');
    var k = label ? label.innerText.trim() : '';
    var v = val ? val.innerText.trim() : el.innerText.trim().replace(k, '').trim();
    if (k) detail[k] = v;
  });
  // 把 18+ 字段映射到 IDENTITY_FIELDS（对齐出会画像字段，未命中的 key 保留原日文）
  var normalized = {};
  FIELDS.forEach(function(pair) {
    var key = pair[0];
    var jp = pair[1];
    if (detail[jp]) normalized[key] = detail[jp];
  });
  // 兴趣（UL.ds_circle_text_list_item 子项）
  var interests = Array.from(document.querySelectorAll('.ds_circle_text_list_item li, UL.ds_circle_text_list_item > *')).map(function(li) {
    return li.innerText.trim();
  }).filter(Boolean);
  // 最近登录 / 头像判定（§10.3：bg 含 pict.happymail.co.jp=真实头像，noimage_=默认）
  var picEl = document.querySelector('.ds_profile_picture');
  var picBg = picEl ? (picEl.style && picEl.style.backgroundImage || picEl.getAttribute('data-bg') || '') : '';
  var picImg = picEl ? picEl.querySelector('img') : null;
  var avatarUrl = picImg ? picImg.src : (picBg.match(/url\(['"]?([^'")]+)/) ? (function(m){return m[1];})(picBg.match(/url\(['"]?([^'")]+)/)[1]) : '');
  var avatarIsDefault = /noimage_/.test(avatarUrl || picBg) || !/pict\.happymail\.co\.jp/.test(avatarUrl || picBg);
  var tid = (location.search.match(/tid=([^&]+)/) || [])[1] || '';
  return {
    tid: tid,
    fields: normalized,
    rawFields: detail,
    interests: interests,
    avatarUrl: avatarUrl,
    avatarIsDefault: avatarIsDefault,
    note: '字段映射按 §10.2 18+ 维度；未命中 IDENTITY_FIELDS 的 key 保留在 rawFields（原日文），下游按需取'
  };
})()
