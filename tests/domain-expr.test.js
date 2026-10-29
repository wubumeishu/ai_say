// 模块4-8 · 全域 RPA 表达式 + deepScrape 调度 单测
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

function readExpr(name) {
  try { return fs.readFileSync(path.join(__dirname, '..', 'server', 'adapter', name), 'utf8'); } catch { return ''; }
}

// 表达式末尾形态: })(__URL__, __OPTS__);  替换占位符后变成 })(null, {opts});
// 为捕获 IIFE 返回值，把 body 末尾的 "});" 保留，但在 new Function body 前缀加 "return "
// 实际上 IIFE 是表达式语句 "(function(){})(args);"，加 return 前缀即可：return (function(){})(args);
function evalExpr(src, opts, env) {
  let injected = src
    .replace(/__URL__\b/g, 'null')
    .replace(/__ASHIATO_OPTS__\b/g, JSON.stringify(opts))
    .replace(/__FACES_OPTS__\b/g, JSON.stringify(opts))
    .replace(/__SEARCH_OPTS__\b/g, JSON.stringify(opts))
    .replace(/__IGNORE_OPTS__\b/g, JSON.stringify(opts))
    .replace(/__CALENDAR_OPTS__\b/g, JSON.stringify(opts))
    .replace(/__DIARY_OPTS__\b/g, JSON.stringify(opts));
  // 找到 IIFE 调用起点 "(function("，在其前加 "return "
  const iifeStart = injected.indexOf('(function(');
  if (iifeStart !== -1) {
    injected = injected.slice(0, iifeStart) + 'return ' + injected.slice(iifeStart);
  }
  const fn = new Function('location', 'document', 'window', 'fetch', 'Event', 'setTimeout', injected);
  return fn(
    env.location,
    env.document || { querySelector: () => null, querySelectorAll: () => [] },
    env.window || {},
    env.fetch || null,
    function Event(type) { this.type = type; this.bubbles = true; },
    function syncSetTimeout(fn) { return fn(); }
  );
}

test('expr files: 6 个表达式文件都存在', () => {
  ['ichigoAshiatoExpr.js','ichigoFacesExpr.js','ichigoSearchExpr.js','ichigoIgnoreExpr.js','ichigoCalendarExpr.js','ichigoDiaryExpr.js']
    .forEach(f => assert.ok(readExpr(f).length > 100, f + ' 缺失或太短'));
});

test('ashiato: 非出会域名 → not-on-platform-domain', () => {
  return evalExpr(readExpr('ichigoAshiatoExpr.js'), {}, {
    location: { hostname: 'evil.com', pathname: '/x' },
    window: {},
  }).then(v => {
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'not-on-platform-domain');
  });
});

test('faces: 非出会域名 → not-on-platform-domain', () => {
  return evalExpr(readExpr('ichigoFacesExpr.js'), {}, {
    location: { hostname: 'evil.com', pathname: '/x' },
    window: {},
  }).then(v => {
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'not-on-platform-domain');
  });
});

test('faces: window.memberIdList 骨架补齐', () => {
  return evalExpr(readExpr('ichigoFacesExpr.js'), {}, {
    location: { hostname: 'sp.194964.com', pathname: '/sns/snssearch/show_faces.html' },
    window: { memberIdList: '111,222,333' },
    document: { querySelectorAll: () => [], querySelector: () => null },
  }).then(v => {
    assert.equal(v.ok, true);
    assert.equal(v.count, 3);
    assert.equal(v.members[0].memberId, '111');
    assert.equal(v.members[2].memberId, '333');
  });
});

test('faces: 非找对象页 → not-on-faces-page', () => {
  return evalExpr(readExpr('ichigoFacesExpr.js'), {}, {
    location: { hostname: 'sp.194964.com', pathname: '/menu.html' },
    window: {},
    document: { querySelectorAll: () => [], querySelector: () => null },
  }).then(v => {
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'not-on-faces-page');
  });
});

