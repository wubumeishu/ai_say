(function() {
  // happymail.co.jp 快乐 · 客源 type_list.php（点赞客源）抓取原语（测绘图 §10.3）
  // 3 tab：#list_myself(我点赞, data-kind=2) / #list_type(对方给我点赞, data-kind=1) / #list_reciprocal(互赞, data-kind=3)
  // 条目 JS 动态填充（.php 只给壳 + 全選択 checkbox selToAll[]）；本 Expr 只读抽取壳 + 已填条目
  // 风控边界：批量 削除/deny/noWatch 按钮（#informationAll + 批量 form）= 风控红线入口，本文件只标注不触发
  function readList(id) {
    var shell = document.getElementById(id);
    if (!shell) return [];
    return Array.from(shell.querySelectorAll('.ds_type_list_item, .type_list_item, li')).map(function(li) {
      var name = li.querySelector('.ds_type_name, .type_name, .member_name');
      var year = li.querySelector('.ds_type_year, .year');
      var pref = li.querySelector('.ds_type_pref, .pref');
      var img = li.querySelector('img');
      var isDefaultAvatar = img ? /noimage_/.test(img.src || '') : true;
      return {
        name: name ? name.innerText.trim() : '',
        age: year ? year.innerText.trim() : '',
        region: pref ? pref.innerText.trim() : '',
        avatarUrl: img ? img.src : '',
        avatarIsDefault: isDefaultAvatar,
        raw: li.innerText.trim().replace(/\n+/g, ' | ').slice(0, 200)
      };
    }).filter(function(x) { return x.name || x.raw; });
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
