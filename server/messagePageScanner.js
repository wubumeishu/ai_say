function normalizeTime(raw) {
  raw = raw || {};
  const time = raw.time || {};
  const info = {
    text: String(raw.timeText != null ? raw.timeText : (raw.timeText != undefined ? raw.timeText : '')).trim(),
    iso: String(time.iso || '').trim(),
    year: String(time.year || '').trim(),
    time: String(time.time || '').trim(),
    marker: String(time.marker || '').trim()
  };
  if (!info.marker) {
    if (/昨日|yesterday/i.test(info.text)) info.marker = 'yesterday';
    else if (/今日|今天/i.test(info.text)) info.marker = 'today';
    else if (/前天/i.test(info.text)) info.marker = 'day-before-yesterday';
  }
  if (!info.time && info.text) {
    var m = info.text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) info.time = m[1] + ':' + m[2] + ':' + (m[3] || '00');
  }
  if (!info.year && info.text) {
    var my = info.text.match(/(\d{4})(?=[^\d]|$)/);
    if (my) info.year = my[1];
  }
  info.has = !!(info.text || info.iso || info.year || info.time || info.marker);
  if (!info.iso && info.year && info.time) info.iso = info.year + ' ' + info.time;
  if (info.iso) {
    const parsed = new Date(info.iso.replace(' ', 'T') + (info.iso.length === 19 ? 'Z' : ''));
    if (!Number.isNaN(parsed.getTime())) {
      info.parsedIso = parsed.toISOString();
    }
  }
  return info;
}

function normalizeMessageItem(item, index) {
  item = item || {};
  const rawText = String(item.rawText != null ? item.rawText : (item.text != null ? item.text : '')).trim();
  const timeInfo = normalizeTime(item);
  return {
    index: index == null ? 0 : index,
    text: rawText,
    original: rawText,
    translation: '',
    time: timeInfo,
    role: String(item.role || 'unknown'),
    kind: String(item.kind || 'text'),
    url: String(item.url || ''),
    name: String(item.name || ''),
    label: String(item.label || ''),
    group: String(item.group || ''),
    selector: String(item.selector || ''),
    className: String(item.className || '')
  };
}

function detectPeerName(raw, context) {
  raw = raw || {};
  context = context || {};
  const hints = [
    String(context.peerName || ''),
    (function(){var t=String((raw.page&&raw.page.title)||'').trim();return /message|msg|chat|conversation|会話|メッセージ|message/i.test(t)?'':t;})()
  ];
  const names = Array.isArray(raw.peerNames) ? raw.peerNames : [];
  const unique = Array.from(new Set(hints.concat(names).map(function (x) { return String(x || '').trim(); }).filter(Boolean)));
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const firstNamedMsg = messages.find(function (x) { return x && x.name; });
  const firstNamed = firstNamedMsg ? String(firstNamedMsg.name) : '';
  const fallback = messages.length ? String((messages[0].text || '').split('\uff1a')[0] || '').trim() : '';
  return {
    name: firstNamed || unique[0] || fallback,
    candidates: unique.slice(0, 16),
    source: firstNamed ? 'message-item-name' : (unique[0] ? 'page-header-or-title' : 'fallback')
  };
}

function summarizeMessagePage(raw) {
  raw = raw || {};
  const messages = (Array.isArray(raw.messages) ? raw.messages : []).map(function (item, index) {
    return normalizeMessageItem(item, index);
  });
  const peer = detectPeerName(raw, {});
  const profile = Array.isArray(raw.profile)
    ? raw.profile.map(function (row) {
        return {
          label: String((row && row.label) || ''),
          value: String((row && row.value) || ''),
          selector: String((row && row.selector) || '')
        };
      })
    : [];
  const detection = {
    isLikelyMessagePage: /message|msg|chat|conversation|talk|会話|メッセージ/i.test(
      String((raw.page && raw.page.url) || '') + ' ' + String((raw.page && raw.page.title) || '')
    ) || messages.length >= 2
  };
  const page = {
    url: String((raw.page && raw.page.url) || ''),
    title: String((raw.page && raw.page.title) || ''),
    readyState: String((raw.page && raw.page.readyState) || '')
  };
  const scanAt = String(raw.timestamp || '');
  return {
    ok: true,
    source: 'devtools-message-scan',
    page: page,
    peer: peer,
    profile: profile,
    messages: messages,
    nextActions: Array.isArray(raw.nextActions) ? raw.nextActions.map(String).filter(Boolean).slice(0, 30) : [],
    bottomNav: Array.isArray(raw.bottomNav) ? raw.bottomNav : [],
    lines: Array.isArray(raw.lines) ? raw.lines : [],
    detection: detection,
    scannedAt: scanAt
  };
}

function translateMessages(messages, translate) {
  const list = Array.isArray(messages) ? messages : [];
  const fn = translate || function () {
    return Promise.resolve('');
  };
  const out = [];
  let i = 0;
  function step() {
    if (i >= list.length) return Promise.resolve(out);
    const item = list[i];
    i += 1;
    const next = (item && item.original) || (item && item.text) || '';
    return Promise.resolve(fn(String(next)))
      .catch(function () {
        return String(next);
      })
      .then(function (translation) {
        const copy = Object.assign({}, item || {});
        copy.translation = String(translation || '').trim();
        out.push(copy);
        return step();
      });
  }
  return step();
}

