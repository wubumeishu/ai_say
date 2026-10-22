// 出会拉黑/删除表达式（ichigoBlockExpr.js）· 真实 DOM 3 步链路（总控 2026-10-22 实测）
// 双模式：第 3 参 mode
//   'preflight' → 在普通收件箱页：找「編集」按钮的编辑模式 href（带 ?q= token），返回 {editHref}（不导航，避免销毁 CDP 上下文）
//   'execute'   → 在编辑模式页（已 ?q=）：Step2 按客户名勾 checkbox + Step3 点「チェックを削除する」
// 在收件箱（show_mailbox.html）页执行。
// 编辑模式真实结构（总控提供）：
//   点「編集」后 URL 变 show_mailbox.html?q=<token>，列表每项前面出现：
//     <div class="contentsContribute">
//       <div class="contentsInputContribute">
//         <input type="checkbox" name="targetReMemberId[]" id="checkbox0" value="22699378">
//         <label for="checkbox0"><span class="box"></span></label>
//       </div>
//       <div class="contentsImgContribute">...</div>
//       <div class="contentsTextContribute">
//         <p class="namelstProf"><span class="man">♂</span>ふっくんさん 36歳 三重県</p>
//         ...
//       </div>
//     </div>
//   客户名在 p.namelstProf（♂/♀ 后）；checkboxN 的 N 按列表顺序（0/1/2…）
// 3 步：
//   Step1 点「編集」<a p.bgLightBlue2>編集</a>（同站导航，浏览器自带有效 session/token）
//   Step2 在 .contentsContribute 里按客户名定位含 label[for="checkboxN"] 的那块 → 勾选
//   Step3 点底部「チェックを削除する」提交按钮
// 传参：第 1 参 = null（当前页）；第 2 参 = 客户显示名（运行时由 fillUrl 注入）
(function(url, customerName, mode) {
  var doc = document;
  var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

  // ---- Step1：点「編集」进编辑模式（同站导航，保留有效 token）----
  var editBtn = null;
  var pEls = doc.querySelectorAll('p.bgLightBlue2');
  for (var i = 0; i < pEls.length; i++) {
    if (String(pEls[i].textContent || '').trim() === '編集') {
      editBtn = pEls[i].closest('a') || pEls[i];
      break;
    }
  }
  if (!editBtn) {
    var as = doc.querySelectorAll('a[href*="show_mailbox.html?q="]');
    for (var k = 0; k < as.length; k++) {
      if (String(as[k].textContent || '').trim().indexOf('編集') !== -1) { editBtn = as[k]; break; }
    }
  }
  if (!editBtn) {
    return { ok: false, step: 'edit', reason: 'edit-btn-not-found', note: '收件箱未找到「編集」按钮（确认窗口在 show_mailbox.html 页）' };
  }
  // 预检模式：只拿编辑模式 href（不点击，避免 CDP 上下文销毁；由 deepScrape 导航）
  if (mode === 'preflight') {
    return { ok: true, step: 'preflight', editHref: editBtn.href || (editBtn.parentElement && editBtn.parentElement.href) || '', foundEditBtn: true };
  }
  // execute 模式假设已在编辑模式页（deepScrape 已导航）。若当前不在编辑模式（无 checkbox），先点 編集 触发
  var alreadyEditMode = doc.querySelectorAll('label[for^="checkbox"]').length > 0;
  if (!alreadyEditMode) {
    editBtn.click();
    return sleep(2500).then(function() {
      // 同站导航后执行当前 IIFE 上下文可能已销毁，但 CDP 会重新在编辑模式页执行；
      // 这里返回继续执行的标志，deepScrape 会在导航完成后再次调 'execute'
      return { ok: true, step: 'navigate-edit', needRetry: true, note: '已触发编辑模式导航，deepScrape 需导航完成后重新执行' };
    });
  }

  return sleep(200).then(function() {
    // ---- Step2：在 .contentsContribute 里按客户名勾选对应 checkbox ----
    // 编辑模式：每项 div.contentsContribute 内含 .contentsInputContribute > label[for="checkboxN"]
    //   + .contentsTextContribute > p.namelstProf（客户名）
    var found = null;
    var containers = doc.querySelectorAll('.contentsContribute, .contentsContribute, div');
    // 精确：找含 label[for^="checkbox"] 的最近公共祖先
    var labels = doc.querySelectorAll('label[for^="checkbox"]');
    var idx = -1;
    var matchedName = '';
    if (customerName) {
      // 方法 A：按 .contentsContribute 容器（含 checkbox + 客户名）
      var conts = doc.querySelectorAll('.contentsContribute');
      for (var c = 0; c < conts.length; c++) {
        var lab = conts[c].querySelector('label[for^="checkbox"], input[type="checkbox"]');
        var nameEl = conts[c].querySelector('.namelstProf, p');
        var text = nameEl ? String(nameEl.textContent || '') : '';
        if (lab && text.indexOf(customerName) !== -1) {
          idx = c;
          matchedName = customerName;
          found = lab;
          break;
        }
      }
      // 方法 B：label 兜底（找 label 上溯 .contentsContribute 看客户名）
      if (!found && labels.length) {
        for (var m = 0; m < labels.length; m++) {
          var box = labels[m].closest('.contentsContribute, div[class*="contents"]') || labels[m].parentElement;
          var nm = box ? String(box.textContent || '') : '';
          if (nm.indexOf(customerName) !== -1) {
            idx = m;
            matchedName = customerName;
            found = labels[m];
            break;
          }
        }
      }
      // 方法 C：按 checkbox 序号（如果 customerName 含数字或按列表第 N 个）
      if (!found && labels.length) {
        // 无法按名定位时，不盲勾第一个（避免误删），返回提示
        return {
          ok: false, step: 'checkbox', reason: 'customer-not-in-list',
          total: labels.length,
          note: '编辑模式下未找到「' + customerName + '」（共 ' + labels.length + ' 个复选框，名称不匹配）。请确认客户名与 p.namelstProf 文本一致。'
        };
      }
    }
    if (!found) {
      return { ok: false, step: 'checkbox', reason: 'no-checkbox-in-edit-mode', note: '已进入编辑模式但未找到任何复选框（labels=' + labels.length + '），平台可能未渲染 checkbox 或客户数=0' };
    }
    // 勾选（点 label，比点 input 更稳）
    found.click();

    return sleep(600).then(function() {
      // ---- Step3：点「チェックを削除する」确认删除 ----
      var delBtn = null;
      var submitBtns = doc.querySelectorAll('button[type="submit"], input[type="submit"], .button.width70');
      for (var p = 0; p < submitBtns.length; p++) {
        var txt = String(submitBtns[p].textContent || submitBtns[p].value || '').trim();
        if (txt.indexOf('チェックを削除する') !== -1 || txt.indexOf('削除') !== -1) { delBtn = submitBtns[p]; break; }
      }
      if (!delBtn) {
        // 兜底：找含 削除 文本的 button/a
        var btns2 = doc.querySelectorAll('button, a');
        for (var q = 0; q < btns2.length; q++) {
          var t2 = String(btns2[q].textContent || '').trim();
          if (t2.indexOf('削除') !== -1) { delBtn = btns2[q]; break; }
        }
      }
      if (!delBtn) {
        return {
          ok: false, step: 'delete', reason: 'delete-btn-not-found',
          checked: true, matched: matchedName,
          note: '已勾选「' + (matchedName || '未知') + '」但未找到「チェックを削除する」删除按钮（可能需二次确认弹窗）'
        };
      }
      delBtn.click();
      // 删除后平台可能有确认弹窗（"本当に削除しますか" → はい）
      return sleep(1200).then(function() {
        var confirmBtn = null;
        var pops = doc.querySelectorAll('.popup, .modal, [class*="confirm"], [class*="popup"]');
        var allBtns = doc.querySelectorAll('button, a, input[type="submit"]');
        for (var x = 0; x < allBtns.length; x++) {
          var pt = String(allBtns[x].textContent || allBtns[x].value || '').trim();
          if (pt === 'はい' || pt === 'OK' || pt.indexOf('確認') !== -1 || pt.indexOf('実行') !== -1) { confirmBtn = allBtns[x]; break; }
        }
        if (confirmBtn) { confirmBtn.click(); return sleep(800).then(function() {
          return { ok: true, step: 'deleted', matched: matchedName || customerName, checked: true, confirmed: true, note: '已在真实窗口删除「' + (matchedName || customerName) + '」并确认弹窗' };
        }); }
        return { ok: true, step: 'deleted', matched: matchedName || customerName, checked: true, confirmed: false, note: '已在真实窗口删除「' + (matchedName || customerName) + '」（无二次确认弹窗，直接提交）' };
      });
    });
  });
})(__URL__, __CUSTOMER_NAME__, __MODE__);
