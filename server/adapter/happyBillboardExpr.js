(function() {
  // happymail.co.jp 快乐 · 客源 keijiban.php（募集/掲示板）抓取原语（测绘图 §10.4）
  // POST /sp/app/html/api/list_billboard.php；外层 schema 已坐实，body 内层条目字段 TODO（需真操作拿全，留待真发坐实）
  // 本 Expr 只读 DOM：若募集页已渲染条目则抽取，否则回空（不编造）
  var items = Array.from(document.querySelectorAll('.ds_billboard_item, .billboard_list_item, .keijiban_item, li[data-pid]')).map(function(el) {
    var name = el.querySelector('.name, .member_name, .ds_name');
    var text = el.querySelector('.text, .comment, .body');
    var img = el.querySelector('img');
    var isDefaultAvatar = img ? /noimage_/.test(img.src || '') : true;
    return {
      name: name ? name.innerText.trim() : '',
      text: text ? text.innerText.trim() : '',
      avatarUrl: img ? img.src : '',
      avatarIsDefault: isDefaultAvatar,
      raw: el.innerText.trim().replace(/\n+/g, ' | ').slice(0, 200)
    };
  }).filter(function(x) { return x.name || x.text; });
  var hasItems = items.length > 0;
  return {
    items: items,
    count: items.length,
    postRef: {
      url: '/sp/app/html/api/list_billboard.php',
      // TODO（§10.4）：响应 body 内层字段（募集条目结构）待真操作坐实；外层 schema 已坐实
      bodyFieldsTodo: true
    },
    note: hasItems ? '' : 'items 为空：募集列表由 JS/POST 填充，需页面渲染完成后抓取'
  };
})()
