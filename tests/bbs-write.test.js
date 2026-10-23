'use strict';
// 模块3 阶段2 · BBS 改帖表达式 + 端点单测（mock，不真连 CDP/平台）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rootDir = path.join(__dirname, '..');
const exprSrc = fs.readFileSync(path.join(rootDir, 'server', 'adapter', 'ichigoBbsWriteExpr.js'), 'utf8');

// 构造编辑页 DOM mock（formID + textarea[name=title/body] + button[name=write/confirm]）
function makeEditPage(opts) {
  var titleVal = (opts && opts.title0) || 'OLD_TITLE';
  var bodyVal = (opts && opts.body0) || 'OLD_BODY';
  var clicked = { write: 0, confirm: 0 };
  var afterConfirmNav = (opts && opts.afterConfirmNav) || ''; // 提交后 location.href 会变成什么
  var titleEl = {
    value: titleVal,
    dispatchEvent: function() {}
  };
  var bodyEl = {
    value: bodyVal,
    dispatchEvent: function() {}
  };
  var writeBtn = {
    click: function() { clicked.write += 1; }
  };
  var confirmBtn = {
    textContent: '確認する',
    click: function() {
      clicked.confirm += 1;
      // 模拟提交后跳走
      if (afterConfirmNav) location.href = afterConfirmNav;
    }
  };
  var form = {
    querySelector: function(sel) {
      sel = String(sel);
      if (sel.indexOf('textarea[name=title]') !== -1) return titleEl;
      if (sel.indexOf('textarea[name=body]') !== -1) return bodyEl;
      if (sel.indexOf('button[name=write]') !== -1 || sel.indexOf('button[type=submit]') !== -1) return writeBtn;
      if (sel.indexOf('button[name=confirm]') !== -1) return confirmBtn;
      return null;
    }
  };
  var doc = {
    getElementById: function(id) { return id === 'formID' ? form : null; },
    querySelector: function(sel) {
      sel = String(sel);
      if (sel.indexOf('button[name=confirm]') !== -1) return confirmBtn;
      return null;
    },
    querySelectorAll: function(sel) {
      sel = String(sel);
      if (sel.indexOf('button') !== -1) return [confirmBtn];
      return [];
    },
    body: { innerText: '' }
  };
  var location = { hostname: 'sp.194964.com', href: 'https://sp.194964.com/bbs/show_bbs_write_edit.html?targetBbsId=178898703' };
  function getFinalState() {
    return {
      clicked: clicked,
      titleFinal: titleEl.value,
      bodyFinal: bodyEl.value,
      location: location.href
    };
  }
  return { doc, location, getFinalState, titleEl, bodyEl, writeBtn, confirmBtn, form };
}

async function runExpr(opts, env) {
  var code = exprSrc
    .replace('__URL__', 'null')
    .replace('__BBS_WRITE_OPTS__', JSON.stringify(opts))
    .replace(/;\s*$/, '');
  var sandbox = {
    document: env.doc,
    location: env.location,
    Event: function(type, init) { return { type: type, bubbles: !!(init && init.bubbles) }; },
    setTimeout, clearTimeout,
    JSON, String, Array, Object, Set, Map, Date, Promise, console
  };
  var ctx = vm.createContext(sandbox);
  return await vm.runInContext('(' + code + ')', ctx);
}

test('改帖表达式：成功覆盖 title+body 并提交（mock）', async () => {
  var env = makeEditPage({ afterConfirmNav: 'https://sp.194964.com/bbs/show_bbs_write_list.html' });
  var r = await runExpr({ title: 'NEW_TITLE', body: 'NEW_BODY' }, env);
  var st = env.getFinalState();
  assert.equal(r.ok, true, 'got: ' + JSON.stringify(r));
  assert.equal(r.submitted, true);
  assert.equal(r.confirmed, true, '应点过確認する');
  assert.equal(st.titleFinal, 'NEW_TITLE', 'title 被覆盖');
  assert.equal(st.bodyFinal, 'NEW_BODY', 'body 被覆盖');
  assert.equal(st.clicked.confirm, 1, '确认按钮点 1 次');
  assert.ok(r.resultUrl.indexOf('show_bbs_write_edit') === -1, '已离开编辑页');
});

test('改帖表达式：只改 body 不传 title → title 保持原值', async () => {
  var env = makeEditPage({ title0: 'KEEP_TITLE', body0: 'OLD_BODY', afterConfirmNav: 'https://sp.194964.com/bbs/show_bbs_write_list.html' });
  var r = await runExpr({ body: 'NEW_BODY_ONLY' }, env);
  var st = env.getFinalState();
  assert.equal(r.ok, true, 'got: ' + JSON.stringify(r));
  assert.equal(r.titleSet, false, '未传 title 不应标记 titleSet');
  assert.equal(r.bodySet, true);
  assert.equal(st.titleFinal, 'KEEP_TITLE', 'title 保持原值不动');
  assert.equal(st.bodyFinal, 'NEW_BODY_ONLY', 'body 被覆盖');
});

test('改帖表达式：标题 >30 字 → title-too-long 拒收', async () => {
  var env = makeEditPage({});
  var longTitle = 'あ'.repeat(31);
  var r = await runExpr({ title: longTitle }, env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'title-too-long');
  assert.equal(r.step, 'validate');
});

test('改帖表达式：正文 >500 字 → body-too-long 拒收', async () => {
  var env = makeEditPage({});
  var longBody = 'あ'.repeat(501);
  var r = await runExpr({ body: longBody }, env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'body-too-long');
});

test('改帖表达式：非平台域 → not-on-platform-domain', async () => {
  var env = makeEditPage({});
  env.location = { hostname: 'example.com', href: 'https://example.com/' };
  var r = await runExpr({ body: 'X' }, env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-on-platform-domain');
});

test('改帖表达式：表单缺失 → write-form-not-found', async () => {
  var env = makeEditPage({});
  // 让 formID 找不到
  var origGet = env.doc.getElementById;
  env.doc.getElementById = function() { return null; };
  env.doc.querySelector = function() { return null; };
  var r = await runExpr({ body: 'X' }, env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'write-form-not-found');
});

test('ichigoDeepScrape 暴露 bbsWritePost + fillBbsWriteOpts', () => {
  var src = fs.readFileSync(path.join(rootDir, 'server', 'adapter', 'ichigoDeepScrape.js'), 'utf8');
  assert.match(src, /bbsWritePost: bbsWritePost/);
  assert.match(src, /function bbsWritePost/);
  assert.match(src, /function fillBbsWriteOpts/);
  assert.match(src, /__BBS_WRITE_OPTS__/);
  // 确认有回列表页逻辑
  assert.match(src, /backToList/);
});

test('consoleRoutes 有 POST /api/console/bbs/post/edit + 确认闸门', () => {
  var src = fs.readFileSync(path.join(rootDir, 'server', 'consoleRoutes.js'), 'utf8');
  assert.ok(src.includes("'/api/console/bbs/post/edit'"), 'route path present');
  assert.ok(src.includes('confirmed !== true'), '确认闸门：confirmed 必须 true');
  assert.ok(src.includes('confirmation-required'), '未确认回 409 + 原因');
  assert.ok(src.includes('bbsWritePost'), '调 deepScrape.bbsWritePost');
});