function buildMessagePageScanJs() {
  return [
    '(function () {',
    '  function clean(value) {',
    "    return String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();",
    '  }',
    '  function cssPath(el) {',
    "    if (!el || el.nodeType !== 1) return '';",
    "    if (el.id) return '#' + el.id;",
    '    var parts = [];',
    '    var node = el;',
    '    while (node && node.nodeType === 1 && parts.length < 5) {',
    "      var tag = node.tagName ? node.tagName.toLowerCase() : '';",
    '      if (!tag) break;',
    '      if (node.id) {',
    "        parts.unshift(tag + '#' + node.id);",
    '        break;',
    '      }',
    "      if (node.name) {",
    "        parts.unshift(tag + '[name=' + JSON.stringify(node.name) + ']');",
    "      } else if (node.className && typeof node.className === 'string') {",
    "        var cls = node.className.trim().split(/\\s+/).slice(0, 2).join('.');",
    "        parts.unshift(cls ? tag + '.' + cls : tag);",
    '      } else {',
    '        parts.unshift(tag);',
    '      }',
    '      node = node.parentElement;',
    '    }',
    "    return parts.join(' > ');",
    '  }',
    '  function visibleTextOf(el) {',
    '    return clean(el && (el.innerText || el.textContent));',
    '  }',
    '  function closestText(el, selector, maxHops) {',
    "    if (!el) return '';",
    '    var host = el.closest ? el.closest(selector) : null;',
    '    var node = host || el;',
    '    var hops = 0;',
    '    while (node && hops < (maxHops || 4)) {',
    '      var text = visibleTextOf(node);',
    '      if (text) return text;',
    '      node = node.parentElement;',
    '      hops += 1;',
    '    }',
    "    return '';",
    '  }',
    '  function looksLikeTime(value) {',
    '    var text = clean(value);',
    '    if (!text) return false;',
    "    return /^(\\d{1,4}[\\/.-]+){1,3}|\\d{1,2}:\\d{2}(?::\\d{2})?|\\u4eca|\\u6628\\u65e5|\\u4eca\\u65e5|\\u524d\\u5929|\\u5468|\\u6708|\\u65e5|time|date|sent|received/i.test(text);",
    '  }',
    '  function timeFromText(value) {',
    '    var text = clean(value);',
    '    if (!text) return {};',
    '    var out = {};',
    "    var m = text.match(/(\\d{4})[\\/.-](\\d{1,2})[\\/.-](\\d{1,2})(?:\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?/);",
    '    if (m) {',
    "      out.iso = m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0') + ' ' + (m[4] || '00') + ':' + (m[5] || '00') + ':' + (m[6] || '00');",
    '      return out;',
    '    }',
    '    m = text.match(/(\\d{4})(?=[^\\d]|$)/);',
    '    if (m) out.year = m[1];',
    "    m = text.match(/(\\d{1,2}):(\\d{2})(?::(\\d{2}))?/);",
    "    if (m) out.time = m[1] + ':' + m[2] + ':' + (m[3] || '00');",
    "    if (/\\u6628\\u65e5|yesterday/i.test(text)) out.marker = 'yesterday';",
    "    if (/\\u4eca\\u65e5|\\u4eca\\u5929/i.test(text)) out.marker = 'today';",
    "    if (/\\u524d\\u5929/i.test(text)) out.marker = 'day-before-yesterday';",
    '    return out;',
    '  }',
    '  function classifyItem(el) {',
    '    var own = visibleTextOf(el);',
    "    var near = closestText(el, '[class*=time], [class*=date], [class*=timestamp], time, .date, .time, .meta', 4);",
    '    var timeText = looksLikeTime(own) ? own : (near || \'\');',
    '    var text = clean(el.innerText || el.textContent || \'\');',
    "    var message = '';",
    "    if (text && text.length >= 3 && !/^(message|msg|type|type_list|bottom|nav|profile|my|setting|login|logout|close|cancel|confirm|\\u30e1\\u30c3\\u30bb\\u30fc\\u30b8)/i.test(text)) {",
    '      message = text;',
    '    }',
    "    var link = el.closest ? el.closest('a[href]') : null;",
    "    var url = link ? (link.getAttribute('href') || link.href || '') : '';",
    "    var classBits = String(el.className || '') + ' ' + String(el.id || '') + ' ' + String(el.dataset && JSON.stringify(el.dataset));",
    "    var isSelf = /self|mine|outgoing|sent|me|\\u81ea\\u5206|\\u63d0\\u4ef6/i.test(classBits) || false;",
    "    var isOther = /other|them|peer|incoming|\\u5f79|\\u53d7\\u4fe1|from/i.test(classBits) || false;",
    "    var role = isSelf ? 'self' : (isOther ? 'other' : 'unknown');",
    '    if (!message) role = \'unknown\';',
    '    return {',
    '      rawText: message || near || own,',
    '      timeText: timeText,',
    '      time: timeFromText(timeText),',
    '      role: role,',
    "      kind: (url ? 'link' : 'text'),",
    '      url: url,',
    '      selector: cssPath(el),',
    "      className: String(el.className || ''),",
    "      id: String(el.id || ''),",
    "      name: visibleTextOf(el.querySelector('[class*=name], .name, h2, h3, [class*=title]')) || '',",
    "      label: '',",
    "      group: ''",
    '    };',
    '  }',
    '  var items = [];',
    '  var seen = {};',
    '  function pushItem(item) {',
    '    if (!item) return;',
    "    var key = [item.role, item.rawText, item.timeText, item.url, item.selector].join('|');",
    '    if (!key || seen[key]) return;',
    '    seen[key] = true;',
    '    items.push(item);',
    '  }',
    "  var roots = document.querySelectorAll('[class*=item], [class*=row], [class*=box], [class*=card], [class*=message], [class*=chat], [class*=bubble], [class*=msg], li, article');",
    '  for (var i = 0; i < roots.length; i += 1) {',
    '    var item = classifyItem(roots[i]);',
    '    if (item.name || item.rawText || item.timeText) pushItem(item);',
    '  }',
    '  var names = [];',
    "  document.querySelectorAll('h1, h2, h3, [class*=name], [class*=title], [class*=username], [class*=nickname], [class*=peer], [class*=partner]').forEach(function (el) {",
    '    var text = visibleTextOf(el);',
    "    if (text && text.length <= 80 && names.indexOf(text) === -1) names.push(text);",
    '  });',
    '  var profileRows = [];',
    "  document.querySelectorAll('[class*=field], [class*=detail], [class*=info], [class*=profile] [class*=row], [class*=item] [class*=label], dl, table').forEach(function (box) {",
    '    var text = visibleTextOf(box);',
    "    if (!text || text.length > 120) return;",
    "    var pieces = text.split(/\\s{2,}|\\uff1a|:|\\s\\|\\s/).map(clean).filter(Boolean);",
    '    if (pieces.length >= 2) {',
    "      profileRows.push({ label: pieces[0], value: pieces.slice(1).join(' '), selector: cssPath(box) });",
    '    }',
    '  });',
    '  var nextActions = [];',
    "  document.querySelectorAll('a, button, [role=button], .clickable').forEach(function (el) {",
    '    var label = visibleTextOf(el);',
    "    var href = el.getAttribute && (el.getAttribute('href') || el.href);",
    '    if (!label && !href) return;',
    "    var host = el.closest ? el.closest('[class*=item], [class*=row], li, section') : null;",
    '    if (host && host !== el) {',
    "      host.dataset.hostMessage = host.dataset.hostMessage || '';",
    "      if (!host.dataset.hostMessage && /profile|detail|user|\\u5f79\\u65b9|\\u8a72\\u7d04|\\u8cc7\\u6599|\\u4fe1\\u606f/i.test(label + ' ' + (href || ''))) host.dataset.hostMessage = '1';",
    '    }',
    "    if (host && host.dataset.hostMessage === '1' && label && nextActions.indexOf(label) === -1) nextActions.push(label);",
    '  });',
    '  var bottomNav = [];',
    "  var navRoot = document.querySelectorAll('.bottom-nav, [class*=bottom-nav], .nav-type, [class*=nav] a, [class*=tab] a');",
    '  for (var n = 0; n < navRoot.length; n += 1) {',
    '    var navEl = navRoot[n];',
    '    var text = visibleTextOf(navEl);',
    "    var url = navEl.href || (navEl.getAttribute && navEl.getAttribute('href')) || '';",
    '    if (!text && !url) continue;',
    "    var badgeEl = navEl.querySelector ? navEl.querySelector('.caution, [class*=caution], [class*=badge], [class*=count]') : null;",
    '    bottomNav.push({ label: text, url: url, badge: badgeEl ? visibleTextOf(badgeEl) : \'\', selector: cssPath(navEl) });',
    '  }',
    '  return {',
    "    source: 'devtools-message-scan',",
    '    page: {',
    '      url: location.href,',
    '      title: document.title || \'\',',
    "      readyState: document.readyState || ''",
    '    },',
    "    lines: visibleTextOf(document.body).split('\\n').filter(Boolean).slice(0, 500),",
    '    messages: items.slice(0, 120),',
    '    peerNames: names.slice(0, 16),',
    '    profile: profileRows.slice(0, 80),',
    '    nextActions: nextActions.slice(0, 30),',
    '    bottomNav: bottomNav.slice(0, 24),',
    '    timestamp: new Date().toISOString()',
    '  };',
    '})()'
  ].join('\n');
}

module.exports = {
  buildMessagePageScanJs: buildMessagePageScanJs,
  normalizeTime: normalizeTime,
  normalizeMessageItem: normalizeMessageItem,
  detectPeerName: detectPeerName,
  summarizeMessagePage: summarizeMessagePage,
  translateMessages: translateMessages
};