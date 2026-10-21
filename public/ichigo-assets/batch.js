// 模块 1 · 出会批量操作栏（归档/拉黑/恢复）
// 职责：监听客户列表 checkbox 勾选 → 显隐批量栏 → 调 POST /api/console/batch → 刷新列表
'use strict';

// 已勾选的 contactId 集合（DOM 复选框是数据源；本集合用于按钮点击时收集）
function selectedIds() {
  var host = document.getElementById('customerList');
  if (!host) return [];
  return Array.prototype.map.call(host.querySelectorAll('.ci-check:checked'), function(cb) {
    return cb.getAttribute('data-cid');
  });
}

function updateBar() {
  var bar = document.getElementById('batchBar');
  var cnt = document.getElementById('batchCount');
  if (!bar) return;
  var ids = selectedIds();
  bar.style.display = ids.length ? 'flex' : 'none';
  if (cnt) cnt.textContent = '已选 ' + ids.length;
  var all = document.getElementById('batchAll');
  if (all) {
    var total = document.getElementById('customerList') ? document.querySelectorAll('.ci-check').length : 0;
    all.checked = total > 0 && ids.length === total;
  }
}

// 调批量 API + 成功后重拉列表
function callBatch(action, ids) {
  if (!ids.length) return;
  fetch('/api/console/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: action, contactIds: ids })
  })
  .then(function(r) { return r.json(); })
  .then(function(j) {
    if (j.ok) {
      if (typeof toast === 'function') toast((j.updated || 0) + ' 位客户已' + ({archive:'归档',blacklist:'拉黑',restore:'恢复'})[action], j.updated > 0);
      // 归档/拉黑后：重拉列表（默认视图不含已打标客户）；恢复后：重拉
      if (typeof pollMailbox === 'function') {
        // force=1 重拉（清 90s 缓存）
        fetch('/api/console/mailbox?force=1').then(function(r) { return r.json(); }).then(function(mj) {
          if (mj.ok && Array.isArray(mj.contacts)) {
            state.contacts = mj.contacts;
            state.unread = mj.unread || 0;
            if (typeof renderList === 'function') renderList();
            if (typeof updateBadge === 'function') updateBadge();
          }
        });
      }
    } else {
      if (typeof toast === 'function') toast('批量操作失败：' + (j.msg || j.reason || '未知'), false);
    }
  })
  .catch(function(e) {
    if (typeof toast === 'function') toast('批量请求失败：' + e.message, false);
  });
}

export function initBatchBar() {
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

  var bArc = document.getElementById('batchArchive');
  if (bArc) bArc.addEventListener('click', function() { callBatch('archive', selectedIds()); });

  var bBl = document.getElementById('batchBlacklist');
  if (bBl) bBl.addEventListener('click', function() {
    var ids = selectedIds();
    if (!ids.length) return;
    if (confirm('确认拉黑 ' + ids.length + ' 位客户？拉黑后主列表默认隐藏（可「已归档」恢复）。')) {
      callBatch('blacklist', ids);
    }
  });

  var bRest = document.getElementById('batchRestore');
  if (bRest) bRest.addEventListener('click', function() { callBatch('restore', selectedIds()); });

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

  // 暴露给 ichigo.js 的 checkbox onchange 委托调
  window.__onBatchSelectionChanged = updateBar;
}
