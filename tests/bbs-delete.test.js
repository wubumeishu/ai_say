'use strict';
// 模块3 阶段2 · BBS 删帖表达式 + 端点单测（mock，不真连 CDP/平台）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rootDir = path.join(__dirname, '..');
const exprSrc = fs.readFileSync(path.join(rootDir, 'server', 'adapter', 'ichigoBbsDeleteExpr.js'), 'utf8');

// 构造招募历史页 mock（含 checkbox[name=targetBbsId[]] + 删除按钮 + 确认页导航）
function makeListPage(opts) {
  var postIds = (opts && opts.postIds) || ['100', '200', '300'];
  var state = { atList: true, clicked: 0, confirmClicked: 0, location: 'https://sp.194964.com/bbs/show_bbs_write_list.html?q=T' };
  var boxes = postIds.map(function(v) {
    return {
      value: v,
      checked: false,
      click: function() { this.checked = !this.checked; state.clicked += 1; }
    };
  });
  var delBtn = {
    textContent: 'チェックを削除',
    click: function() {
      state.confirmClicked += 1;
      // 模拟跳确认页
      state.location = 'https://sp.194964.com/bbs/show_bbs_confirm_delete.html?identifier=delete&targetBbsId=' + postIds[0];
    }
  };
  var confirmBtn = {
    textContent: '削除する',
    click: function() {
      // 模拟删完回列表
      state.location = 'https://sp.194964.com/bbs/show_bbs_write_list.html?q=T2';
    }
  };
  var doc = {
    querySelectorAll: function(sel) {
      sel = String(sel);
      if (sel.indexOf('input[type="checkbox"][name="targetBbsId[]"]') !== -1) return boxes;
      if (sel.indexOf('button') !== -1) return [delBtn, confirmBtn];
      return [];
    },
    body: { innerText: '' }
  };
  var location = {
    get href() { return state.location; },
    set href(v) { state.location = v; },
    hostname: 'sp.194964.com'
  };
  return { doc, location, state, boxes, delBtn, confirmBtn };
}

async function runExpr(opts, env) {
  var code = exprSrc
    .replace('__URL__', 'null')
    .replace('__BBS_DELETE_OPTS__', JSON.stringify(opts))
    .replace(/;\s*$/, '');
  var sandbox = {
    document: env.doc,
    location: env.location,
    setTimeout, clearTimeout,
    JSON, String, Array, Object, Set, Map, Date, Promise, console
  };
  var ctx = vm.createContext(sandbox);
  return await vm.runInContext('(' + code + ')', ctx);
}

test('删帖表达式：命中 1 个 ID → 勾选 + 点删除 + 确认（mock）', async () => {
  var env = makeListPage({ postIds: ['100', '200', '300'] });
  // mock location 对象需支持 .href 赋值（确认页导航）+ 读取
  var r = await runExpr({ targetBbsIds: ['200'] }, env);
  assert.equal(r.ok, true, 'got: ' + JSON.stringify(r));
  assert.equal(r.via, 'bbs-delete-expr');
  assert.equal(JSON.stringify(r.matched), '["200"]', 'matched: ' + JSON.stringify(r.matched));
  assert.equal(r.missed.length, 0, '无 missed');
  assert.equal(r.confirmed, true, '应点过確認（削除する）');
  assert.equal(env.state.confirmClicked, 1, '删除按钮点 1 次');
});

test('删帖表达式：ID 全不在列表 → 拒删（不盲勾）', async () => {
  var env = makeListPage({ postIds: ['100', '200'] });
  var r = await runExpr({ targetBbsIds: ['999'] }, env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'target-not-in-list');
  assert.equal(env.state.confirmClicked, 0, '未点删除');
});

test('删帖表达式：空 targetBbsIds → 拒删', async () => {
  var env = makeListPage({ postIds: ['100'] });
  var r = await runExpr({}, env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-target-ids');
});

test('删帖表达式：非平台域 → not-on-platform-domain', async () => {
  var env = makeListPage({ postIds: ['100'] });
  env.location.hostname = 'example.com';
  var r = await runExpr({ targetBbsIds: ['100'] }, env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-on-platform-domain');
});

test('ichigoDeepScrape 暴露 bbsDeletePosts + buildBbsVerifyExpr', () => {
  var src = fs.readFileSync(path.join(rootDir, 'server', 'adapter', 'ichigoDeepScrape.js'), 'utf8');
  assert.match(src, /bbsDeletePosts: bbsDeletePosts/);
  assert.match(src, /function bbsDeletePosts/);
  assert.match(src, /function buildBbsVerifyExpr/);
  assert.match(src, /__BBS_DELETE_OPTS__/);
  // buildBbsVerifyExpr 不应生成 name= 属性选择器（[name=\"targetBbsId[]\"] 嵌套易踩坑）
  const bve = src.slice(src.indexOf('function buildBbsVerifyExpr'), src.indexOf('function bbsDeletePosts'));
  var BAD_SEL = String.fromCharCode(91,110,97,109,101,61,34,116,97,114,103,101,116,66,98,115,73,100,91,93,34); // [name=\"targetBbsId[]\"]
  assert.ok(bve.indexOf(BAD_SEL) === -1, '不应含嵌套属性选择器');
  assert.ok(bve.includes("querySelectorAll('input[type=checkbox]')"), '用简单 type 选择器');
});

test('buildBbsVerifyExpr 生成的 CDP 表达式语法合法', () => {
  // 直接跑函数逻辑：构造出的表达式能被 vm.Script 解析
  const fs2 = require('node:fs');
  const src = fs2.readFileSync(path.join(rootDir, 'server', 'adapter', 'ichigoDeepScrape.js'), 'utf8');
  // 提取 buildBbsVerifyExpr 函数体，单独求值
  const m = src.match(/function buildBbsVerifyExpr[^{]*\{[\s\S]*?\n  \}/);
  assert.ok(m, '找到 buildBbsVerifyExpr');
  const fnSrc = '(function(){' + m[0] + ';return buildBbsVerifyExpr();})()';
  const vm2 = require('node:vm');
  const ctx = vm2.createContext({ String, JSON });
  const exprStr = vm2.runInContext(fnSrc, ctx);
  // 生成的表达式本身合法
  new vm2.Script(String(exprStr), { filename: 'gen.js' });
  assert.ok(String(exprStr).indexOf("querySelectorAll") !== -1, '含 querySelectorAll');
});

test('consoleRoutes 有 POST /api/console/bbs/post/delete + 确认闸门', () => {
  var src = fs.readFileSync(path.join(rootDir, 'server', 'consoleRoutes.js'), 'utf8');
  assert.ok(src.includes("'/api/console/bbs/post/delete'"), 'route path present');
  assert.ok(src.includes('confirmation-required'), '确认闸门');
  assert.ok(src.includes('bbsDeletePosts'), '调 deepScrape.bbsDeletePosts');
  assert.ok(src.includes('confirmed !== true'), 'confirmed 必须 true');
});
