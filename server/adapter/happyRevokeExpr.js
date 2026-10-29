(function() {
  // happymail.co.jp 快乐 · 消息撤回抓取原语（v5.2 坐实 2026-10-27）
  // ⚠ 红线：本 Expr 只读 DOM 标注撤回入口 + 状态，【不执行撤回】。撤回走 建议→确认→执行。
  // 撤回链路（坐实）：
  //   消息块内 button.revokeTextMessage（删除图标，仅自己发的、对方未读、时限内时显示）
  //   → 点 → remodal 确认层「送信取消について」（.modal-confirm「送信取消」/ .modal-cancel「キャンセル」）
  //     文案：取り消したことはお相手にも表示されます（撤回对对方可见）
  //   → POST /sp/app/api/html/getTextMessageRevokeStatus.php（查状态，token+messageId）
  //   → POST /sp/app/api/html/revokeTextMessage.php（执行，token+messageId）
  //   → 该消息从会话列表消失（all_count 减 1），DOM 变「削除済み」占位
  // 撤回条件：发送时间够近 + 对方未读 + 自己发的；撤回对对方可见
  var out = { revokeable: [] };
  document.querySelectorAll('.message__block--send').forEach(function(blk) {
    var mid = blk.querySelector('input[name="messageId"]');
    var own = blk.querySelector('input[name="isOwnMessage"]');
    var btn = blk.querySelector('.revokeTextMessage');
    out.revokeable.push({
      messageId: mid ? mid.value : '',
      isOwn: own ? own.value === 'true' : true,
      hasRevokeButton: !!btn,   // 无按钮 = 已超撤回时限 / 对方已读 / 非本人消息
      text: (blk.querySelector('.message__block__body__text') || {}).innerText ? blk.querySelector('.message__block__body__text').innerText.trim().slice(0, 60) : ''
    });
  });
  // 确认层结构（只读标注）
  var confirmModal = document.querySelector('.remodal, [class*="modal"]');
  out.confirmModalPresent = !!confirmModal;
  out.postRef = {
    statusApi: '/sp/app/api/html/getTextMessageRevokeStatus.php',  // 查能否撤回（token+messageId）
    revokeApi: '/sp/app/api/html/revokeTextMessage.php',           // 执行撤回（token+messageId）
    note: '撤回对对方可见（取り消したことはお相手にも表示されます）；仅自己发的、对方未读、时限内可用'
  };
  out.redline = '红线：本 Expr 只读标注，不点 .revokeTextMessage、不点「送信取消」；撤回走 建议→确认→执行';
  return out;
})()