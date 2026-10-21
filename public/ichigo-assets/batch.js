// 模块1 · 出会批量操作栏（归档/拉黑/恢复）+ 编辑模式 + 已归档过滤
// 职责：
//   ① 「编辑」按钮切换多选模式（checkbox 平时隐藏，编辑模式才显）
//   ② 「已归档」Tab 切换显示/隐藏归档/拉黑客户
//   ③ 勾选 → 批量栏浮现 → 归档/拉黑/恢复 → 调 POST /api/console/batch → 刷新列表
//   ④ 拉黑联动真实窗口（后端 realSync 提示 queued/blocked）
'use strict';

var SHOW_ARCHIVED = false;   // 「已归档」开关状态
var EDIT_MODE = false;       // 编辑模式状态

function selectedIds() {
  var host = document.getElementById('customerList');
  if (!host) return [];
  return Array.prototype.map.call(host.querySelectorAll('.ci-check:checked'), function(cb) {
    return cb.getAttribute('data-cid');
  });
}

function totalChecks() {
  var host = document.getElementById('customerList');
  if (!host) return 0;
  return host.querySelectorAll('.ci-check').length;
}

function updateBar() {
  var bar = document.getElementById('batchBar');
  var cnt = document.getElementById('batchCount');
  if (!bar) return;
  var ids = selectedIds();
  var total = totalChecks();
  // 批量栏：编辑模式下且有勾选时显示；或全选状态下显示
  bar.style.display = (EDIT_MODE && (ids.length || total > 0)) ? 'flex' : 'none';
  if (cnt) cnt.textContent = '已选 ' + ids.length + ' / ' + total;
  var all = document.getElementById('batchAll');
  if (all) all.checked = total > 0 && ids.length === total;
}

// 重拉列表（支持 includeArchived 参数）
function refreshList() {
  var qs = '/api/console/mailbox?force=1' + (SHOW_ARCHIVED ? '&includeArchived=1' : '');
  fetch(qs).then(function(r) { return r.json(); }).then(function(mj) {
    if (mj.ok && Array.isArray(mj.contacts)) {
      state.contacts = mj.contacts;
      state.unread = mj.unread || 0;
      // 渲染：已归档/拉黑客户加 .is-archived 类（卡片灰显）
      if (typeof renderList === 'function') renderList();
      if (typeof updateBadge === 'function') updateBadge();
      updateBar();
    }
  });
}

// 调批量 API + 处理 realSync 提示（拉黑联动真实窗口）
function callBatch(action, ids) {
  if (!ids.length) return;
  var verb = { archive: '归档', blacklist: '拉黑', restore: '恢复' }[action] || action;
  fetch('/api/console/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: action, contactIds: ids })
  })
  .then(function(r) { return r.json(); })
  .then(function(j) {
    if (!j.ok) {
      if (typeof toast === 'function') toast('批量操作失败：' + (j.msg || j.reason || '未知'), false);
      return;
    }
    var msg = (j.updated || 0) + ' 位客户已' + verb;
    // 拉黑：提示真实窗口联动状态（realSync）
    if (action === 'blacklist' && j.realSync) {
      var rs = j.realSync;
      if (rs.blocked > 0) msg += ' · 真实拉黑 ' + rs.blocked + ' 位';
      if (rs.queued > 0) msg += ' · ' + rs.queued + ' 位待同步到窗口';
      if (rs.failed > 0) msg += ' · ' + rs.failed + ' 位失败';
      // 详细 toast（拉黑场景给完整提示）
      if (typeof toast === 'function') {
        var detail = rs.detail ? rs.detail.map(function(d) {
          var c = state.contacts.find(function(x) { return x.contactId === d.contactId; });
          return (c ? c.name : d.contactId.slice(0,8)) + ': ' + d.status + (d.note ? '（' + d.note + '）' : '');
        }).join('；') : '';
        toast(msg + (detail ? '\n' + detail : ''), rs.blocked > 0, 5000);
      }
    } else if (typeof toast === 'function') {
      toast(msg, true);
    }
    refreshList();
  })
  .catch(function(e) {
    if (typeof toast === 'function') toast('批量请求失败：' + e.message, false);
  });
}

