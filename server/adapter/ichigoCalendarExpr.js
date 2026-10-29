// 出会 会える日（日历）抓取+登记表达式（ichigoCalendarExpr.js）· 模块7「线下转化漏斗」
// 在 sp.194964.com 的 /calendar/show_mylist.html（我的会える日）上下文执行。
// 平台机制（总控 2026-10-25 实测坐实）：
//   * FullCalendar（#calendar.fc）渲染月历，点日期 toggle .fc-highlight
//   * 开日历：点 .popup-calendar → AJAX POST /calendar/show_mine.html（空 body）→ 回 { status:1, subject:JSON }
//   * 保存：选日期后 #saveBtn 启用 → POST /calendar/regist.html（selectDate/deleteDate/adds=prefId）
//   * 删：.day-meet-list 内 .btn-release → 确认 → AJAX POST .day-meet[data-url]=/calendar/ajax_delete_pref.html {aeruId,prefId}
// 传参：第 1 参 = null；第 2 参 = opts { action:'list'|'addDays'|'release', days:[YYYY-MM-DD], aeruId, confirmed }
(function(url, opts) {
  var O = opts || {};
  var doc = document;
  var out = { ok: false, via: 'calendar-expr' };
  if (String(location.hostname || '').indexOf('194964.com') === -1) {
    out.reason = 'not-on-platform-domain';
    return Promise.resolve(out);
  }
  if (String(location.pathname || '').indexOf('calendar') === -1) {
    out.reason = 'not-on-calendar-page';
    out.note = '需在 /calendar/show_mylist.html 执行（当前 ' + location.pathname + '）';
    return Promise.resolve(out);
  }
  if (O.action === 'list' || O.action === undefined) {
    var adds = doc.querySelector('#adds');
    out.prefId = adds ? adds.value : null;
    var lists = Array.prototype.slice.call(doc.querySelectorAll('.day-meet-list'));
    out.entries = lists.map(function(el) {
      var dayMonth = el.querySelector('.meet-daymonth');
      var area = el.querySelector('.meet-area');
      var monthEl = dayMonth ? dayMonth.querySelector('.meet-month') : null;
      var dateEl = dayMonth ? dayMonth.querySelector('.meet-date') : null;
      var dayEl = dayMonth ? dayMonth.querySelector('.meet-day') : null;
      return {
        month: monthEl ? String(monthEl.textContent||'').trim() : '',
        date: dateEl ? String(dateEl.textContent||'').trim() : '',
        day: dayEl ? String(dayEl.textContent||'').trim() : '',
        area: area ? String(area.textContent||'').trim().replace(/\s+/g,' ') : '',
        hasRelease: !!el.querySelector('.btn-release')
      };
    });
    out.count = out.entries.length;
    out.ok = true;
    out.fetchedAt = new Date().toISOString();
    if (out.count === 0) out.note = '当前无已登记会える日（.day-meet-list 数量=0）';
    return Promise.resolve(out);
  }
  if (O.action === 'addDays') {
    if (O.confirmed !== true) {
      out.step = 'guard';
      out.reason = 'not-confirmed';
      out.note = 'addDays 是强副作用，需 opts.confirmed=true。目标日 ' + JSON.stringify(O.days || []) + ' prefId=' + O.prefId;
      return Promise.resolve(out);
    }
    var days = (O.days || []).map(String).filter(function(s){ return /^\d{4}-\d{2}-\d{2}$/.test(s); });
    if (days.length === 0) { out.reason = 'no-valid-days'; out.note = 'days 需为 [YYYY-MM-DD] 数组'; return Promise.resolve(out); }
    var sel = 0;
    days.forEach(function(ds) {
      var cell = doc.querySelector('[data-date="' + ds + '"]');
      if (cell) { cell.click(); sel++; }
    });
    out.selected = sel;
    var saveBtn = doc.getElementById('saveBtn');
    if (!saveBtn) { out.reason = 'save-btn-not-found'; out.note = '未找到 #saveBtn'; return Promise.resolve(out); }
    if (saveBtn.classList.contains('disabled')) {
      out.reason = 'save-btn-disabled';
      out.note = '勾选 ' + sel + '/' + days.length + ' 日后 #saveBtn 仍 disabled（日期可能不在可选范围或 prefId 未设）';
      return Promise.resolve(out);
    }
    saveBtn.click();
    out.step = 'submit';
    out.submitted = true;
    return new Promise(function(resolve) {
      setTimeout(function() {
        out.ok = /設定しました|success/.test(doc.body ? doc.body.innerText : '');
        out.afterUrl = String(location.href || '');
        out.note = out.ok ? ('已保存 ' + sel + ' 个会える日（' + days.join(',') + '），弹「設定しました」') : '已点 #saveBtn，但未检测到成功弹窗，请人工确认。';
        resolve(out);
      }, 3000);
    });
  }
  if (O.action === 'release') {
    if (O.confirmed !== true) {
      out.step = 'guard';
      out.reason = 'not-confirmed';
      out.note = 'release 是强副作用，需 opts.confirmed=true。';
      return Promise.resolve(out);
    }
    var rel = doc.querySelector('.btn-release');
    if (!rel) { out.reason = 'no-release-btn'; out.note = '当前无 .btn-release（可能无已登记日）'; out.ok = true; return Promise.resolve(out); }
    rel.click();
    out.step = 'confirm';
    return new Promise(function(resolve) {
      setTimeout(function() {
        var okBtn = doc.querySelector('#popup-release-confirm .btn-ok');
        if (okBtn) { okBtn.click(); out.confirmedClick = true; }
        setTimeout(function() {
          out.ok = true;
          out.afterUrl = String(location.href || '');
          out.note = '已解除会える日' + (O.aeruId ? '（aeruId=' + O.aeruId + '）' : '') + '（AJAX ajax_delete_pref.html），请回列表验证。';
          resolve(out);
        }, 2500);
      }, 1000);
    });
  }
  out.reason = 'unknown-action';
  out.note = '未知 action=' + O.action + '（支持 list/addDays/release）';
  return Promise.resolve(out);
})(__URL__, __CALENDAR_OPTS__);
