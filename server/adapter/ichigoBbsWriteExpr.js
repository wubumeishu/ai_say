// 出会 BBS 帖子「改/增」表达式（ichigoBbsWriteExpr.js）· 模块3 阶段2
// 在 sp.194964.com 的帖子编辑页（show_bbs_write_edit.html?targetBbsId=...）上下文执行：
//   填 textarea[name=title] / textarea[name=body] → 点「募集する」（button[name=write]）→
//   检测二次确认「確認する」（button[name=confirm]）→ 提交 → 等结果页
// 设计：
//   * 改帖复用发帖表单（is_edit=1 隐藏字段已就位），只需覆盖 title/body 两个 textarea
//   * 不碰其他任何字段（point/prefId/targetGenreId/cityId 等保持平台原值）
//   * 提交后平台可能跳 show_bbs_write_list（成功）或留原地 + 报错，靠 URL/页面文本判定
// 传参：第 1 参 = null（当前页）；第 2 参 = opts { title, body }
//       （只传要改的字段；不传的保持原值——表达式内读 DOM 当前值兜底）
// 返回 Promise<{ ok, step, reason, note, submitted, resultUrl, via }>
(function(url, opts) {
  var O = opts || {};
  var doc = document;
  var out = { ok: false, via: 'bbs-write-expr' };
  var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

  if (String(location.hostname || '').indexOf('194964.com') === -1) {
    out.reason = 'not-on-platform-domain';
    out.note = '需在 sp.194964.com 编辑页执行（当前 ' + location.hostname + '）';
    return Promise.resolve(out);
  }
  // 确认在编辑页（有 formID + textarea[name=body]）
  var form = doc.getElementById('formID') || doc.querySelector('form');
  var titleTa = form ? form.querySelector('textarea[name=title]') : null;
  var bodyTa = form ? form.querySelector('textarea[name=body]') : null;
  if (!form || !bodyTa) {
    out.step = 'form';
    out.reason = 'write-form-not-found';
    out.note = '未找到发帖/编辑表单（#formID + textarea[name=body]）。确认窗口在 show_bbs_write_edit.html 页。';
    return Promise.resolve(out);
  }
  // 只覆盖要改的字段（不传的保持 DOM 当前值）
  if (typeof O.title === 'string') {
    titleTa.value = O.title;
    titleTa.dispatchEvent(new Event('input', { bubbles: true }));
    titleTa.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (typeof O.body === 'string') {
    bodyTa.value = O.body;
    bodyTa.dispatchEvent(new Event('input', { bubbles: true }));
    bodyTa.dispatchEvent(new Event('change', { bubbles: true }));
  }
  out.titleSet = typeof O.title === 'string';
  out.bodySet = typeof O.body === 'string';

  // 字数自检（平台硬限制 title≤30 body≤500）
  var titleLen = titleTa.value.length;
  var bodyLen = bodyTa.value.length;
  out.titleLen = titleLen;
  out.bodyLen = bodyLen;
  if (titleLen > 30) {
    out.step = 'validate';
    out.reason = 'title-too-long';
    out.note = '标题 ' + titleLen + ' 字 > 30 字上限，平台会拒收。请缩短。';
    return Promise.resolve(out);
  }
  if (bodyLen > 500) {
    out.step = 'validate';
    out.reason = 'body-too-long';
    out.note = '正文 ' + bodyLen + ' 字 > 500 字上限，平台会拒收。请缩短。';
    return Promise.resolve(out);
  }

  // 点「募集する」（button[name=write]）
  var writeBtn = form.querySelector('button[name=write], button[type=submit]');
  if (!writeBtn) {
    out.step = 'submit';
    out.reason = 'write-btn-not-found';
    out.note = '表单里未找到「募集する」按钮（button[name=write]）';
    return Promise.resolve(out);
  }
  writeBtn.click();
  out.step = 'submit';

  // 等二次确认页/弹窗（「確認する」button[name=confirm]）
  return sleep(1500).then(function() {
    var confirmBtn = doc.querySelector('button[name=confirm]') ||
      Array.from(doc.querySelectorAll('button, input[type=submit]')).filter(function(b) {
        return String(b.textContent || b.value || '').trim() === '確認する';
      })[0];
    if (confirmBtn) {
      confirmBtn.click();
      out.confirmed = true;
      out.step = 'confirmed';
      return sleep(2500).then(function() {
        out.resultUrl = String(location.href || '');
        // 成功判定：离开编辑页（跳 write_list / write_detail）或页面出现成功文案
        var leftEdit = out.resultUrl.indexOf('show_bbs_write_edit') === -1;
        var successText = /募集した|更新した|編集した|削除した|完了/.test(String(doc.body ? doc.body.innerText : '').slice(0, 500));
        out.ok = leftEdit || successText;
        out.submitted = true;
        if (!out.ok) {
          out.reason = 'submit-result-unknown';
          out.note = '已点「確認する」提交，但 URL 仍在编辑页且无成功文案（可能平台异步处理中或校验未过），请人工确认。';
        } else {
          out.note = '已提交' + (O.bodySet ? '（正文已更新）' : '') + (O.titleSet ? '（标题已更新）' : '') + '，落地 ' + out.resultUrl.slice(0, 60);
        }
        return out;
      });
    }
    // 无确认按钮：可能直接提交成功或无二次确认
    return sleep(2000).then(function() {
      out.resultUrl = String(location.href || '');
      var leftEdit2 = out.resultUrl.indexOf('show_bbs_write_edit') === -1;
      out.ok = leftEdit2;
      out.submitted = true;
      out.confirmed = false;
      if (!out.ok) {
        out.reason = 'no-confirm-and-still-edit';
        out.note = '点「募集する」后未出现「確認する」且仍停在编辑页（平台可能改了确认交互），请人工确认。';
      } else {
        out.note = '已提交（无二次确认直接跳转），落地 ' + out.resultUrl.slice(0, 60);
      }
      return out;
    });
  });
})(__URL__, __BBS_WRITE_OPTS__);