// ① 编辑模式切换
function toggleEdit() {
  EDIT_MODE = !EDIT_MODE;
  var col = document.getElementById('colCustomers');
  var btn = document.getElementById('batchToggle');
  if (col) col.classList.toggle('editing', EDIT_MODE);
  if (btn) {
    btn.classList.toggle('active', EDIT_MODE);
    btn.textContent = EDIT_MODE ? '✓ 完成' : '✎ 编辑';
    btn.title = EDIT_MODE ? '退出编辑模式' : '进入编辑模式（复选框 + 批量操作）';
  }
  if (!EDIT_MODE) {
    // 退出编辑：清空勾选
    var host = document.getElementById('customerList');
    if (host) {
      host.querySelectorAll('.ci-check:checked').forEach(function(cb) {
        cb.checked = false;
        var item = cb.closest('.cust-item');
        if (item) item.classList.remove('selected');
      });
    }
  }
  updateBar();
}

// ② 已归档 Tab 切换
function toggleArchived() {
  SHOW_ARCHIVED = !SHOW_ARCHIVED;
  var btn = document.getElementById('archivedToggle');
  if (btn) btn.classList.toggle('archived-on', SHOW_ARCHIVED);
  if (btn) btn.textContent = SHOW_ARCHIVED ? '📁 显示归档中' : '📁 已归档';
  refreshList();
}

export function initBatchBar() {
  // 编辑按钮
  var bEdit = document.getElementById('batchToggle');
  if (bEdit) bEdit.addEventListener('click', toggleEdit);

  // 已归档 Tab
  var bArch = document.getElementById('archivedToggle');
  if (bArch) bArch.addEventListener('click', toggleArchived);

  // 全选
  var all = document.getElementById('batchAll');
  if (all) all.addEventListener('change', function() {
    var host = document.getElementById('customerList');
    if (!host) return;
    host.querySelectorAll('.ci-check').forEach(function(cb) {
      cb.checked = all.checked;
      var item = cb.closest('.cust-item');
      if (item) item.classList.toggle('selected', all.checked);
    });
    updateBar();
  });

  // 归档
  var bArc = document.getElementById('batchArchive');
  if (bArc) bArc.addEventListener('click', function() {
    var ids = selectedIds();
    if (ids.length && confirm('确认归档 ' + ids.length + ' 位客户？归档后主列表隐藏（备份保留，可恢复）。')) {
      callBatch('archive', ids);
    }
  });

  // 拉黑（联动真实窗口）
  var bBl = document.getElementById('batchBlacklist');
  if (bBl) bBl.addEventListener('click', function() {
    var ids = selectedIds();
    if (!ids.length) return;
    if (confirm('确认拉黑 ' + ids.length + ' 位客户？\n拉黑会同时在真实窗口触发屏蔽（CDP）；DB 已打标。')) {
      callBatch('blacklist', ids);
    }
  });

  // 恢复
  var bRest = document.getElementById('batchRestore');
  if (bRest) bRest.addEventListener('click', function() { callBatch('restore', selectedIds()); });

  // 取消勾选
  var bClear = document.getElementById('batchClear');
  if (bClear) bClear.addEventListener('click', function() {
    var host = document.getElementById('customerList');
    if (!host) return;
    host.querySelectorAll('.ci-check:checked').forEach(function(cb) {
      cb.checked = false;
      var item = cb.closest('.cust-item');
      if (item) item.classList.remove('selected');
    });
    updateBar();
  });

  // 暴露给 ichigo.js 的 checkbox onchange 委托
  window.__onBatchSelectionChanged = updateBar;
}
