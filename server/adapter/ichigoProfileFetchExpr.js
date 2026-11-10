(async function() {
  var url = __URL__;
  // 相对路径补全域名(灌库存的是 /sns/snsprofile/show_profile.html?q=…)。
  // 必须在当前页(spn.194964.com)上下文 fetch, 否则跨域 404/抓空 → 资料不完整
  if (url && String(url).charAt(0) === '/') url = 'https://sp.194964.com' + url;
  if (url && String(url).indexOf('://') === -1) url = 'https://sp.194964.com/' + url;
  var ACCOUNT = __ACCOUNT__;   // true = 账号自己的资料页（结构略有不同）
  function clean(s) {
    return String(s || '').replace(/\r/g, '').replace(/[ \t\u3000]+/g, ' ').replace(/\n{2,}/g, '\n').replace(/^\s+|\s+$/g, '');
  }
  function normPref(p) {
    p = String(p || '').trim();
    if (!p) return '';
    if (/^(東京|北海道|大阪|京都)$/.test(p)) return p + ({ '東京': '都', '北海道': '', '大阪': '府', '京都': '府' }[p] || '');
    if (/[都道府県]$/.test(p)) return p;
    return p + '県';
  }

  // 页面真实字段名 → 语义 key
  var LABELS = {
    '出身地':       { key: 'birthplace',  label: '出身地',        group: '基本情報' },
    '交際ステータス': { key: 'marital',     label: '交際ステータス', group: '基本情報' },
    '子供':         { key: 'children',    label: '子供',          group: '基本情報' },
    '職業':         { key: 'occupation',  label: '職業',          group: '基本情報' },
    '年収':         { key: 'income',      label: '年収',          group: '基本情報' },
    '血液型':       { key: 'bloodType',   label: '血液型',        group: '基本情報' },
    '星座':         { key: 'zodiac',      label: '星座',          group: '基本情報' },
    'キャリア':     { key: 'carrier',     label: 'キャリア',      group: '基本情報' },
    '身長':         { key: 'height',      label: '身長',          group: '見た目' },
    'スタイル':     { key: 'build',       label: 'スタイル',      group: '見た目' },
    'タイプ':       { key: 'type',        label: 'タイプ',        group: '見た目' },
    '目':           { key: 'eyes',        label: '目',            group: '見た目' },
    'デートでしたいこと': { key: 'dateWant', label: 'デートでしたいこと', group: '大人の交際' },
    '出会うまでの希望':  { key: 'meetingIntent', label: '出会うまでの希望', group: '大人の交際' },
    'タバコ':       { key: 'smoking',     label: 'タバコ',        group: '生活' },
    'お酒':         { key: 'drinking',    label: 'お酒',          group: '生活' },
    '車':           { key: 'car',         label: '車',            group: '生活' },
    '好みの身長':   { key: 'prefHeight',  label: '希望身長',      group: 'お相手に望むこと' },
    '好みの見た目・性格': { key: 'prefPersonality', label: '希望の見た目・性格', group: 'お相手に望むこと' }
  };
  var SECTIONS = ['基本情報', '見た目について', '大人の交際について', '生活について',
                  '共通点・興味あること', 'お相手に望むこと', 'プロフィール'];

  try {
    var resp = await fetch(url, { credentials: 'include' });
    var html = await resp.text();
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var txt = doc.body ? clean(doc.body.innerText) : '';
    var lines = txt.split('\n').map(function(s) { return s.trim(); }).filter(Boolean);

    // ---------- 现居（头像旁那行 "46歳埼玉 戸田市"）----------
    var ageNum = null, pref = '', city = '', regionFull = '';
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^(\d{1,2})\s*歳\s*(.*)$/);
      if (m && !/歳/.test(lines[i].slice(m[0].length))) {
        ageNum = parseInt(m[1], 10);
        var rest = String(m[2] || '').trim();
        if (rest) {
          var parts = rest.split(/[\s\u3000]+/);
          pref = parts[0] || '';
          city = parts.slice(1).join(' ') || '';
        }
        break;
      }
    }
    var prefFull = normPref(pref);
    regionFull = (prefFull + (city ? ' ' + city : '')).trim();

    // ---------- 分区字段 ----------
    var fields = {};        // key → value
    var byGroup = {};       // group → [{key,label,value}]
    var curSection = '';
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j];
      // 分区标题
      var isSec = false;
      for (var k = 0; k < SECTIONS.length; k++) { if (line.indexOf(SECTIONS[k]) !== -1 || (SECTIONS[k].indexOf(line) !== -1 && line.length > 2)) { curSection = SECTIONS[k]; isSec = true; break; } }
      if (isSec) continue;
      // 字段
      var meta = LABELS[line] || LABELS[line.trim()];
      // 同名标签在「お相手に望むこと」分区里语义不同（是"希望对方的…"）
      if (/お相手/.test(curSection)) {
        if (line === '年齢') meta = { key: 'prefAge', label: '希望年齢', group: 'お相手に望むこと' };
        else if (line === 'スタイル') meta = { key: 'prefBuild', label: '希望スタイル', group: 'お相手に望むこと' };
      }
      if (!meta) continue;
      var val = lines[j + 1];
      if (!val || LABELS[val] || SECTIONS.indexOf(val) !== -1) continue;
      // 跳过明显的非值（按钮文案等）
      if (/^(する|キャンセル|戻る|閉じる|送信|削除|編集|O K|OK)$/.test(val)) continue;
      fields[meta.key] = val;
      var g = meta.group;
      if (!byGroup[g]) byGroup[g] = [];
      byGroup[g].push({ key: meta.key, label: meta.label, value: val });
    }

    // ---------- 兴趣 icon ----------
    var icons = [];
    Array.from(doc.querySelectorAll('.interest-item img.affinity_img_icon, .interest-item img[src*="leisure/category"], .interest-item img[src*="affinity"]'))
      .forEach(function(img) {
        var src = img.getAttribute('src') || '';
        var a = src.match(/leisure\/category\/(\d+)/);
        if (a) icons.push(a[1]);
        var b = src.match(/(birthCity_\d+)/);
        if (b) icons.push(b[1]);
      });

    // ---------- 头像 ----------
    var head = doc.querySelector('img[src*="snsprofr"], [class*="profile-img"] img, [class*="head-img"] img, .mainProfShadow img');
    var avatarUrl = head ? (head.getAttribute('src') || '') : '';
    if (avatarUrl.indexOf('//') === 0) avatarUrl = 'https:' + avatarUrl;

    // ---------- 在线 ----------
    var onlineM = txt.match(/(\d+\s*(?:分|時間|日)以内|オンライン|昨日|数日前|\d+日前)/);

    // ---------- BBS ----------
    var bbs = Array.from(doc.querySelectorAll('.bbs-item')).map(function(it) {
      var g = it.querySelector('.btn-genre'), v = it.querySelector('.view'), t = it.querySelector('.time'), x = it.querySelector('.txt');
      var a = it.querySelector('a');
      return { genre: g ? clean(g.innerText) : '', viewCount: v ? clean(v.innerText) : '', time: t ? clean(t.innerText) : '', content: x ? clean(x.innerText) : '', detailUrl: a ? a.href : null };
    });

    // ---------- 昵称（页眉）----------
    var nickEl = doc.querySelector('.name, .tName, h1, .profName');
    var nickname = nickEl ? clean(nickEl.innerText) : '';

    return {
      ok: true, url: url, isAccount: !!ACCOUNT,
      interestIcons: icons,
      avatarUrl: avatarUrl,
      avatarIsDefault: !head || /no_?image/.test(avatarUrl),
      nickname: nickname,
      ageNum: ageNum,
      // 现居（拆分）
      pref: prefFull, city: city, region: regionFull,
      // 出身地（单独字段，来自 基本情報）
      birthplace: fields.birthplace || '',
      onlineText: onlineM ? onlineM[1].replace(/\s+/g, '') : '',
      fields: fields,
      byGroup: byGroup,
      groups: Object.keys(byGroup),
      bbsPosts: bbs,
      rawText: txt.slice(0, 3000),
      htmlLen: html.length
    };
  } catch (e) {
    return { ok: false, url: url, err: String(e && e.message || e) };
  }
})()
