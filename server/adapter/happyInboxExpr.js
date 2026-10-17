(function() {
  try {
  // happymail.co.jp 快乐 · 收件箱抓取原语（对应测绘图 docs/plan/happy-platform-survey.md §10.1）
  // 收件箱 = POST /sp/app/html/api/list_message.php（cookie 会话态，服务端渲染列表）
  // 客户条目 = .ds_message_list_mini（.php 壳 + JS 填充）；本 Expr 只读 DOM 抽取结构化数据（CDP eval）
  // 风控边界：本文件只读抓取，不点 #kidoku 全既读 / 不点发送入口（§3.1 风控红线）
  var items = Array.from(document.querySelectorAll('.ds_message_list_mini')).map(function(el) {
    var name = el.querySelector('.ds_message_name__item');
    var pref = el.querySelector('.ds_message_pref');
    var body = el.querySelector('.message_body');
    var date = el.querySelector('.ds_message_date');
    // memberID = input[name="sel[]"] 的 value = 'mailID,memberID'（**逗号分隔**，HTML 属性名含方括号 name="sel[]"）
    var sel = el.querySelector('input[name="sel[]"]') || el.querySelector('input[name^=sel]');
    var selVal = sel ? sel.value : '';
    var parts = String(selVal).split(',');           // 逗号分隔 mailID,memberID
    var memberID = parts.length > 1 ? parts[1] : (parts[0] || '');
    // mailID = a.dtl-btn href 的 query
    var dtl = el.querySelector('a.dtl-btn');
    var mailID = '';
    if (dtl) {
      var m = String(dtl.getAttribute('href') || '').match(/mailID=([^&]+)/);
      // H4 缺陷5 修复：mailID 保留 href 里的编码形态（%2B/%3D），不 decode。
      // decode 还原成 +/= 后浏览器跳会二次编码 → 平台拒识 → 误显退会。
      // 会话页正确 URL = message_detail.php?a=a&mailID={编码 mailID}，直接取 href 原始 query。
      mailID = m ? m[1] : '';
    }
    return {
      name: name ? String(name.innerText || name.textContent || '').trim() : '',
      yearMarket: pref ? pref.innerText.trim() : '',       // 年市 = 年齢×市
      lastMessage: body ? body.innerText.trim() : '',
      lastTime: date ? String(date.innerText || date.textContent || '').trim() : '',
      memberID: memberID,                                   // 客户详情页 tid
      mailID: mailID,                                       // 会话页 mailID（base64）
      raw: el.innerText.trim().replace(/\n+/g, ' | ').slice(0, 200)
    };
  });
  // 未读汇总（#msg_notification_cnt 隐藏 input + nav「メッセージ N」）
  var unreadCnt = document.querySelector('#msg_notification_cnt');
  var unread = unreadCnt ? unreadCnt.value.trim() : '';
  var unreadAddEl = document.querySelector('#msg_notification_addition');
  var unreadAdd = unreadAddEl ? (String(unreadAddEl.value || unreadAddEl.textContent || '').trim()) : '';
  return {
    contacts: items,
    unread: unread,
    unreadAddition: unreadAdd,
    hasTab: !!document.querySelector('.ds_message_tab_item'),
    // POST 请求体参考（cookie + CSRF 占位，本 Expr 只读不发起 POST，仅供 CDP 抓取时构造）
    postRef: { url: '/sp/app/html/api/list_message.php', note: 'cookie 会话态 + CSRF token 占位（需真发/真操作时由页面自身带）' }
  };
  } catch (e) { return { contacts: items, unread: '', unreadAddition: '', hasTab: false, postRef: {}, exprError: String(e && e.message || e) }; }
})()
