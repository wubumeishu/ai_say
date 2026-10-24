// 出会 BBS 招募帖子「删」表达式（ichigoBbsDeleteExpr.js）· 模块3 阶段2
// 在 sp.194964.com 招募历史页（show_bbs_write_list.html）上下文执行，3 步链路（2026-10-25 实测坐实）：
//   Step1 按 targetBbsIds 勾选 input[type=checkbox][name="targetBbsId[]"]（checkbox value=帖子ID）
//   Step2 点「チェックを削除」按钮 → 平台跳确认页 show_bbs_confirm_delete.html
//   Step3 确认页里 form[action=exec_bbs_delete.html] 的「削除する」直接 form.submit()（比按钮 click 可靠）
// 设计：
//   * 只删数据边界内指定的帖子 ID（传 targetBbsIds 数组），找不到 → 拒删（不盲勾）
//   * 确认页「削除する」必须表单 action 含 exec_bbs_delete.html 且按钮文本精确「削除する」才提交（防误提交流失/取消表单）
//   * 提交后平台跳回 show_bbs_write_list.html；deepScrape 侧显式再回列表页验证 checkbox 是否消失
// 传参：第 1 参 = null（当前页）；第 2 参 = opts { targetBbsIds: [id,...] }
// 返回 Promise<{ ok, step, reason, note, matched[], missed[], confirmed, needNavBack, via }>
(function(url, opts) {
  var O = opts || {};
  var doc = document;
  var out = { ok: false, via: 'bbs-delete-expr' };
  var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

  var ids = Array.isArray(O.targetBbsIds) ? O.targetBbsIds.map(String).filter(Boolean) : [];
  if (ids.length === 0) {
    out.reason = 'no-target-ids';
    out.note = '未指定 targetBbsIds（拒绝盲删）。请传要删的帖子 ID 数组。';
    return Promise.resolve(out);
  }
  if (String(location.hostname || '').indexOf('194964.com') === -1) {
    out.reason = 'not-on-platform-domain';
    out.note = '需在 sp.194964.com 招募历史页执行（当前 ' + location.hostname + '）';
    return Promise.resolve(out);
  }
  // Step1：确认在招募历史页 + 按 ID 勾选
  var boxes = doc.querySelectorAll('input[type="checkbox"][name="targetBbsId[]"]');
  if (boxes.length === 0) {
    out.step = 'checkbox';
    out.reason = 'no-checkbox-on-page';
    out.note = '招募历史页未渲染 checkbox（确认窗口在 show_bbs_write_list.html 且该板块有帖子；空板块无 checkbox）';
    out.total = 0;
    return Promise.resolve(out);
  }
  var idSet = {};
  ids.forEach(function(i) { idSet[i] = true; });
  var matched = [];
  var missed = [];
  for (var i = 0; i < boxes.length; i++) {
    var v = String(boxes[i].value || '');
    if (idSet[v]) { boxes[i].click(); matched.push(v); }
  }
  var matchedSet = {};
  matched.forEach(function(m) { matchedSet[m] = true; });
  ids.forEach(function(i) { if (!matchedSet[i]) missed.push(i); });
  if (matched.length === 0) {
    out.step = 'checkbox';
    out.reason = 'target-not-in-list';
    out.matched = matched;
    out.missed = missed;
    out.total = boxes.length;
    out.note = '招募历史里没有指定帖子 ID（' + ids.join(',') + '，页内共 ' + boxes.length + ' 帖），拒绝删除。';
    return Promise.resolve(out);
  }
  out.matched = matched;
  out.missed = missed;

  // Step2：点「チェックを削除」
  var delBtn = null;
  var btns = doc.querySelectorAll('button, input[type="submit"]');
  for (var b = 0; b < btns.length; b++) {
    var t = String(btns[b].textContent || btns[b].value || '').trim();
    if (t === 'チェックを削除' || t === 'チェックを削除する') { delBtn = btns[b]; break; }
  }
  if (!delBtn) {
    out.step = 'delete';
    out.reason = 'delete-btn-not-found';
    out.note = '已勾选 ' + matched.length + ' 帖但找不到「チェックを削除」按钮（DOM 结构可能变化）';
    return Promise.resolve(out);
  }
  delBtn.click();
  out.step = 'confirm';

  // Step3：轮询确认页（点完删除按钮先等 2s 让跳转完成，再轮询最长 6s）
  var deadline = Date.now() + 2000; // 跳转等待
  return sleep(2000).then(function() {
    function tick() {
      var u = String(location.href || '');
      if (u.indexOf('show_bbs_confirm_delete') !== -1) {
        // 确认页：找 form action 含 exec_bbs_delete.html，且按钮文本精确「削除する」才 form.submit()
        var forms = doc.querySelectorAll('form');
        for (var f = 0; f < forms.length; f++) {
          var fa = String(forms[f].action || '');
          if (fa.indexOf('exec_bbs_delete.html') !== -1) {
            var sf = forms[f].querySelector('button[type=submit], button, input[type=submit]');
            var st = sf ? String(sf.textContent || sf.value || '').trim() : '';
            if (st === '削除する') {
              forms[f].submit();
              out.confirmed = true;
              out.ok = true;
              out.reason = '';
              out.needNavBack = true;
              out.note = '已删除 ' + matched.length + ' 帖' + (missed.length ? '（另有 ' + missed.length + ' 个 ID 不在列表未动：' + missed.join(',') + '）' : '') + '；需 deepScrape 显式回列表页验证';
              return out;
            }
          }
        }
        out.ok = false;
        out.reason = 'confirm-submit-not-found';
        out.needNavBack = true;
        out.note = '已在确认页但未找到 exec_bbs_delete.html 表单的「削除する」按钮，未提交删除（防误操作）';
        return out;
      }
      // 无确认页直接跳回列表（平台行为变化兜底）
      if (u.indexOf('show_bbs_write_list') !== -1) {
        out.confirmed = false;
        out.needNavBack = false;
        out.ok = true;
        out.reason = '';
        out.note = '已提交删除 ' + matched.length + ' 帖（无二次确认直接跳列表页）';
        return out;
      }
      if (Date.now() > deadline + 6000) {
        out.ok = false;
        out.reason = 'confirm-timeout';
        out.needNavBack = true;
        out.note = '点删除后 8s 仍未到确认页（卡在 ' + u.slice(0, 60) + '），请人工确认';
        return out;
      }
      // 继续轮询
      return sleep(500).then(tick);
    }
    return tick();
  });
})(__URL__, __BBS_DELETE_OPTS__);
