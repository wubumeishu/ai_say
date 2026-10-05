function normalizeText(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

const PAGE_SCAN_JS = `
(function () {
  function clean(value) {
    return String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      var tag = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(tag + '#' + node.id);
        break;
      }
      if (node.name) {
        parts.unshift(tag + '[name=' + JSON.stringify(node.name) + ']');
      } else if (node.className && typeof node.className === 'string') {
        var cls = node.className.trim().split(/\\s+/).slice(0, 2).join('.');
        parts.unshift(cls ? tag + '.' + cls : tag);
      } else {
        parts.unshift(tag);
      }
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function labelFor(el) {
    if (!el) return '';
    if (el.id) {
      var byFor = document.querySelector('label[for="' + el.id + '"]');
      if (byFor) {
        var byForText = clean(byFor.innerText || byFor.textContent);
        if (byForText) return byForText;
      }
    }
    var prev = el.previousElementSibling;
    var hops = 0;
    while (prev && hops < 3) {
      var prevText = clean(prev.innerText || prev.textContent);
      if (prevText && prevText.length < 60 && !/[\\n]/.test(prevText)) return prevText;
      prev = prev.previousElementSibling;
      hops += 1;
    }
    var parent = el.parentElement;
    var phops = 0;
    while (parent && phops < 5) {
      var caption = parent.querySelector('label, .label, .field-label, .title, h1, h2, h3, h4, .name, dt, legend');
      if (caption) {
        var captionText = clean(caption.innerText || caption.textContent);
        if (captionText && captionText.length < 60) return captionText;
      }
      parent = parent.parentElement;
      phops += 1;
    }
    var attrs = [el.getAttribute && el.getAttribute('placeholder'), el.name, el.id, el.getAttribute && el.getAttribute('aria-label')].filter(Boolean);
    return attrs.join(' / ').slice(0, 80);
  }

  function groupFor(el) {
    var parent = el.parentElement;
    var hops = 0;
    while (parent && hops < 7) {
      var heading = parent.querySelector('h2, h3, h4, .title, .section-title, [class*=section], [class*=group], [class*=block], [class*=card]');
      if (heading) {
        var headingText = clean(heading.innerText || heading.textContent);
        if (headingText && headingText.length < 60) return headingText;
      }
      parent = parent.parentElement;
      hops += 1;
    }
    return '';
  }

  var controls = [];
  var seen = {};

  function pushControl(control) {
    if (!control) return;
    if (!control.label) control.label = control.name || control.id || " (unlabeled) ";
    var key = [control.group || "", control.label, control.type || ""].join('|');
    if (seen[key]) return;
    seen[key] = true;
    controls.push(control);
}

  var rawInputs = document.querySelectorAll('input, textarea, select');
  for (var i = 0; i < rawInputs.length; i += 1) {
    var el = rawInputs[i];
    var tag = el.tagName.toLowerCase();
    var type = (el.type || (tag === 'select' ? 'select' : 'text')).toLowerCase();
    var value = '';
    var options = [];

    if (tag === 'select') {
      value = el.value || '';
      options = Array.prototype.slice.call(el.options || []).map(function(opt) {
        return {
          value: opt.value || '',
          label: clean(opt.innerText || opt.textContent),
          selected: !!opt.selected
        };
      });
    } else if (tag === 'textarea') {
      type = 'textarea';
      value = el.value || '';
    } else if (type === 'checkbox' || type === 'radio') {
      value = el.checked ? 'true' : 'false';
    } else {
      value = el.value !== undefined ? el.value : '';
    }

    pushControl({
      tag: tag,
      type: type,
      name: el.name || el.id || '',
      id: el.id || '',
      label: labelFor(el),
      group: groupFor(el),
      value: value,
      options: options,
      hasOptions: !!options.length,
      optionsText: options.map(function(opt) { return opt.label || opt.value; }).join(' | '),
      selector: cssPath(el),
      readonly: !!el.readOnly,
      disabled: !!el.disabled,
      required: !!el.required,
      placeholder: el.placeholder || '',
      maxLength: el.maxLength || ''
    });
  }

  var fieldLike = document.querySelectorAll('[class*=field], [class*=item], .form-item, .profile-item, .setting-item, .detail-item, .row, .list-item');
  for (var f = 0; f < fieldLike.length; f += 1) {
    var box = fieldLike[f];
    var boxText = clean(box.innerText || box.textContent);
    if (!boxText || boxText.length > 180 || boxText.length < 4) continue;
    var innerInput = box.querySelector('input, textarea, select, [contenteditable=true]');
    var valueEl = box.querySelector('.value, .field-value, [class*=value], dd, .content, .answer');
    var labelEl = box.querySelector('label, .label, .field-label, .name, dt, .key, [class*=label]');
    var groupText = groupFor(box);
    var label = labelEl ? clean(labelEl.innerText || labelEl.textContent) : '';
    var fallbackLabel = '';
    var pieces = boxText.split(/\\s{2,}|-{1,3}|：|:|\\s\\|\\s/).map(function(part) { return clean(part); }).filter(Boolean);
    if (!label && pieces.length >= 2) {
      fallbackLabel = pieces[0];
    }
    if (!label && !fallbackLabel) continue;
    var nextValue = innerInput ? String(innerInput.value !== undefined ? innerInput.value : '') : (valueEl ? clean(valueEl.innerText || valueEl.textContent) : (pieces.length >= 2 ? pieces.slice(1).join(' ') : ''));
    var controlType = innerInput ? ((innerInput.tagName || '').toLowerCase() === 'select' ? 'select' : ((innerInput.type || 'text').toLowerCase() === 'textarea' ? 'textarea' : 'input')) : (valueEl ? 'text' : 'link');
    var key = [groupText, label || fallbackLabel, controlType].join('|');
    if (seen[key]) continue;
    seen[key] = true;
    controls.push({
      tag: innerInput ? innerInput.tagName.toLowerCase() : (valueEl ? valueEl.tagName.toLowerCase() : box.tagName.toLowerCase()),
      type: controlType,
      name: innerInput ? (innerInput.name || innerInput.id || '') : '',
      id: innerInput ? (innerInput.id || '') : (valueEl ? (valueEl.id || '') : ''),
      label: label || fallbackLabel,
      group: groupText,
      value: nextValue,
      options: [],
      hasOptions: false,
      optionsText: '',
      selector: cssPath(innerInput || valueEl || box),
      readonly: controlType !== 'input' && controlType !== 'select' && controlType !== 'textarea',
      disabled: false,
      required: false,
      placeholder: innerInput ? (innerInput.placeholder || '') : '',
      maxLength: ''
    });
  }

  // View-mode profile fields: label + value text pairs inside block rows
  var rowEls = document.querySelectorAll(".block, .block-row, .item-row, [class*=row], [class*=item], [class*=block]");
  for (var rp = 0; rp < rowEls.length; rp += 1) {
    var row = rowEls[rp];
    var rowText = clean(row.innerText || row.textContent || "");
    if (!rowText || rowText.length > 120 || rowText.length < 3) continue;
    if (row.querySelector("input, textarea, select, [contenteditable=true]")) continue;
    var innerRows = row.querySelectorAll(".block-row, .row, [class*=row]");
    var labelEl = null, valueEl = null;
    if (innerRows.length >= 2) {
      labelEl = innerRows[0];
      valueEl = innerRows[1];
    } else {
      var pieces = rowText.split(" ").filter(Boolean);
      if (pieces.length < 2) continue;
    }
    var label = labelEl ? clean(labelEl.innerText || labelEl.textContent) : "";
    var value = valueEl ? clean(valueEl.innerText || valueEl.textContent) : "";
    if (!label && !value) continue;
    var key = [groupFor(row), label, value].join("|");
    if (seen[key]) continue;
    seen[key] = true;
    controls.push({
      tag: "text-pair",
      type: "text",
      name: "",
      id: "",
      label: label || value,
      group: groupFor(row),
      value: value,
      options: [],
      hasOptions: false,
      optionsText: "",
      selector: cssPath(row),
      readonly: true,
      disabled: false,
      required: false,
      placeholder: "",
      maxLength: ""
    });
  }
  var nextActions = [];
  var buttons = document.querySelectorAll('button, a, [role=button], [class*=btn], [class*=button], .clickable');
  for (var b = 0; b < buttons.length; b += 1) {
    var btn = buttons[b];
    var btnText = clean(btn.innerText || btn.textContent);
    if (!btnText || btnText.length > 80) continue;
    var href = btn.href || (btn.getAttribute ? (btn.getAttribute('href') || '') : '');
    var dataHref = btn.getAttribute ? (btn.getAttribute('data-href') || btn.getAttribute('data-url') || '') : '';
    var target = href || dataHref;
    var meaningful = /設定|変更|追加|編集|保存|登録|profile|account|mypage|my-page|setting|settings|next|continue|submit|apply|edit/i.test(btnText + ' ' + target) || target;
    if (!meaningful) continue;
    nextActions.push({
      label: btnText,
      url: target,
      tag: btn.tagName.toLowerCase(),
      type: btn.type || '',
      className: typeof btn.className === 'string' ? btn.className.slice(0, 120) : '',
      selector: cssPath(btn),
      disabled: !!btn.disabled
    });
  }

  var sections = [];
  var sectionEls = document.querySelectorAll('h1, h2, h3, h4, .title, .section-title, [class*=section], [class*=group], [class*=card]');
  for (var s = 0; s < sectionEls.length; s += 1) {
    var sectionText = clean(sectionEls[s].innerText || sectionEls[s].textContent);
    if (sectionText && sectionText.length < 60 && !sections.some(function(item) { return item.title === sectionText; })) {
      sections.push({ title: sectionText, tag: sectionEls[s].tagName.toLowerCase() });
    }
  }

  var bodyText = (document.body && document.body.innerText) || '';
  var lines = bodyText.split('\\n').map(function(line) { return clean(line); }).filter(Boolean);

  function uniqueButtons() {
    var out = [];
    for (var n = 0; n < nextActions.length; n += 1) {
      if (nextActions[n].label && out.indexOf(nextActions[n].label) === -1) out.push(nextActions[n].label);
    }
    return out.slice(0, 80);
  }

    var bottomNav = [];
  var bottomNavItems = document.querySelectorAll('.bottom-nav-item, [class*=bottom-nav-item], [class*=bottomNav] .nav-item, [class*=bottom-nav] [class*=nav-item]');
  for (var bni = 0; bni < bottomNavItems.length; bni += 1) {
    var navItem = bottomNavItems[bni];
    var labelEl = navItem.querySelector('.bottom-nav-item-txt, .nav-type, [class*=nav-item-txt], [class*=nav-txt], a, span') || navItem;
    var badgeEl = navItem.querySelector('.caution, [class*=caution], .badge, [class*=badge], .count, [class*=count], [class*=num], [class*=number]');
    var linkEl = navItem.querySelector('a') || (navItem.tagName === 'A' ? navItem : null);
    var navLabel = clean(labelEl ? (labelEl.innerText || labelEl.textContent || '') : '');
    var badgeText = badgeEl ? clean(badgeEl.innerText || badgeEl.textContent || '') : '';
    var navUrl = linkEl ? (linkEl.getAttribute('href') || linkEl.href || '') : '';
    var navActive = /(^|\s)active(\s|$)/.test(navItem.className || '') || /(^|\s)selected(\s|$)/.test(navItem.className || '');
    if (!navLabel && !navUrl && !badgeText) continue;
    bottomNav.push({ label: navLabel, badge: badgeText, badgeText: badgeText, url: navUrl, selector: cssPath(navItem), active: navActive });
  }
  if (!bottomNav.length) {
    var fallbackNavLinks = document.querySelectorAll('.nav-type, [class*=bottom-nav] a, [class*=bottom-nav-item] a, a[href*=/sns/], a[href*=message], a[href*=snstype], a[href*=mypage]');
    for (var fni = 0; fni < fallbackNavLinks.length; fni += 1) {
      var fl = fallbackNavLinks[fni];
      var flHost = (fl.closest && (fl.closest('.bottom-nav-item, [class*=bottom-nav-item], [class*=bottom-nav]'))) || fl.parentElement || fl;
      var flLabel = clean(fl.innerText || fl.textContent || '');
      var flBadgeEl = flHost ? flHost.querySelector('.caution, [class*=caution], .badge, [class*=badge], .count, [class*=count]') : null;
      var flBadgeText = flBadgeEl ? clean(flBadgeEl.innerText || flBadgeEl.textContent || '') : '';
      var flUrl = fl.getAttribute('href') || fl.href || '';
      if (!flLabel && !flUrl && !flBadgeText) continue;
      var flActive = /(^|\s)active(\s|$)/.test(flHost.className || '');
      bottomNav.push({ label: flLabel, badge: flBadgeText, badgeText: flBadgeText, url: flUrl, selector: cssPath(fl), active: flActive });
    }
  }

  // View-mode known-label pairs: detect profile fields from body text
  var KNOWN_LABELS = ['\u30cb\u30c3\u30af\u30cd\u30fc\u30e0','\u3042\u306a\u305f\u306e\u8a95\u751f\u65e5','\u8eab\u9577','\u30b9\u30bf\u30a4\u30eb','\u8840\u6db2\u578b','\u3042\u306a\u305f\u306e\u30bf\u30a4\u30d7','\u3088\u304f\u904a\u3076\u5730\u57df','\u4ea4\u969b\u30b9\u30c6\u30fc\u30bf\u30b9','\u51fa\u8eab\u5730','\u8077\u696d','\u5e74\u53ce','\u661f\u5ea7','\u30bf\u30d0\u30b3','\u304a\u9152','\u5b50\u4f9b','\u76ee','\u6687\u306a\u6642\u9593','\u597d\u307f\u306e\u5e74\u9f62','\u597d\u307f\u306e\u30b9\u30bf\u30a4\u30eb','\u30b9\u30ea\u30fc\u30b5\u30a4\u30ba','\u30ab\u30c3\u30d7','\u30c7\u30fc\u30c8\u3067\u3057\u305f\u3044\u3053\u3068','\u51fa\u4f1a\u3046\u307e\u3067\u306e\u5e0c\u671b','\u81ea\u5df1\u7d39\u4ecb'];
  var bodyLines = (document.body && document.body.innerText || '').split('\\n').map(function(l){return l.replace(/\s+/g,' ').trim();}).filter(Boolean);
  for (var lp = 0; lp < bodyLines.length; lp += 1) {
    var cur = bodyLines[lp];
    var next = lp + 1 < bodyLines.length ? bodyLines[lp + 1] : '';
    if (KNOWN_LABELS.indexOf(cur) !== -1 && next && next.length >= 1 && next.length <= 40) {
      var pkey = 'pair|' + cur + '|' + next;
      if (seen[pkey]) continue;
      seen[pkey] = true;
      controls.push({
        tag: 'text-pair', type: 'text', name: '', id: '',
        label: cur, group: '', value: next,
        options: [], hasOptions: false, optionsText: '',
        selector: '', readonly: true, disabled: false, required: false, placeholder: '', maxLength: ''
      });
    }
  }

return {
    source: 'devtools-profile-scan',
    page: {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0
    },
    lines: lines.slice(0, 500),
    buttons: uniqueButtons(),
    controls: controls.slice(0, 300),
    groups: [],
    sections: sections.slice(0, 80),
    nextActions: nextActions.slice(0, 120),
    bottomNav: bottomNav,
    bottomNav: (function () {
      var items = document.querySelectorAll('.bottom-nav-item, [class*=bottom-nav-item], [class*=bottomNav] .nav-item, [class*=bottom-nav] [class*=nav-item]');
      var out = [];
      for (var bi = 0; bi < items.length; bi += 1) {
        var item = items[bi];
        var link = item.querySelector('a') || (item.tagName === 'A' ? item : null);
        var labelEl = item.querySelector('.bottom-nav-item-txt, .nav-type, [class*=nav-item-txt], [class*=nav-txt], a') || item;
        var badgeEl = item.querySelector('.caution, [class*=caution], [class*=badge], [class*=count]');
        var label = clean(labelEl ? (labelEl.innerText || labelEl.textContent || '') : '');
        var badgeText = badgeEl ? clean(badgeEl.innerText || badgeEl.textContent || '') : '';
        var url = link ? (link.getAttribute('href') || link.href || '') : '';
        var active = !!(item.className && String(item.className).indexOf('active') !== -1);
        if (!label && !url && !badgeText) continue;
        out.push({ label: label, badge: badgeText, badgeText: badgeText, url: url, selector: cssPath(item), active: active });
      }
      if (!out.length) {
        var fallback = document.querySelectorAll('.nav-type, a[href*=message], a[href*=snstype], a[href*=mypage]');
        for (var fi = 0; fi < fallback.length; fi += 1) {
          var fl = fallback[fi];
          var host = (fl.closest && (fl.closest('.bottom-nav-item') || fl.closest('[class*=bottom-nav]'))) || fl.parentElement || fl;
          var badgeEl2 = host ? host.querySelector('.caution, [class*=caution], [class*=badge], [class*=count]') : null;
          out.push({
            label: clean(fl.innerText || fl.textContent || ''),
            badge: badgeEl2 ? clean(badgeEl2.innerText || badgeEl2.textContent || '') : '',
            url: fl.getAttribute('href') || fl.href || '',
            selector: cssPath(fl),
            active: !!(host && host.className && String(host.className).indexOf('active') !== -1)
          });
        }
      }
      return out.slice(0, 24);
    })()
  };
})();
`;

const NAVIGATE_PROFILE_JS = `
(function (patterns) {
  var clean = function (value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toLowerCase();
  };
  var rawItems = Array.prototype.slice.call(document.querySelectorAll('a, button, [role=button], [class*=btn], [class*=button], .clickable, [class*=nav], li, span, div'));
  var candidates = [];
  for (var i = 0; i < rawItems.length; i += 1) {
    var el = rawItems[i];
    var text = clean(el.innerText || el.textContent || '');
    var href = clean(el.href || (el.getAttribute ? el.getAttribute('href') : '') || '');
    var score = 0;
    for (var j = 0; j < patterns.length; j += 1) {
      var p = clean(patterns[j]);
      if (!p) continue;
      var pw = p.length >= 8 ? 4 : (p.length >= 4 ? 3 : 2);
      if (href && href.indexOf(p) !== -1) score += pw;
      if (text && text === p) score += pw + 1;
      if (text && text.indexOf(p) !== -1 && text.length <= 30) score += pw - 1;
    }
    if (score === 0) continue;
    var visible = el.offsetParent !== undefined && el.offsetParent !== null;
    if (!visible) score -= 2;
    candidates.push({ el: el, score: score, text: text, href: href, textLen: text.length });
  }
  if (!candidates.length) return { ok: false, msg: '???????????????', patterns: patterns };
  candidates.sort(function (a, b) { return (b.score - a.score) || (a.textLen - b.textLen); });
  var chosen = candidates[0].el;
  var target = chosen.href || (chosen.getAttribute ? chosen.getAttribute('href') : '');
  if (target) {
    window.location.href = target;
    return { ok: true, data: { via: 'location', target: target, text: String(chosen.innerText || chosen.textContent || '').trim() } };
  }
  chosen.click();
  return { ok: true, data: { via: 'click', target: location.href, text: String(chosen.innerText || chosen.textContent || '').trim() } };
})
`;

function buildProfileScanJs() {
  return PAGE_SCAN_JS;
}

function buildNavigateProfileJs(patterns = []) {
  var safe = JSON.stringify(Array.isArray(patterns) ? patterns : [String(patterns)]);
  var fnSrc = NAVIGATE_PROFILE_JS.trim();
  return fnSrc + " (" + safe + ");";
}

function detectProfilePage(raw = {}) {
  const pageUrl = normalizeText(raw.page && raw.page.url).toLowerCase();
  const title = normalizeText(raw.page && raw.page.title).toLowerCase();
  const sections = (Array.isArray(raw.sections) ? raw.sections : []).map((item) => normalizeText(item && item.title)).join(' ');
  const controls = Array.isArray(raw.controls) ? raw.controls : [];
  const controlText = controls.map((item) => `${item.label || ''} ${item.group || ''} ${item.optionsText || ''}`).join(' ');
  const text = `${pageUrl} ${title} ${sections} ${controlText}`.toLowerCase();
  const urlLike = /show_profile|profile|mypage|my-page|account|settings|userinfo|user-info|个人|资料|账户|我的/.test(text);
  const profileLike = /(プロフィール|自己紹介|ニックネーム|誕生日|身長|血液型|交際|交際ステータス|趣味|共通点|職業|年収|出身|詳細プロフィール|大人の交際|兴趣|血型|性别|地区|年龄|身高|职业|收入|生日|资料|账户|头像|昵称)/.test(text);
  const hasControls = controls.length > 0;
  const nextActions = Array.isArray(raw.nextActions) ? raw.nextActions : [];
  const setupButtons = nextActions.filter((item) => /設定する|编辑|修改|设置|保存|submit|apply|edit/i.test(normalizeText(item && item.label))).slice(0, 12);
  return {
    score: (urlLike ? 2 : 0) + (profileLike ? 2 : 0) + (hasControls ? 1 : 0) + (setupButtons.length ? 1 : 0),
    urlLike,
    profileLike,
    hasControls,
    setupButtons,
    isLikelyProfile: (urlLike && profileLike) || (profileLike && hasControls)
  };
}

function detectNextLevelPages(raw = {}) {
  const actions = Array.isArray(raw.nextActions) ? raw.nextActions : [];
  const seen = new Set();
  const pages = actions.map((action) => ({
    label: normalizeText(action && action.label),
    url: normalizeText((action && (action.url || action.href)) || (action && action.target) || ''),
    tag: action && action.tag,
    className: action && action.className,
    selector: action && action.selector,
    disabled: !!(action && action.disabled)
  })).filter((action) => action.label || action.url);
  const grouped = [];
  for (const page of pages) {
    const key = page.url || page.label;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    grouped.push(page);
  }
  return grouped.slice(0, 80);
}

function normalizeNavLabel(label) {
  return String(label == null ? '' : label).replace(/\s+/g, ' ').trim();
}

const BOTTOM_NAV_ZH = {
  'お相手探し': '寻找对象',
  '募集': '募集',
  'メッセージ': '消息',
  'タイフ': '喜欢',
  'マイページ': '个人中心'
};

function parseBottomNav(raw = {}) {
  const items = Array.isArray(raw.bottomNav) ? raw.bottomNav : [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const label = normalizeNavLabel(item.label || item.name || item.text || '');
    const url = normalizeNavLabel(item.url || item.href || item.target || '');
    const badgeText = normalizeNavLabel(item.badgeText != null ? item.badgeText : (item.badge != null ? item.badge : ''));
    let badge = 0;
    if (badgeText) {
      const m = badgeText.match(/\d+/);
      if (m) badge = parseInt(m[0], 10);
    }
    const key = label || url || badgeText || String(out.length);
    if (seen.has(key)) continue;
    seen.add(key);
    // Determine Chinese name by URL pattern first, then label
    let zh = BOTTOM_NAV_ZH[label] || '';
    if (!zh) {
      if (/snstype|typed/i.test(url)) zh = String.fromCodePoint(0x559C, 0x6B22); // like
      if (/message|msg|mail/i.test(url)) zh = String.fromCodePoint(0x6D88, 0x606F); // message
      if (/mypage|my-page|show_profile/i.test(url)) zh = String.fromCodePoint(0x4E2A, 0x4EBA, 0x4E2D, 0x5FC3); // my page
      if (/recruit|boshu|moshikomi/i.test(url)) zh = String.fromCodePoint(0x52DF, 0x96C6); // recruiting
    }
    out.push({
      label,
      zh,
      badge,
      badgeText,
      url,
      selector: normalizeNavLabel(item.selector || ''),
      active: !!(item.active || item.selected)
    });
  }
  // Find message/like/mypage items by URL pattern (more reliable than label)
  out.message = out.find((x) => /message|msg|mail/i.test(x.url)) || out.find((x) => x.zh === String.fromCodePoint(0x6D88, 0x606F)) || null;
  out.like = out.find((x) => /snstype|typed/i.test(x.url)) || out.find((x) => x.zh === String.fromCodePoint(0x559C, 0x6B22)) || null;
  out.myPage = out.find((x) => /mypage|my-page|show_profile/i.test(x.url)) || out.find((x) => x.zh === String.fromCodePoint(0x4E2A, 0x4EBA, 0x4E2D, 0x5FC3)) || null;
  out.messageCount = out.message ? out.message.badge : 0;
  out.likeCount = out.like ? out.like.badge : 0;
  return out;
}

module.exports = {
  buildProfileScanJs,
  buildNavigateProfileJs,
  detectProfilePage,
  detectNextLevelPages,
  parseBottomNav,
  BOTTOM_NAV_ZH
};
