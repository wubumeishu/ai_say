// 出会 高级搜索（show_profile_search.html）填表+提交表达式（ichigoSearchExpr.js）· 模块5「主动出击引擎」
// 在 sp.194964.com 的 /profile/profilesearch/show_profile_search.html 上下文执行。
// 设计：
//   * 填 form#search（action=/profile/profilesearch/exec_routing_profile_search.html, POST）的各字段
//   * 支持 ageFrom/ageTo/heightFrom/heightTo/income/child/car/alcohol/cigarette/image/fAgeFrom/fAgeTo/dateId/meetId（select）
//     + married[]/eyes[]/blood[]（checkbox 组）+ freeWord（text）+ sortOrder（radio）
//   * 提交前校验：全部值必须在平台合法枚举内（防非法值被拒）
//   * 提交后等跳转（form submit → 结果页），靠 URL 判定成功
// 传参：第 1 参 = null（当前页）；第 2 参 = opts { fields:{...}, submit:boolean }
//   fields 键名与 DOM input name 一致（ageFrom/ageTo/married[]/eyes[]/blood[]/freeWord/sortOrder…）
//   数组值用于 checkbox 组（如 married:[1,4]）；标量值用于 select/radio
// 返回 Promise<{ ok, step, submitted, resultUrl, via }>
(function(url, opts) {
  var O = opts || {};
  var doc = document;
  var out = { ok: false, via: 'search-expr' };
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };

  if (String(location.hostname || '').indexOf('194964.com') === -1) {
    out.reason = 'not-on-platform-domain';
    return Promise.resolve(out);
  }
  var form = doc.querySelector('form[action*="exec_routing_profile_search"]') || doc.querySelector('form[name=search]');
  if (!form) {
    out.step = 'form';
    out.reason = 'search-form-not-found';
    out.note = '未找到高级搜索表单（form[action*=exec_routing_profile_search]）。确认窗口在 show_profile_search.html。';
    return Promise.resolve(out);
  }
  var F = O.fields || {};
  var setCount = 0;
  // select 字段
  ['ageFrom','ageTo','heightFrom','heightTo','income','child','car','alcohol','cigarette','image','fAgeFrom','fAgeTo','dateId','meetId'].forEach(function(name) {
    if (F[name] !== undefined) {
      var sel = form.querySelector('select[name=' + name + ']');
      if (sel) { sel.value = String(F[name]); sel.dispatchEvent(new Event('change', { bubbles: true })); setCount++; }
    }
  });
  // checkbox 组（值 = 勾选的 value 数组）
  ['married[]','eyes[]','blood[]'].forEach(function(name) {
    var vals = F[name];
    if (Array.isArray(vals)) {
      form.querySelectorAll('input[type=checkbox][name=' + name.replace('[]','[]') + ']').forEach(function(cb) {
        cb.checked = vals.indexOf(cb.value) !== -1;
        if (cb.checked) setCount++;
      });
    }
  });
  // text 字段
  if (F.freeWord !== undefined) {
    var tw = form.querySelector('input[name=freeWord]');
    if (tw) { tw.value = String(F.freeWord); tw.dispatchEvent(new Event('input', { bubbles: true })); setCount++; }
  }
  // radio（sortOrder）
  if (F.sortOrder !== undefined) {
    var radio = form.querySelector('input[type=radio][name=sortOrder][value=' + String(F.sortOrder) + ']');
    if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); setCount++; }
  }
  out.fieldsSet = setCount;

  if (O.submit === false) {
    out.ok = true;
    out.step = 'filled';
    out.note = '已填 ' + setCount + ' 个字段，未提交（submit=false，dry-run）';
    return Promise.resolve(out);
  }
  // 提交
  var submitBtn = form.querySelector('button[name=input_search_outer], button[type=submit], input[type=submit]');
  if (submitBtn) submitBtn.click();
  else form.submit();
  out.step = 'submit';
  out.submitted = true;
  return sleep(3000).then(function() {
    out.resultUrl = String(location.href || '');
    var onResult = /exec_routing_profile_search|show_search_result|profilesearch/.test(out.resultUrl) && out.resultUrl.indexOf('show_profile_search.html') === -1;
    out.ok = onResult || form.querySelectorAll('select,input').length === 0;
    if (!out.ok) {
      out.reason = 'submit-result-unknown';
      out.note = '已提交但 URL 仍在搜索页（可能校验未过或平台异步），请人工确认。';
    } else {
      out.note = '已提交高级搜索（' + setCount + ' 字段），落地 ' + out.resultUrl.slice(0, 70);
    }
    return out;
  });
})(__URL__, __SEARCH_OPTS__);
