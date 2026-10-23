// 出会拉黑/删除表达式（ichigoBlockExpr.js）· 真实 5 步链路（总控 2026-10-23 实测）
// 双模式：第 3 参 mode
//   'preflight' → 在普通收件箱页：找「編集」按钮的编辑模式 href（带 ?q= token），返回 {editHref}（不导航，避免销毁 CDP 上下文）
//   'execute'   → 在编辑模式页（已 ?q=）：Step2 按客户名勾 N 个 checkbox + Step3 点「チェックを削除する」
//                → Step4 检测 URL 跳到 show_mail_delete.html（二次确认页，文案列出所有勾选名字）
//                → Step5 点「削除する」确认删除
// 2026-10-23 实测关键发现：
//   1. 删除后平台不一定自动回 inbox（同时勾 2 客户时 5 次 click 都没跳转），必须 deepScrape 显式导航回收件箱
//   2. 确认页是独立 URL show_mail_delete.html（不是 .popup/.modal 弹窗），按钮文案「削除する / キャンセル」
//   3. 支持同时勾选多个 checkbox → 合并成 1 个确认页（不是逐人循环 N 次）
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
// 传参：第 1 参 = null（当前页）；第 2 参 = 客户显示名（字符串或数组，运行时由 fillUrl 注入）；第 3 参 = mode
(function(url, customerName, mode) {
  var doc = document;
  var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

  // 统一 customerNames 为数组（向后兼容：字符串 → [字符串]）
  var customerNames = (customerName === null || customerName === undefined)
    ? []
    : (Array.isArray(customerName) ? customerName.map(String).filter(Boolean) : [String(customerName)].filter(Boolean));

  // ---- Step1：先判断是否已在编辑模式页（有 checkbox 即已在编辑模式）----
  // 实测：deepScrape.blockContact 会先导航到 ?q= 编辑模式页再调 execute，
  //       此时页面里「編集」按钮可能已变「完了」或不存在，但 checkbox 已渲染。
  //       若先查 editBtn 会因按钮消失而误报 edit-btn-not-found。
  var alreadyEditMode = doc.querySelectorAll('label[for^="checkbox"]').length > 0;

  // 2026-10-23 实测：窗口可能停在 show_mail_delete.html（二次确认页残留，前次删除未走完）
  // 此时既无 checkbox 也无「編集」按钮，直接报 edit-btn-not-found 是误导。
  // 先检测并回普通 inbox（自 愈），让调用方重新走 preflight → 编辑模式链路
  if (String(location.href || '').indexOf('show_mail_delete') !== -1) {
    return {
      ok: false, step: 'stuck-confirm-page', reason: 'window-on-confirm-page',
      needNavBack: true,
      note: '窗口停在 show_mail_delete.html（前次删除的确认页残留，可能上轮未点「削除する」/「キャンセル」），deepScrape 需先回普通 inbox 再重新执行'
    };
  }


  if (mode === 'preflight') {
    // 预检模式：必须拿「編集」按钮的编辑模式 href（不点击，避免 CDP 上下文销毁；由 deepScrape 导航）
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
    return { ok: true, step: 'preflight', editHref: editBtn.href || (editBtn.parentElement && editBtn.parentElement.href) || '', foundEditBtn: true };
  }
  // execute 模式：若当前不在编辑模式（无 checkbox），先点「編集」触发导航
  if (!alreadyEditMode) {
    var editBtn2 = null;
    var pEls2 = doc.querySelectorAll('p.bgLightBlue2');
    for (var i2 = 0; i2 < pEls2.length; i2++) {
      if (String(pEls2[i2].textContent || '').trim() === '編集') {
        editBtn2 = pEls2[i2].closest('a') || pEls2[i2];
        break;
      }
    }
    if (!editBtn2) {
      var as2 = doc.querySelectorAll('a[href*="show_mailbox.html?q="]');
      for (var k2 = 0; k2 < as2.length; k2++) {
        if (String(as2[k2].textContent || '').trim().indexOf('編集') !== -1) { editBtn2 = as2[k2]; break; }
      }
    }
    if (!editBtn2) {
      return { ok: false, step: 'edit', reason: 'edit-btn-not-found', note: '收件箱未找到「編集」按钮且当前不在编辑模式（确认窗口在 show_mailbox.html 页）' };
    }
    editBtn2.click();
    return sleep(2500).then(function() {
      return { ok: true, step: 'navigate-edit', needRetry: true, note: '已触发编辑模式导航，deepScrape 需导航完成后重新执行' };
    });
  }

  return sleep(200).then(function() {
    // ---- Step2：在 .contentsContribute 里按客户名勾选 N 个 checkbox ----
    var labels = doc.querySelectorAll('label[for^="checkbox"]');
    var conts = doc.querySelectorAll('.contentsContribute');
    var checked = [];
    var missed = [];
    var totalCheckbox = labels.length;

    if (customerNames.length === 0) {
      return {
        ok: false, step: 'checkbox', reason: 'no-customer-named',
        total: totalCheckbox,
        note: '未指定客户名（customerName 为空），拒绝盲勾第一个复选框（避免误删）'
      };
    }

    // 按 .contentsContribute 容器匹配：最长匹配优先（避免短名误命中）
    for (var c = 0; c < conts.length; c++) {
      var nameEl = conts[c].querySelector('.namelstProf, p');
      var text = nameEl ? String(nameEl.textContent || '').trim() : '';
      if (!text) continue;
      var lab = conts[c].querySelector('input[type="checkbox"], label[for^="checkbox"]');
      if (!lab) continue;
      var bestMatch = '';
      for (var n = 0; n < customerNames.length; n++) {
        var nm = customerNames[n];
        if (text.indexOf(nm) !== -1 && nm.length > bestMatch.length) bestMatch = nm;
      }
      if (bestMatch) {
        lab.click();
        checked.push({ idx: c, matched: bestMatch });
      }
    }
    var matchedSet = {};
    checked.forEach(function(ch) { matchedSet[ch.matched] = true; });
    for (var mn = 0; mn < customerNames.length; mn++) {
      if (!matchedSet[customerNames[mn]]) missed.push(customerNames[mn]);
    }
    if (checked.length === 0) {
      return {
        ok: false, step: 'checkbox', reason: 'customer-not-in-list',
        total: totalCheckbox, missed: missed,
        note: '编辑模式下未找到「' + customerNames.join('、') + '」（共 ' + totalCheckbox + ' 个复选框，名称不匹配）。请确认客户名与 p.namelstProf 文本一致。'
      };
    }
    var partialMiss = missed.length > 0;

    return sleep(600).then(async function() {
      // ---- Step3：点「チェックを削除する」提交按钮 ----
      var delBtn = null;
      var submitBtns = doc.querySelectorAll('button[type="submit"], input[type="submit"], .button.width70');
      for (var p = 0; p < submitBtns.length; p++) {
        var txt = String(submitBtns[p].textContent || submitBtns[p].value || '').trim();
        if (txt.indexOf('チェックを削除する') !== -1 || txt.indexOf('削除') !== -1) { delBtn = submitBtns[p]; break; }
      }
      if (!delBtn) {
        var btns2 = doc.querySelectorAll('button, a');
        for (var q = 0; q < btns2.length; q++) {
          var t2 = String(btns2[q].textContent || '').trim();
          if (t2.indexOf('削除') !== -1) { delBtn = btns2[q]; break; }
        }
      }
      if (!delBtn) {
        return {
          ok: false, step: 'delete', reason: 'delete-btn-not-found',
          checkedCount: checked.length, matched: checked.map(function(c2) { return c2.matched; }),
          missed: missed,
          note: '已勾选 ' + checked.length + ' 位（' + checked.map(function(c2) { return c2.matched; }).join('、') + '）但未找到「チェックを削除する」删除按钮'
        };
      }
      delBtn.click();
      // ---- Step4：轮询检测二次确认页（show_mail_delete.html）----
      // 实测：button[type=submit].click() 触发 form submit 是异步的，固定 sleep(1500) 可能不够
      // （平台跳确认页的时间因网络/平台负载浮动），改为每 500ms 轮询一次、最长 6s
      var _step4 = null;
      var _pollTimer = null;
      var _pollStart = Date.now();
      _step4 = new Promise(function(resolve) {
        function poll() {
          var u = String(location.href || '');
          if (u.indexOf('show_mail_delete') !== -1) {
            resolve(true);
            return;
          }
          // 也可能平台无确认页直接跳走（回到 inbox / 其他页）
          if (u.indexOf('show_mailbox.html') !== -1 && u.indexOf('?q=') === -1) {
            resolve(false); // 已离开编辑模式，可能直接删完了
            return;
          }
          if (Date.now() - _pollStart > 6000) {
            resolve(String(location.href || '').indexOf('show_mail_delete') !== -1);
            return;
          }
          _pollTimer = setTimeout(poll, 500);
        }
        poll();
      });
      var onConfirmPage = await _step4;
      var confirmBtn = null;
      if (onConfirmPage) {
        var allBtns = doc.querySelectorAll('button, a, input[type="submit"]');
        for (var x = 0; x < allBtns.length; x++) {
          var pt = String(allBtns[x].textContent || allBtns[x].value || '').trim();
          if (pt === '削除する') { confirmBtn = allBtns[x]; break; }
        }
      } else {
        var pops = doc.querySelectorAll('.popup, .modal, [class*="confirm"], [class*="popup"]');
        var scope = (pops.length > 0 ? pops[0].querySelectorAll('button, a, input[type="submit"]') : doc.querySelectorAll('button, a, input[type="submit"]'));
        for (var y = 0; y < scope.length; y++) {
          var pt2 = String(scope[y].textContent || scope[y].value || '').trim();
          if (pt2 === 'はい' || pt2 === 'OK' || pt2.indexOf('確認') !== -1 || pt2.indexOf('実行') !== -1) { confirmBtn = scope[y]; break; }
        }
      }
      if (confirmBtn) {
        // ---- Step5：点「削除する」确认删除 ----
        confirmBtn.click();
        return sleep(1000).then(function() {
          var finalUrl = String(location.href || '');
          var stillOnConfirm = finalUrl.indexOf('show_mail_delete') !== -1;
          return {
            ok: true, step: 'deleted',
            matched: checked.map(function(c2) { return c2.matched; }),
            checkedCount: checked.length,
            missed: missed,
            partialMiss: partialMiss,
            confirmed: true,
            confirmPage: onConfirmPage,
            stillOnConfirm: stillOnConfirm,
            needNavBack: true,
            note: (partialMiss
              ? ('已真实删除 ' + checked.length + ' 位（' + checked.map(function(c2) { return c2.matched; }).join('、') + '），另有 ' + missed.length + ' 位未匹配：' + missed.join('、') + '；需 deepScrape 显式回收件箱')
              : ('已真实删除 ' + checked.length + ' 位（' + checked.map(function(c2) { return c2.matched; }).join('、') + '）；需 deepScrape 显式回收件箱'))
          };
        });
      }
      var finalUrl2 = String(location.href || '');
      var leftConfirm = finalUrl2.indexOf('show_mail_delete') === -1;
      return {
        ok: leftConfirm, step: leftConfirm ? 'deleted' : 'confirm-stuck',
        matched: checked.map(function(c2) { return c2.matched; }),
        checkedCount: checked.length,
        missed: missed,
        confirmed: false,
        confirmPage: onConfirmPage,
        needNavBack: true,
        reason: leftConfirm ? '' : 'confirm-btn-not-found',
        note: leftConfirm
          ? ('已勾选 ' + checked.length + ' 位并提交，平台无二次确认直接跳转；需 deepScrape 显式回收件箱')
          : ('已勾选 ' + checked.length + ' 位并提交，但仍在 show_mail_delete.html 未找到「削除する」按钮（DOM 结构可能变化）；需人工确认')
      };
    });
  });
})(__URL__, __CUSTOMER_NAME__, __MODE__);
