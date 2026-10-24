// 出会 BBS 招募帖子「删」表达式（ichigoBbsDeleteExpr.js）· 模块3 阶段2
// 在 sp.194964.com 招募历史页（show_bbs_write_list.html）上下文执行，3 步链路（2026-10-25 实测）：
//   Step1 按 targetBbsId 勾选 input[type=checkbox][name="targetBbsId[]"]（checkbox value=帖子ID）
//   Step2 点「チェックを削除」按钮（form POST show_bbs_confirm_delete.html）
//   Step3 确认页（show_bbs_confirm_delete.html，文案「一度削除すると元に戻せません」）点「削除する」
// 设计：
//   * 只删数据边界内指定的帖子 ID（传 targetBbsIds 数组），找不到 → 拒删（不盲勾）
//   * 确认页是独立 URL（非 .popup 弹窗），与拉黑 5 步链路同构
//   * 提交后必须显式回列表页（平台不一定自动跳，与拉黑实测一致）
// 传参：第 1 参 = null（当前页）；第 2 参 = opts { targetBbsIds: [id,...] }
// 返回 Promise<{ ok, step, reason, matched[], missed[], needNavBack, via }>
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
  // 确认在招募历史页（有 checkbox[name=targetBbsId[]]）
  var boxes = doc.querySelectorAll('input[type="checkbox"][name="targetBbsId[]"]');
  if (boxes.length === 0) {
    out.step = 'checkbox';
    out.reason = 'no-checkbox-on-page';
    out.note = '招募历史页未渲染 checkbox（确认窗口在 show_bbs_write_list.html 且该板块有帖子；空板块无 checkbox）';
    out.total = 0;
    return Promise.resolve(out);
  }
  // Step1：按 ID 勾选
  var idSet = {};
  ids.forEach(function(i) { idSet[i] = true; });
  var matched = [];
  var missed = [];
  for (var i = 0; i < boxes.length; i++) {
    var v = String(boxes[i].value || '');
    if (idSet[v]) {
      boxes[i].click();
      matched.push(v);
    }
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
  return sleep(500).then(function() {
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
      return out;
    }
    delBtn.click();
    out.step = 'confirm';
    // Step3：轮询确认页（最长 6s）
    var start = Date.now();
    var timer = null;
    return new Promise(function(resolve) {
      function poll() {
        var u = String(location.href || '');
        if (u.indexOf('show_bbs_confirm_delete') !== -1) {
          // 找「削除する」
          var cb = null;
          var all = doc.querySelectorAll('button, a, input[type="submit"]');
          for (var x = 0; x < all.length; x++) {
            var pt = String(all[x].textContent || all[x].value || '').trim();
            if (pt === '削除する') { cb = all[x]; break; }
          }
          if (cb) {
            cb.click();
            out.confirmed = true;
            out.needNavBack = true;
            out.ok = true;
            out.reason = '';
            out.note = '已删除 ' + matched.length + ' 帖' + (missed.length ? '（另有 ' + missed.length + ' 个 ID 不在列表未动：' + missed.join(',') + '）' : '') + '；需 deepScrape 显式回列表页验证';
            resolve(out);
            return;
          }
          out.ok = false;
          out.reason = 'confirm-btn-not-found';
          out.needNavBack = true;
          out.note = '已在确认页但找不到「削除する」按钮（DOM 可能变化），未提交删除';
          resolve(out);
          return;
        }
        // 可能无确认页直接跳回列表
        if (u.indexOf('show_bbs_write_list') !== -1) {
          out.confirmed = false;
          out.needNavBack = false;
          out.ok = true;
          out.reason = '';
          out.note = '已提交删除 ' + matched.length + ' 帖（无二次确认直接跳列表页）';
          resolve(out);
          return;
        }
        if (Date.now() - start > 6000) {
          out.ok = false;
          out.reason = 'confirm-timeout';
          out.needNavBack = true;
          out.note = '提交后 6s 未到确认页（卡在 ' + u.slice(0, 60) + '），请人工确认';
          resolve(out);
          return;
        }
        timer = setTimeout(poll, 500);
      }
      poll();
    });
  });
})(__URL__, __BBS_DELETE_OPTS__);
