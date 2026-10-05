(async function() {
  var msg = __MSG__;
  var doConfirm = __DO_CONFIRM__;
  var waitMs = __WAIT_MS__;
  function clean(s) { return String(s == null ? '' : s).replace(/[\s\u3000]+/g, ' ').trim(); }
  var out = { ok: false, step: 'start', reason: '', url: location.href };

  // 1) fill the textarea via native setter (so the page's 1s interval re-enables #sendButton)
  var ta = document.querySelector('textarea[name="body"].inputTextAreaRd') || document.querySelector('textarea[name="body"]');
  if (!ta) { out.step = 'find-input'; out.reason = 'no-textarea'; return out; }
  try {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, msg);
  } catch (e) { ta.value = msg; }
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new Event('change', { bubbles: true }));
  ta.dispatchEvent(new Event('keyup', { bubbles: true }));
  out.step = 'filled';
  out.taLen = msg.length;

  // 2) click the "送信内容を確認" button → opens the confirm popup
  var btn = document.getElementById('sendButton');
  if (!btn) { out.reason = 'no-send-button'; out.step = 'find-button'; return out; }
  btn.disabled = false;
  btn.click();
  out.step = 'clicked-confirm';

  // 3) wait up to 3s for the "はい" button (#submitBtn) to appear + become visible
  var t0 = Date.now();
  var submitBtn = null;
  while (Date.now() - t0 < Math.min(waitMs, 3000)) {
    submitBtn = document.getElementById('submitBtn');
    if (submitBtn && (submitBtn.offsetWidth || submitBtn.offsetHeight)) break;
    await new Promise(function(r){ setTimeout(r, 150); });
  }

  // 4) if the confirm popup is showing, click はい (or いいえ if doConfirm=false)
  if (submitBtn && (submitBtn.offsetWidth || submitBtn.offsetHeight)) {
    if (doConfirm) {
      submitBtn.click();
      out.step = 'confirmed';
    } else {
      var cancelBtn = document.getElementById('cancelBtn');
      if (cancelBtn && (cancelBtn.offsetWidth || cancelBtn.offsetHeight)) cancelBtn.click();
      out.ok = false; out.reason = 'confirm-required-but-skipped'; out.step = 'cancelled-confirm';
      return out;
    }
  } else {
    // No popup showed (auto-send path) — treat as already sent.
    out.step = 'auto-sent';
  }

  // 5) wait briefly for the page to process the submission
  await new Promise(function(r){ setTimeout(r, 1200); });

  // 6) success signal: a visible error popup means failure; otherwise assume sent.
  var errPop = Array.prototype.slice.call(document.querySelectorAll('#popup-error, #popup-error-send-again, #popup-error-long-message, #popup-error-not-neighbor')).filter(function(p){
    return p && p.style.display !== 'none' && (p.offsetWidth || p.offsetHeight);
  })[0];
  if (errPop) { out.ok = false; out.reason = 'error-popup-' + (errPop.id || errPop.className); out.step = 'error'; }
  else { out.ok = true; out.reason = 'sent'; out.step = 'sent'; }

  out.taValueAfter = clean((document.querySelector('textarea[name="body"]')||{}).value);
  return out;
})()
