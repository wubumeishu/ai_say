// Message queue / inbox list scanner.
// Runs in-page via DevTools evaluate and extracts structured per-row data from
// a message list (inbox) page. Generic across platforms: each row usually has
// an avatar image, nickname, gender icon, age, online indicator, location,
// last-message preview, timestamp, and unread badge.

function buildQueuePageScanJs() {
  return [
    '(function () {',
    '  function clean(v){ return String(v==null?"":v).replace(/\\s+/g," ").trim(); }',
    '  function visible(el){ return el ? clean(el.innerText || el.textContent || "") : ""; }',
    '  function textIn(scope, selectors){',
    '    for (var i=0;i<selectors.length;i+=1){',
    '      var found = scope.querySelector(selectors[i]);',
    '      if (found){ var t = visible(found); if (t) return t; }',
    '    }',
    '    return "";',
    '  }',
    '  function imgUrl(scope){',
    '    var img = scope.querySelector("img");',
    '    if (img){',
    '      var src = img.getAttribute("src") || img.getAttribute("data-src") || "";',
    '      if (src) return src;',
    '    }',
    '    var bg = scope.querySelector("[class*=avatar], [class*=icon], [class*=face], [class*=thumb]");',
    '    if (bg){',
    '      var style = window.getComputedStyle(bg);',
    '      var m = (style.backgroundImage||"").match(/url\\(([^)]+)\\)/);',
    '      if (m) return m[1].replace(/^["\']|["\']$/g, "");',
    '    }',
    '    return "";',
    '  }',
    '  function genderOf(scope){',
    '    var hints = (scope.getAttribute("data-gender")||"") + " " + (scope.className||"") + " " + visible(scope);',
    '    if (/\\b(man|male|男|男性|boy\\b|mal\\b)/i.test(hints)) return "男";',
    '    if (/\\b(woman|female|女|女性|girl\\b|fem\\b)/i.test(hints)) return "女";',
    '    return "";',
    '  }',
    '  function ageOf(scope){',
    '    var text = visible(scope);',
    '    var m = text.match(/(\\d{2})\\s*(岁|歳|年|years?|y\\b)/i);',
    '    if (m) return m[1];',
    '    m = text.match(/age[\\s:]*?(\\d{2})/i);',
    '    if (m) return m[1];',
    '    return "";',
    '  }',
    '  function onlineOf(scope){',
    '    var cls = ""+(scope.className||"");',
    '    var attrs = scope.getAttribute("data-online")||"";',
    '    var badge = textIn(scope, ["[class*=online] span", "[class*=status]", "[class*=dot]", "[class*=badge]"]);',
    '    if (/on\\b|online|在线|active/\\i.test(cls+attrs+badge)) return "在线";',
    '    if (/off\\b|offline|离线|inactive/\\i.test(cls+attrs+badge)) return "离线";',
    '    return badge ? badge : "";',
    '  }',
    '  function locationOf(scope){',
    '    var t = textIn(scope, ["[class*=location]", "[class*=area]", "[class*=city]", "[class*=address]", "[class*=distance]"]);',
    '    if (t) return t;',
    '    var full = visible(scope);',
    '    var m = full.match(/(北海道|青森|岩手|宫城|秋田|山形|福岛|东京|神奈川|千叶|埼玉|茨城|栃木|群马|山梨|新潟|富山|石川|福井|静冈|爱知|三重|岐阜|滋贺|京都|大阪|兵库|奈良|和歌山|鸟取|岛根|冈山|广岛|山口|德岛|香川|爱媛|高知|福冈|佐贺|长崎|熊本|大分|宫崎|鹿児|冲绳)/);',
    '    if (m) return m[0];',
    '    return "";',
    '  }',
    '  function timeOf(scope){',
    '    var t = textIn(scope, ["[class*=time]", "[class*=date]", "[class*=ago]", "[class*=timestamp]"]);',
    '    if (t) return t;',
    '    var full = visible(scope);',
    '    var m = full.match(/(\\d{1,2}:\\d{2}(?::\\d{2})?|\\d+分钟前|\\d+小时前|今天|昨天|前天|\\d{4}-\\d{1,2}-\\d{1,2}|\\d+天前)/);',
    '    if (m) return m[0];',
    '    return "";',
    '  }',
    '  var rows = [];',
    '  var candidates = document.querySelectorAll("li, [class*=row], [class*=item], [class*=list] > *, [class*=card], article");',
    '  var seen = {};',
    '  for (var i=0;i<candidates.length;i+=1){',
    '    var c = candidates[i];',
    '    if (!c) continue;',
    '    var img = c.querySelector("img");',
    '    var text = visible(c);',
    '    if (!img || !text || text.length < 2 || text.length > 400) continue;',
    '    var key = (c.className||"") + "|" + text.slice(0,40);',
    '    if (seen[key]) continue;',
    '    seen[key] = true;',
    '    var name = textIn(c, ["h1", "h2", "h3", "h4", "[class*=name]", "[class*=title]", "[class*=nick]", "[class*=user]"]);',
    '    if (!name){',
    '      var first = c.querySelector("span, div, a");',
    '      name = first ? visible(first) : "";',
    '    }',
    '    var row = {',
    '      index: rows.length,',
    '      avatar: imgUrl(c),',
    '      nickname: name || "",',
    '      gender: genderOf(c),',
    '      age: ageOf(c),',
    '      online: onlineOf(c),',
    '      location: locationOf(c),',
    '      lastMessage: textIn(c, ["[class*=preview]", "[class*=msg]", "[class*=content]", "[class*=last]", "[class*=text]"]),',
    '      time: timeOf(c),',
    '      unread: textIn(c, ["[class*=unread]", "[class*=badge]", "[class*=count]"]),',
    '      href: (function(){ var a = c.querySelector("a[href]"); return a ? (a.getAttribute("href")||a.href||"") : ""; })(),',
    '      selector: ""',
    '    };',
    '    row.selector = (function(){',
    '      if (c.id) return "#" + c.id;',
    '      var parts=[]; var n=c; var hops=0;',
    '      while(n && n.nodeType===1 && hops<4){',
    '        var tag=n.tagName.toLowerCase();',
    '        if(n.id){ parts.unshift(tag+"#"+n.id); break; }',
    '        var cls=(typeof n.className==="string" ? n.className : "").trim().split(/\\s+/).slice(0,2).join(".");',
    '        parts.unshift(cls ? tag+"."+cls : tag);',
    '        n=n.parentElement; hops+=1;',
    '      }',
    '      return parts.join(" > ");',
    '    })();',
    '    rows.push(row);',
    '  }',
    '  var pageInfo = { total: "", current: "", next: "", hasNext: false, controls: [] };',
    '  document.querySelectorAll("[class*=pagination] a, [class*=pager] a, [class*=page] button, [class*=next]").forEach(function(el){',
    '    var t = visible(el);',
    '    if (t && pageInfo.controls.indexOf(t) === -1) pageInfo.controls.push(t);',
    '    if (/next|下一页|\\i.test(t)) { pageInfo.next = t; pageInfo.hasNext = true; }',
    '  });',
    '  return {',
    '    source: "devtools-queue-scan",',
    '    page: { url: location.href, title: document.title || "", readyState: document.readyState || "" },',
    '    rows: rows.slice(0, 200),',
    '    pagination: pageInfo,',
    '    timestamp: new Date().toISOString()',
    '  };',
    '})()'
  ].join('\\n');
}

