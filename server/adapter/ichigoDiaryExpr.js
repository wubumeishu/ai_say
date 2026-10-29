// 出会 日记（日記）发布+删除表达式（ichigoDiaryExpr.js）· 模块8「内容引流」
// 在 sp.194964.com 的日记相关页执行。三步链路（总控 2026-10-26 实测坐实）：
//   写页 /sns/snsdiary/show_mydiary_form.html（填 input.title + textarea.body + select.publicFlag + select.commentReceptFlag + checkbox.adultFlag）
//     → 点「書き込む」(form → show_write_confirm.html)
//     → 确认页点「書き込む」(form1 → POST exec_write.html) → complete_write.html「日記を投稿しました」
//   删：/sns/snsdiary/show_mydiaries.html 勾 checkbox targetDiaryIdList[]（value=日记ID）
//     → 点删除图标 a[href*=delete_mydiary_confirm] → 确认页 show_delete_mydiary_confirm.html → 点「はい」(form1 → POST exec_delete_mydiary.html)
// 传参：第 1 参 = null；第 2 参 = opts { action:'write'|'delete', title, body, publicFlag, commentReceptFlag, adultFlag, diaryId, confirmed }
//   action=write  : 需 confirmed=true。publicFlag: 1全体公開/2会員/3友達/4非公開/6下書き
//   action=delete  : 需 confirmed=true。diaryId=日记 ID（从 show_mydiaries 列表的 checkbox value 取）
(function(url, opts) {
  var O = opts || {};
  var doc = document;
  var out = { ok: false, via: 'diary-expr' };
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  if (String(location.hostname || '').indexOf('194964.com') === -1) {
    out.reason = 'not-on-platform-domain';
    return Promise.resolve(out);
  }
  if (O.action === 'write') {
    if (O.confirmed !== true) {
      out.step = 'guard';
      out.reason = 'not-confirmed';
      out.note = 'write 是强副作用，需 opts.confirmed=true。标题「' + (O.title||'') + '」';
      return Promise.resolve(out);
    }
    if (String(location.pathname || '').indexOf('show_mydiary_form') === -1) {
      out.reason = 'not-on-diary-form';
      out.note = 'action=write 需在 /sns/snsdiary/show_mydiary_form.html 执行（当前 ' + location.pathname + '）';
      return Promise.resolve(out);
    }
    var form = doc.querySelector('form');
    var titleEl = form ? (form.querySelector('input[type=text].title') || form.querySelector('input[type=text]')) : null;
    var bodyEl = form ? (form.querySelector('textarea.inputTextAreaRd') || form.querySelector('textarea')) : null;
    if (!titleEl || !bodyEl) {
      out.step = 'form';
      out.reason = 'diary-form-not-found';
      out.note = '未找到日记表单（input.title + textarea.body）。确认窗口在 show_mydiary_form.html。';
      return Promise.resolve(out);
    }
    titleEl.value = String(O.title || '');
    titleEl.dispatchEvent(new Event('input', { bubbles: true }));
    bodyEl.value = String(O.body || '');
    bodyEl.dispatchEvent(new Event('input', { bubbles: true }));
    var pubSel = form.querySelector('select[name=publicFlag]') || form.querySelector('select');
    if (pubSel) { pubSel.value = String(O.publicFlag || 1); pubSel.dispatchEvent(new Event('change', { bubbles: true })); }
    out.publicFlag = pubSel ? pubSel.value : null;
    var cmtSel = form.querySelector('select[name=commentReceptFlag]') || form.querySelectorAll('select')[1];
    if (cmtSel) { cmtSel.value = String(O.commentReceptFlag || 1); cmtSel.dispatchEvent(new Event('change', { bubbles: true })); }
    out.commentFlag = cmtSel ? cmtSel.value : null;
    var adultCb = form.querySelector('input[name=adultFlag]');
    if (adultCb) { adultCb.checked = O.adultFlag === true; }
    out.titleSet = !!O.title;
    out.bodySet = !!O.body;
    // 第 1 步提交 → 确认页
    var submitBtn = form.querySelector('input[type=submit]') || form.querySelector('button[type=submit]');
    if (submitBtn) submitBtn.click(); else form.submit();
    out.step = 'submit-form';
    return sleep(5000).then(function() {
      // 确认页 show_write_confirm.html → 点「書き込む」(form1)
      if (String(location.pathname || '').indexOf('show_write_confirm') === -1) {
        out.afterUrl = String(location.href || '');
        out.ok = false;
        out.reason = 'confirm-page-not-reached';
        out.note = '第 1 步提交后未跳确认页（落地 ' + out.afterUrl.slice(0,60) + '），请人工确认。';
        return out;
      }
      var cform = doc.querySelector('form[action*="exec_write"]') || doc.querySelector('form#form1') || doc.querySelector('form');
      var cbtn = cform ? (cform.querySelector('input[type=submit].greenButton') || cform.querySelector('input[type=submit]')) : null;
      if (cbtn) cbtn.click(); else if (cform) cform.submit();
      out.step = 'confirm-submit';
      out.confirmed = true;
      return sleep(5000).then(function() {
        out.afterUrl = String(location.href || '');
        out.ok = /complete_write/.test(out.afterUrl) || /日記を投稿/.test(doc.body ? doc.body.innerText : '');
        if (!out.ok) {
          out.reason = 'diary-publish-unknown';
          out.note = '已过确认页，但未检测到 complete_write.html / 「日記を投稿しました」，请人工确认。';
        } else {
          out.note = '已发布日记「' + O.title + '」（publicFlag=' + out.publicFlag + '），落地 ' + out.afterUrl.slice(0,60) + '。';
        }
        return out;
      });
    });
  }
  if (O.action === 'delete') {
    if (O.confirmed !== true) {
      out.step = 'guard';
      out.reason = 'not-confirmed';
      out.note = 'delete 是强副作用，需 opts.confirmed=true。diaryId=' + O.diaryId;
      return Promise.resolve(out);
    }
    if (String(location.pathname || '').indexOf('show_mydiaries') === -1) {
      out.reason = 'not-on-mydiaries';
      out.note = 'action=delete 需在 /sns/snsdiary/show_mydiaries.html 执行（当前 ' + location.pathname + '）';
      return Promise.resolve(out);
    }
    var cb = O.diaryId ? doc.querySelector('input[type=checkbox][name="targetDiaryIdList[]"][value="' + String(O.diaryId) + '"]') : null;
    if (!cb) {
      out.reason = 'diary-checkbox-not-found';
      out.note = '未找到 diaryId=' + O.diaryId + ' 的 checkbox（可能已删或 ID 错）';
      return Promise.resolve(out);
    }
    cb.checked = true;
    var delLink = doc.querySelector('a[href*="delete_mydiary_confirm"]');
    if (!delLink) { out.reason = 'delete-link-not-found'; out.note = '未找到删除图标（a[href*=delete_mydiary_confirm]）'; return Promise.resolve(out); }
    delLink.click();
    out.step = 'delete-confirm';
    return sleep(4000).then(function() {
      if (String(location.pathname || '').indexOf('show_delete_mydiary_confirm') === -1) {
        out.afterUrl = String(location.href || '');
        out.ok = false;
        out.reason = 'delete-confirm-not-reached';
        out.note = '点删除图标后未跳确认页（落地 ' + out.afterUrl.slice(0,60) + '），请人工确认。';
        return out;
      }
      var dform = doc.querySelector('form[action*="exec_delete_mydiary"]') || doc.querySelector('form#form1') || doc.querySelector('form');
      var dbtn = dform ? (dform.querySelector('input[type=submit].button') || dform.querySelector('input[type=submit]')) : null;
      if (dbtn) dbtn.click(); else if (dform) dform.submit();
      out.step = 'delete-submit';
      out.submitted = true;
      return sleep(4000).then(function() {
        out.afterUrl = String(location.href || '');
        out.ok = /show_mydiaries/.test(out.afterUrl) && /日記はありません|削除/.test(doc.body ? doc.body.innerText : '');
        out.note = out.ok ? ('已删除日记 ' + O.diaryId + '，列表回「日記はありません」') : '已提交删除，未检测到成功文案，请人工确认。';
        return out;
      });
    });
  }
  out.reason = 'unknown-action';
  out.note = '未知 action=' + O.action + '（支持 write/delete）';
  return Promise.resolve(out);
})(__URL__, __DIARY_OPTS__);
