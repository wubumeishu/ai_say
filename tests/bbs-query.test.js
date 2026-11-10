'use strict';
// 模块3 · BBS 帖子查询表达式 + 端点单测（mock，不真连 CDP/平台）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rootDir = path.join(__dirname, '..');
const exprSrc = fs.readFileSync(path.join(rootDir, 'server', 'adapter', 'ichigoBbsQueryExpr.js'), 'utf8');

// 用 vm 跑表达式（表达式 IIFE return Promise）
async function runExpr(opts, hostname, fetchImpl, parserImpl) {
  const code = exprSrc
    .replace('__URL__', 'null')
    .replace('__BBS_OPTS__', JSON.stringify(opts))
    .replace(/;\s*$/, '');
  const sandbox = {
    document: {
      getElementById: (id) => (id === 'nav-tab'
        ? { getAttribute: (k) => (k === 'data-url' ? '/bbs/ajax_show_slider_list.html' : '') }
        : null),
      querySelectorAll: () => []
    },
    location: { hostname: hostname || 'sp.194964.com', href: 'https://sp.194964.com/bbs/show_bbs.html?q=TEST' },
    fetch: fetchImpl,
    DOMParser: parserImpl,
    setTimeout, clearTimeout,
    JSON, String, Array, Object, Set, Map, Date, Promise, encodeURIComponent, console
  };
  const ctx = vm.createContext(sandbox);
  return await vm.runInContext('(' + code + ')', ctx);
}

// 构造一个 fake DOMParser：解析 subject HTML，返回带 querySelectorAll('.recruit-list') 的对象
// 卡片对象 querySelector(sel) 按真实 selector 返回桩
function fakeParser() {
  function FakeDOMParser() {}
  FakeDOMParser.prototype.parseFromString = function() {
    var card = {
      querySelector: function(sel) {
        sel = String(sel);
        if (sel.indexOf('.recruit-list-name') !== -1) return { textContent: 'TestTitle...' };
        if (sel.indexOf('.recruit-list-age') !== -1) return { textContent: 'TestName 45\u6b73' };
        if (sel.indexOf('.recruit-list-home') !== -1) return { textContent: '\u4e09\u91cd\u5ddd' };
        if (sel === '.view') return { textContent: '0' };
        if (sel === '.date') return { textContent: '10/22 22:45' };
        if (sel.indexOf('.cat-btn') !== -1) return { textContent: 'test-cat' };
        if (sel.indexOf('.recruit-list-photo') !== -1) return { textContent: '2' };
        if (sel.indexOf('recruit-list-txt') !== -1 || sel.indexOf('show_bbs_detail') !== -1)
          return { getAttribute: function(n) { return n === 'href' ? '/bbs/show_bbs_detail.html?q=DELTOK' : ''; } };
        if (sel.indexOf('.recruit-list-thumb a') !== -1)
          return { getAttribute: function(n) { return n === 'href' ? '/sns/snsprofile/show_profile.html?q=PROFTOK' : ''; } };
        if (sel.indexOf('.recruit-list-thumb img') !== -1)
          return { getAttribute: function(n) { return n === 'src' ? '//images.194964.com/snsprofr/test.jpg' : ''; } };
        return null;
      }
    };
    return {
      querySelectorAll: function(sel) {
        sel = String(sel);
        if (sel.indexOf('.recruit-list') !== -1) return [card];
        return [];
      }
    };
  };
  return FakeDOMParser;
}


function fetchOk(subject) {
  return function() {
    return Promise.resolve({
      status: 200,
      text: function() {
        return Promise.resolve(JSON.stringify({ status: 'success', subject: subject }));
      }
    });
  };
}

test('BBS 查询表达式：成功解析卡片（mock fetch + DOMParser）', async () => {
  const r = await runExpr({ genre: 5, page: 1 }, 'sp.194964.com', fetchOk('<div class="recruit-list"></div>'), fakeParser());
  assert.equal(r.ok, true, 'got: ' + JSON.stringify(r));
  assert.equal(r.via, 'bbs-ajax-query');
  assert.equal(r.total, 1, 'total: ' + JSON.stringify(r));
  assert.equal(r.posts[0].title, 'TestTitle...');
  assert.equal(r.posts[0].name, 'TestName');
  assert.equal(r.posts[0].age, '45');
  assert.ok(r.posts[0].detailHref.indexOf('show_bbs_detail') !== -1);
  assert.ok(r.posts[0].profileHref.indexOf('show_profile') !== -1);
});

test('BBS 查询表达式：非平台域 → not-on-platform-domain', async () => {
  const r = await runExpr({}, 'example.com', fetchOk(''), fakeParser());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-on-platform-domain');
});

test('BBS 查询表达式：fetch 失败 → fetch-error', async () => {
  const r = await runExpr({}, 'sp.194964.com', function() { return Promise.reject(new Error('network down')); }, fakeParser());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'fetch-error');
});

test('BBS 查询表达式：空响应 → empty', async () => {
  // subject 不含 recruit-list 且短 → no-posts-in-response
  const r = await runExpr({}, 'sp.194964.com', fetchOk(''), fakeParser());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-posts-in-response');
});

test('ichigoDeepScrape 暴露 queryBbsPosts + fillBbsOpts', () => {
  const src = fs.readFileSync(path.join(rootDir, 'server', 'adapter', 'ichigoDeepScrape.js'), 'utf8');
  assert.match(src, /queryBbsPosts: queryBbsPosts/);
  assert.match(src, /function queryBbsPosts/);
  assert.match(src, /function fillBbsOpts/);
  assert.match(src, /__BBS_OPTS__/);
});

test('consoleRoutes 有 /api/console/bbs/posts 端点', () => {
  const src = fs.readFileSync(path.join(rootDir, 'server', 'consoleRoutes.js'), 'utf8');
  assert.ok(src.includes("'/api/console/bbs/posts'"), 'route path present');
  assert.ok(src.includes('queryBbsPosts'), 'calls deepScrape.queryBbsPosts');
  assert.ok(src.includes('board'), 'supports board param');
});
