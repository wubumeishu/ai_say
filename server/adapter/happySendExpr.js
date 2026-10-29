(function() {
  // happymail.co.jp 快乐 · 发送 DOM 测绘（对应 §0.1 红线：本 Expr 只读 DOM，真发实现待用户授权 + 合规闸门 §1.1）
  // ⚠ 红线：本文件【不执行任何发送 fetch/POST/点击提交】——只抽取发送表单结构 + 风控字段，供后续真发坐实。
  // 真发 = #send_message form + textarea#text-message[name=messageBody] + 预设回复 select；成功判定 = POST /sp/app/api/html/send_message.php(200) + 新 .message__block--send + 未読标记（v5.2 坐实）
  var form = document.querySelector('#send_message, form[action*="message"]');
  var ta = document.querySelector('textarea#text-message[name=messageBody], textarea[name="messageBody"]');
  // 预设回复 select
  var presetSel = form ? form.querySelector('select') : null;
  // 风控字段（只读标注，不填不触发）
  var riskFields = {};
  if (form) {
    Array.from(form.querySelectorAll('input[type=hidden], input[name*="ukey"], input[name*="UID"], input[name*="memberSex"], input[name*="ageCertified"], input[name*="twilioBlocked"]')).forEach(function(inp) {
      riskFields[inp.name || ('input_' + inp.type)] = inp.value || '';
    });
  }
  // 成功判定（v5.2 坐实 2026-10-27，非推断）：
  // ① POST /sp/app/api/html/send_message.php → status=200（权威信号，含 ukey/UID 等风控字段）
  // ② 新 .message__block--send 出现（块内 input[name="messageId"] 取 messageId）
  // ③ textarea#text-message 清空 + 块尾「未読 HH:MM」标记
  // 确认层：点 .icon-message_send 后弹 popupContent → 点 button「送信する」（不是「はい」）
  // 换行格式：textarea 保留 \n，平台渲染成 <br> 多行
  var successRef = {
    postTo: '/sp/app/api/html/send_message.php',
    confirmButton: '送信する',
    successSignal: 'send_message.php=200 + 新 .message__block--send（input[name=MessageId]）+ textarea 清空 + 未読标记',
    todo: false
  };
  return {
    // 红线：本 Expr 只读 DOM，未填充/未提交任何消息
    readOnly: true,
    formPresent: !!form,
    textarea: ta ? { name: ta.name, id: ta.id, placeholder: ta.placeholder, maxLength: ta.maxLength || '' } : null,
    presetSelect: presetSel ? { options: Array.from(presetSel.options).map(function(o) { return o.value || o.text; }) } : null,
    riskFields: riskFields,     // ukey/UID/memberSex/ageCertified/twilioBlocked（只读标注）
    successReference: successRef,
    note: '红线：本 Expr 只读 DOM，真发实现待用户授权 + 合规闸门（§1.1）；ukey 等风控字段不填不触发'
  };
})()