test('ignore: list 抓忽略列表 checkbox', () => {
  const boxes = [ { value: '9001' }, { value: '9002' } ];
  return evalExpr(readExpr('ichigoIgnoreExpr.js'), { action: 'list' }, {
    location: { hostname: 'sp.194964.com', pathname: '/sns/snsmylist/show_ignore_list.html' },
    window: {},
    document: {
      querySelectorAll: (sel) => (sel.indexOf('targetReMemberIdList') !== -1 ? boxes : []),
      querySelector: () => null,
    },
  }).then(v => {
    assert.equal(v.ok, true);
    assert.deepEqual(v.ignoredMemberIds, ['9001','9002']);
    assert.equal(v.count, 2);
  });
});

test('ignore: 非忽略列表页 list → not-on-ignore-list', () => {
  return evalExpr(readExpr('ichigoIgnoreExpr.js'), { action: 'list' }, {
    location: { hostname: 'sp.194964.com', pathname: '/menu.html' },
    window: {},
    document: { querySelectorAll: () => [], querySelector: () => null },
  }).then(v => {
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'not-on-ignore-list');
  });
});

test('calendar: list 抓会える日', () => {
  return evalExpr(readExpr('ichigoCalendarExpr.js'), { action: 'list' }, {
    location: { hostname: 'sp.194964.com', pathname: '/calendar/show_mylist.html' },
    window: {},
    document: {
      querySelectorAll: (sel) => (sel === '.day-meet-list' ? [] : []),
      querySelector: (sel) => (sel === '#adds' ? { value: '24' } : null),
    },
  }).then(v => {
    assert.equal(v.ok, true);
    assert.equal(v.prefId, '24');
    assert.equal(Array.isArray(v.entries), true);
    assert.equal(v.entries.length, 0);
  });
});

test('diary: write 无 confirmed → guard not-confirmed', () => {
  return evalExpr(readExpr('ichigoDiaryExpr.js'), { action: 'write', title: 't', body: 'b' }, {
    location: { hostname: 'sp.194964.com', pathname: '/sns/snsdiary/show_mydiary_form.html' },
    window: {},
    document: { querySelector: () => null, querySelectorAll: () => [] },
  }).then(v => {
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'not-confirmed');
    assert.equal(v.step, 'guard');
  });
});

test('diary: delete 无 confirmed → guard not-confirmed', () => {
  return evalExpr(readExpr('ichigoDiaryExpr.js'), { action: 'delete', diaryId: '123' }, {
    location: { hostname: 'sp.194964.com', pathname: '/sns/snsdiary/show_mydiaries.html' },
    window: {},
    document: { querySelector: () => null, querySelectorAll: () => [] },
  }).then(v => {
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'not-confirmed');
  });
});

test('deepScrape: 新 6 方法存在 + 强副作用 guard 默认拦截', () => {
  const { createIchigoDeepScrape } = require(path.join(__dirname, '..', 'server', 'adapter', 'ichigoDeepScrape.js'));
  const ds = createIchigoDeepScrape({
    openCdpSession: () => Promise.resolve({ close() {} }),
    rootDir: path.join(__dirname, '..'),
  });
  ['fetchAshiato','fetchFaces','runProfileSearch','manageIgnore','manageCalendar','manageDiary']
    .forEach(m => assert.equal(typeof ds[m], 'function', m + ' 应为 function'));
  return Promise.all([
    ds.runProfileSearch({ fields: {}, submit: true }).then(v => {
      assert.equal(v.ok, false);
      assert.equal(v.reason, 'not-confirmed');
    }),
    ds.manageIgnore({ action: 'ignore' }).then(v => {
      assert.equal(v.ok, false);
      assert.equal(v.reason, 'not-confirmed');
    }),
    ds.manageCalendar({ action: 'addDays', days: ['2026-11-01'] }).then(v => {
      assert.equal(v.ok, false);
      assert.equal(v.reason, 'not-confirmed');
    }),
    ds.manageDiary({ action: 'write', title: 't', body: 'b' }).then(v => {
      assert.equal(v.ok, false);
      assert.equal(v.reason, 'not-confirmed');
    }),
    ds.manageIgnore({ action: 'list' }).then(v => {
      assert.notEqual(v.reason, 'not-confirmed');
    }),
  ]);
});