function summarizeQueuePage(raw) {
  raw = raw || {};
  const rows = (Array.isArray(raw.rows) ? raw.rows : []).map(function (r, i) {
    r = r || {};
    return {
      index: i,
      avatar: String(r.avatar || ''),
      nickname: String(r.nickname || '').trim(),
      gender: String(r.gender || '').trim(),
      age: String(r.age || '').trim(),
      online: String(r.online || '').trim(),
      location: String(r.location || '').trim(),
      lastMessage: String(r.lastMessage || '').trim(),
      time: String(r.time || '').trim(),
      unread: String(r.unread || '').trim(),
      href: String(r.href || '').trim(),
      selector: String(r.selector || '').trim()
    };
  });
  const filled = rows.filter(function (r) {
    return r.nickname || r.avatar || r.gender || r.age || r.online || r.location;
  }).length;
  return {
    ok: true,
    source: 'devtools-queue-scan',
    page: raw.page || {},
    rows: rows,
    totalRows: rows.length,
    filledRows: filled,
    pagination: raw.pagination || {},
    scannedAt: String(raw.timestamp || '')
  };
}

// ---------------------------------------------------------------------------
// M1 画像接入（task-22，纯增量导出；不改动既有 buildQueuePageScanJs/summarizeQueuePage）
//
// 扫到新客户 → extractFromProfilePage（资料页优先）→ supplementFromChat → upsertContact。
// attachProfileHook({ store }) 返回 { processNewCustomer(row, meta), extractor }：
//   row  - summarizeQueuePage 产出的客户行（nickname/age/location/lastMessage/href...）
//   meta - { contactKey?, platform?, windowId?, profilePageData?, messages? }
//           profilePageData 缺省时用行内已知字段合成一份资料页数据（资料页优先原则）。
// 未传 store（或 store=null）时 hook 不可用，调用方按旧逻辑走，不影响现有行为。
// ---------------------------------------------------------------------------

function buildSyntheticPageFromRow(row) {
  row = row || {};
  const lines = [];
  if (row.nickname) lines.push(String(row.nickname).trim());
  if (row.age) lines.push(String(row.age).trim() + '岁');
  if (row.location) lines.push(String(row.location).trim());
  if (row.lastMessage) lines.push(String(row.lastMessage).trim());
  return { lines };
}

function attachProfileHook(opts) {
  opts = opts || {};
  const store = opts.store || null;
  if (!store) return { enabled: false, processNewCustomer: function () { return null; }, extractor: null };
  const { createProfileExtractor } = require('./db/profileExtractor');
  const extractor = createProfileExtractor({ store: store });

  function processNewCustomer(row, meta) {
    meta = meta || {};
    row = row || {};
    // 资料页优先：调用方可传入真实资料页数据（profilePageData）；
    // 缺省时用队列行内已知字段合成一份最小资料页（nickname/age/location/lastMessage）。
    const profilePageData = meta.profilePageData || buildSyntheticPageFromRow(row);
    const messages = Array.isArray(meta.messages) && meta.messages.length
      ? meta.messages
      : (row.lastMessage ? [{ role: 'other', original: String(row.lastMessage), text: String(row.lastMessage) }] : []);

    const pageResult = extractor.extractFromProfilePage(profilePageData); // 资料页优先
    const chatResult = extractor.supplementFromChat(messages);            // 聊天补充
    const merged = extractor.merge(pageResult, chatResult);               // 冲突时 profile_page 胜出

    return extractor.writeProfile({
      contactKey: meta.contactKey || row.nickname || ('row_' + row.index),
      platform: meta.platform,
      windowId: meta.windowId,
      profile: merged,
    });
  }

  return { enabled: true, processNewCustomer: processNewCustomer, extractor: extractor };
}

module.exports = { buildQueuePageScanJs, summarizeQueuePage, attachProfileHook, buildSyntheticPageFromRow };
