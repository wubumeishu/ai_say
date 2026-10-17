(function() {
  // happymail.co.jp 快乐 · 会话历史 message_detail.php?mailID={b64} 抓取原语（测绘图 §7）
  // 消息块：.message__block--send（我发的）/ .message__block--receive（对方发的）
  //   正文 .message__block__body__text / 时间 .message__block__body__time / 已读回执 .message__block__body__time__opened
  // 加载更多「以前のメッセージを見る」= 分页（本 Expr 只抽当前页，分页需 CDP 点击加载，风控边界不自动翻页）
  var blocks = Array.from(document.querySelectorAll('.message__block--send, .message__block--receive')).map(function(blk) {
    var isSend = /send/.test(blk.className || '');
    var text = blk.querySelector('.message__block__body__text');
    var time = blk.querySelector('.message__block__body__time');
    var opened = blk.querySelector('.message__block__body__time__opened');
    var avatar = blk.querySelector('img');
    return {
      role: isSend ? 'self' : 'other',        // send=我发 / receive=对方
      text: text ? text.innerText.trim() : '',
      time: time ? time.innerText.trim() : '',
      readReceipt: opened ? (opened.innerText.trim() || true) : false,  // 已读回执
      avatarUrl: avatar ? avatar.src : ''
    };
  });
  // 加载更多按钮（存在则标注，本 Expr 不自动点击翻页）
  var moreBtn = document.querySelector('.load_more, [class*="以前のメッセージ"], a[href*="message_detail"]');
  var hasMore = !!moreBtn;
  var mailID = (function() {
    var m = location.search.match(/mailID=([^&]+)/);
    return m ? m[1] : '';
  })();
  return {
    mailID: mailID,
    messages: blocks,
    count: blocks.length,
    hasMore: hasMore,
    note: hasMore ? '存在「以前のメッセージを見る」分页，本 Expr 只抽当前页（不自动翻页）' : ''
  };
})()
