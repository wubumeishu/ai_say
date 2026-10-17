// happymail.co.jp 快乐 · 收件箱「もっと見る」分页加载（H4 缺陷② · 合法只读 XHR，点一次加载下一批客户）
// 风控边界：只点收件箱自身「もっと見る」分页按钮（实测选择器 DIV#load_cu.list_load 文案=もっと見る），
//   不导航（同页 XHR）/不发送/不点批量风控入口。加载后 DOM 增补，上层再抓 .ds_message_list_mini。
(function() {
  // 精确命中「もっと見る」（.list_load 文案精确匹配，排除 メール通知設定/フォルダ一覧 等其它 ds_next_arrow；H4 缺陷6 防御：文案校验防误点其它按钮）
  var btn = null;
  var cands = Array.prototype.slice.call(document.querySelectorAll('.list_load, #load_cu, div[class*="load"], a[class*="more"]'));
  for (var i = 0; i < cands.length; i++) {
    var t = (cands[i].innerText || cands[i].textContent || '').trim();
    if (t === 'もっと見る' || /もっと見る/.test(t)) { btn = cands[i]; break; }
  }
  // 兜底：全页找文案含「もっと見る」的可点击元素（排除批量删/无视入口，只认「もっと見る」字样）
  if (!btn) {
    var all = Array.prototype.slice.call(document.querySelectorAll('div, a, button, span'));
    for (var j = 0; j < all.length; j++) {
      var tj = (all[j].innerText || all[j].textContent || '').trim();
      if (tj === 'もっと見る') { btn = all[j]; break; }
    }
  }
  if (btn) {
    // 点一次（页面自身合法分页 XHR；不导航/不发送/不批量删）
    btn.click();
    return { clicked: true, button: 'もっと見る' };
  }
  return { clicked: false, button: '' };
})()
