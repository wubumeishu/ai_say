// 出会拉黑表达式（ichigoBlockExpr.js）
// 在客户 show_history 页 / show_profile 页触发「ブロック」屏蔽动作
// 零导航：页面内 DOM 操作 + 弹窗确认
(function(url) {
  var target = url || location.href;
  var doc = document;
  // 拉黑按钮候选（出会平台：ブロック / 通報 / 屏蔽 图标）
  var candidates = [
    'a[data-action="block"]', 'button[data-action="block"]',
    '.btn-block', '.block-btn', '[class*="block"]',
    'a[href*="block"]', 'button[href*="block"]',
    '.report-link', 'a.report', '.btn-report'
  ];
  var btn = null;
  for (var i = 0; i < candidates.length; i++) {
    btn = doc.querySelector(candidates[i]);
    if (btn && btn.offsetParent !== null) break;  // 可见才算
    btn = null;
  }
  if (!btn) {
    return { ok: false, reason: 'block-btn-not-found', note: '当前页未找到拉黑按钮（客户可能已是黑名单/页面无该控件）' };
  }
  btn.click();
  // 等待确认弹窗（出会平台拉黑通常弹确认层）
  var confirmSel = ['#blockConfirm', '.modal-confirm', '.popup .btn-ok', '[class*="confirm"] button', '.modal button.ok'];
  var confirmed = false;
  function tryConfirm() {
    for (var k = 0; k < confirmSel.length; k++) {
      var el = doc.querySelector(confirmSel[k]);
      if (el && el.offsetParent !== null) { el.click(); confirmed = true; return; }
    }
    return null;
  }
  // 同步立即试一次（弹窗可能 DOM 已渲染）
  var t0 = tryConfirm();
  return {
    ok: confirmed || t0 !== null,
    step: confirmed ? 'confirmed' : 'clicked',
    reason: confirmed ? '' : 'confirm-pending',
    note: '拉黑动作已触发' + (confirmed ? '（已确认弹窗）' : '（弹窗待用户确认，或无二次确认）'),
    btn: btn.className || btn.tagName || 'unknown'
  };
})(__URL__);
