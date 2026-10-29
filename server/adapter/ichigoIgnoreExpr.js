// 出会 忽略（無視）/ 解除忽略表达式（ichigoIgnoreExpr.js）· 模块6「账号卫生」
// 两个方向机制不同（总控 2026-10-26 实测坐实）：
//   加忽略 = 资料页三点菜单「無視する」→ AJAX POST data-url=/sns/snsmylist/ajax_ignore_regist.html?q=<token>
//   删忽略 = /sns/snsmylist/show_ignore_list.html 勾 checkbox targetReMemberIdList[] → POST exec_remove_ignore.html
// 传参：第 1 参 = null；第 2 参 = opts { action:'list'|'ignore'|'unignore', memberIds:[] }
(function(url, opts) {
  var O = opts || {};
  var doc = document;
  var out = { ok: false, via: 'ignore-expr' };
  if (String(location.hostname || '').indexOf('194964.com') === -1) {
    out.reason = 'not-on-platform-domain';
    return Promise.resolve(out);
  }
  var onIgnoreList = String(location.pathname || '').indexOf('show_ignore_list') !== -1;
  var onProfile = String(location.pathname || '').indexOf('show_profile') !== -1;
  if (O.action === 'list' || O.action === undefined) {
    if (!onIgnoreList) {
      out.reason = 'not-on-ignore-list';
      out.note = 'action=list 需在 show_ignore_list.html 执行（当前 ' + location.pathname + '）';
      return Promise.resolve(out);
    }
    var boxes = Array.prototype.slice.call(doc.querySelectorAll('input[type=checkbox][name="targetReMemberIdList[]"]'));
    out.ignoredMemberIds = boxes.map(function(cb){ return cb.value; }).filter(Boolean);
    out.count = out.ignoredMemberIds.length;
    out.ok = true;
    out.fetchedAt = new Date().toISOString();
    if (out.count === 0) { out.reason = 'empty'; out.note = '忽略列表为空（0 条）'; }
    return Promise.resolve(out);
  }
  if (O.action === 'ignore') {
    if (!onProfile) {
      out.reason = 'not-on-profile-page';
      out.note = 'action=ignore 需在会员资料页（show_profile.html）执行（当前 ' + location.pathname + '）';
      return Promise.resolve(out);
    }
    var memSpan = doc.querySelector('[data-memberid]');
    out.memberId = memSpan ? memSpan.getAttribute('data-memberid') : null;
    var ign = doc.querySelector('a[data-url*="ajax_ignore_regist"]');
    if (!ign) {
      out.reason = 'ignore-btn-not-found';
      out.note = '资料页未找到「無視する」按钮（可能该会员已被忽略）';
      return Promise.resolve(out);
    }
    out.dataUrl = ign.getAttribute('data-url').slice(0, 120);
    ign.click();
    out.clicked = true;
    return new Promise(function(resolve) {
      setTimeout(function() {
        out.afterUrl = String(location.href || '');
        out.ok = true;
        out.note = '已点「無視する」（AJAX），会员 ' + out.memberId + '。请回忽略列表验证。';
        resolve(out);
      }, 3000);
    });
  }
  if (O.action === 'unignore') {
    if (!onIgnoreList) {
      out.reason = 'not-on-ignore-list';
      out.note = 'action=unignore 需在 show_ignore_list.html 执行（当前 ' + location.pathname + '）';
      return Promise.resolve(out);
    }
    var ids = (O.memberIds || []).map(String).filter(Boolean);
    var boxes2 = Array.prototype.slice.call(doc.querySelectorAll('input[type=checkbox][name="targetReMemberIdList[]"]'));
    out.availableIds = boxes2.map(function(cb){ return cb.value; });
    out.removedIds = [];
    boxes2.forEach(function(cb) {
      if (ids.length === 0 || ids.indexOf(cb.value) !== -1) { cb.checked = true; out.removedIds.push(cb.value); }
    });
    out.checked = out.removedIds.length;
    var form = doc.querySelector('form[action*="exec_remove_ignore"]') || doc.querySelector('form');
    if (!form || out.checked === 0) {
      out.reason = out.checked === 0 ? 'no-target-checkbox' : 'remove-form-not-found';
      out.note = out.checked === 0 ? ('指定 memberId ' + JSON.stringify(ids) + ' 未找到') : '未找到 exec_remove_ignore 表单';
      return Promise.resolve(out);
    }
    form.submit();
    out.submitted = true;
    out.step = 'submit';
    return new Promise(function(resolve) {
      setTimeout(function() {
        out.afterUrl = String(location.href || '');
        var done = out.afterUrl.indexOf('show_ignore_list') !== -1 && /無視リストから削除/.test(doc.body ? doc.body.innerText : '');
        out.ok = done;
        out.note = out.ok ? '已解除 ' + out.checked + ' 条忽略（' + out.removedIds.join(',') + '），列表已清零。' : '已提交解除，未检测到成功文案，请人工确认。';
        resolve(out);
      }, 4000);
    });
  }
  out.reason = 'unknown-action';
  out.note = '未知 action=' + O.action + '（支持 list/ignore/unignore）';
  return Promise.resolve(out);
})(__URL__, __IGNORE_OPTS__);
