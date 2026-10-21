// 出会拉黑/删除表达式（ichigoBlockExpr.js）· 真实 DOM 3 步链路
// 在收件箱（show_mailbox.html）页执行，不导航到资料页：
//   Step1：点「編集」按钮 <a href="/mail/inbox/show_mailbox.html?..."><p class="bgLightBlue2">編集</p></a>
//   Step2：在列表里按客户名称定位 <label for="checkboxN"><span class="box"></span></label> 并勾选
//   Step3：点底部 <button type="submit" class="button width70">チェックを削除する</button> 确认删除
// 传参：第 1 参 = null（当前页）；第 2 参 = 客户显示名（运行时由 fillUrl 注入）
(function(url, customerName) {
  var doc = document;
  var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

  // ---- Step1：点「編集」进编辑模式 ----
  var editLinks = doc.querySelectorAll('a p.bgLightBlue2');
  var editBtn = null;
  for (var i = 0; i < editLinks.length; i++) {
    if (String(editLinks[i].textContent || '').trim() === '編集') { editBtn = editLinks[i].closest('a') || editLinks[i]; break; }
  }
  if (!editBtn) {
    // 兜底：href 含 show_mailbox 且文本为 編集
    var as = doc.querySelectorAll('a[href*="show_mailbox"]');
    for (var k = 0; k < as.length; k++) {
      if (String(as[k].textContent || '').trim().indexOf('編集') !== -1) { editBtn = as[k]; break; }
    }
  }
  if (!editBtn) return { ok: false, step: 'edit', reason: 'edit-btn-not-found', note: '收件箱未找到「編集」按钮（确认窗口在 show_mailbox.html 页）' };
  editBtn.click();

  return sleep(800).then(function() {
    // ---- Step2：按客户名称勾选对应 checkbox ----
    var labels = doc.querySelectorAll('label[for^="checkbox"]');
    var foundIdx = -1;
    var foundName = '';
    if (customerName) {
      for (var m = 0; m < labels.length; m++) {
        var lab = labels[m];
        var nameEl = lab.parentElement ? lab.parentElement : lab;
        // 客户名通常在 label 的兄弟节点（列表行结构：.box + 名称块）
        var text = String((nameEl.textContent || '') + ' ' + (lab.parentElement ? lab.parentElement.textContent : '')).trim();
        if (text.indexOf(customerName) !== -1) { foundIdx = m; foundName = customerName; break; }
      }
      // 兜底：直接看 label 自身的文本/相邻
      if (foundIdx === -1) {
        for (var n = 0; n < labels.length; n++) {
          var lb = labels[n];
          var rowText = lb.closest('tr, .mailList, div') ? String(lb.closest('tr, .mailList, div').textContent || '') : '';
          if (rowText.indexOf(customerName) !== -1) { foundIdx = n; foundName = customerName; break; }
        }
      }
    }
    var targetLabel = foundIdx >= 0 ? labels[foundIdx] : null;
    if (!targetLabel) {
      return { ok: false, step: 'checkbox', reason: 'customer-not-in-list', found: foundIdx, total: labels.length, note: '编辑模式下未找到「' + customerName + '」的复选框（可能该客户已不在收件箱/名称不匹配）' };
    }
    targetLabel.click();

    return sleep(500).then(function() {
      // ---- Step3：点「チェックを削除する」确认删除 ----
      var delBtn = null;
      var btns = doc.querySelectorAll('button[type="submit"]');
      for (var p = 0; p < btns.length; p++) {
        if (String(btns[p].textContent || '').trim().indexOf('チェックを削除する') !== -1) { delBtn = btns[p]; break; }
      }
      if (!delBtn) {
        var by = doc.querySelectorAll('.button.width70, button[class*="width70"]');
        for (var q = 0; q < by.length; q++) {
          if (String(by[q].textContent || '').trim().indexOf('削除') !== -1) { delBtn = by[q]; break; }
        }
      }
      if (!delBtn) return { ok: false, step: 'delete', reason: 'delete-btn-not-found', note: '未找到「チェックを削除する」删除按钮' };
      delBtn.click();
      return sleep(800).then(function() {
        return {
          ok: true,
          step: 'deleted',
          matched: foundName,
          checkboxIndex: foundIdx,
          note: '已在真实窗口删除「' + foundName + '」（checkbox' + foundIdx + ' → チェックを削除する）',
          checkboxCount: labels.length
        };
      });
    });
  });
})(__URL__, __CUSTOMER_NAME__);
