'use strict';
// 出会拉黑/删除表达式（ichigoBlockExpr.js）单测：
//   不真连 CDP，在 Node 里 mock 最小 DOM，直接执行表达式文件，验证：
//   1. preflight 模式返回 editHref（不导航）
//   2. execute 模式：多客户名（数组）→ 勾选 N 个 checkbox → 点删除 → 确认页 → 点「削除する」
//   3. execute 模式：部分匹配（勾了 1 个缺 1 个）→ ok:true + partialMiss + missed
//   4. execute 模式：客户名不匹配 → ok:false + customer-not-in-list（不盲勾）
//   5. fillUrl 的 __MODE__ 占位符替换（ichigoDeepScrape.js）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rootDir = path.join(__dirname, '..');
const blockExprSrc = fs.readFileSync(path.join(rootDir, 'server', 'adapter', 'ichigoBlockExpr.js'), 'utf8');

// 模拟编辑模式 DOM 状态
function makeMock(clientNames) {
  const state = {
    clientNames: clientNames.slice(),
    // 每个客户对应的 checkbox 值
    valMap: {},
    // 勾选记录
    checked: new Set(),
    // 按钮点击记录
    clickedButtons: [],
    // 当前 URL（可变）
    location: { href: 'https://sp.194964.com/mail/inbox/show_mailbox.html?q=TEST' },
    // 阶段：edit → confirm → deleted
    phase: 'edit',
    // 每个客户的容器（含 checkbox + 名字）
    containers: []
  };
  clientNames.forEach((n, i) => {
    state.valMap[n] = 'VAL_' + i;
    state.containers.push({
      name: n,
      text: '♂' + n + 'さん 36歳 三重県',
      checkboxIndex: i
    });
  });

  // querySelectorAll 行为（按选择器分发）
  function qsa(sel) {
    sel = String(sel);
    // label[for^="checkbox"] → 编辑模式 checkbox 数组
    if (sel.indexOf('label[for^="checkbox"]') !== -1 || sel === 'label[for^=checkbox]') {
      return state.containers.map((c, i) => ({
        textContent: c.name,
        click() { state.checked.add(i); }
      }));
    }
    // input[type="checkbox"]
    if (sel.indexOf('input[type="checkbox"]') !== -1) {
      return state.containers.map((c, i) => ({
        value: state.valMap[c.name],
        click() { state.checked.add(i); }
      }));
    }
    // .contentsContribute 容器
    if (sel.indexOf('.contentsContribute') !== -1) {
      return state.containers.map((c, i) => ({
        querySelector(sel2) {
          sel2 = String(sel2);
          if (sel2.indexOf('.namelstProf') !== -1 || sel2 === 'p' || sel2.indexOf(' p') !== -1) {
            return { textContent: c.text };
          }
          if (sel2.indexOf('input[type="checkbox"]') !== -1 || sel2.indexOf('checkbox') !== -1) {
            return { click() { state.checked.add(i); } };
          }
          return null;
        }
      }));
    }
    // p.bgLightBlue2（编辑按钮，仅在 preflight 模式下存在）
    if (sel.indexOf('p.bgLightBlue2') !== -1) {
      if (state.phase === 'edit' && state.location.href.indexOf('?q=') === -1) {
        return [{
          textContent: '編集',
          closest: () => null,
          parentElement: { href: state.location.href + '?q=PREFLIGHT' },
          click() { state.clickedButtons.push('編集'); }
        }];
      }
      return [];
    }
    // a[href*="show_mailbox.html?q="]
    if (sel.indexOf('a[href*="show_mailbox.html?q="]') !== -1) {
      return [];
    }
    // button / input[type=submit]
    if (sel.indexOf('button') !== -1 || sel.indexOf('input[type="submit"]') !== -1 || sel.indexOf('input[type=submit]') !== -1) {
      if (state.phase === 'edit') {
        return [{
          textContent: 'チェックを削除する',
          type: 'submit',
          click() {
            state.clickedButtons.push('チェックを削除する');
            state.phase = 'confirm';
            state.location.href = 'https://sp.194964.com/mail/inbox/show_mail_delete.html';
          }
        }];
      }
      if (state.phase === 'confirm') {
        return [
          {
            textContent: '削除する',
            type: 'submit',
            click() {
              state.clickedButtons.push('削除する');
              state.phase = 'deleted';
              // 实测：平台不一定自动回 inbox，停在确认页
            }
          },
          { textContent: 'キャンセル', type: 'submit', click() { state.clickedButtons.push('キャンセル'); } }
        ];
      }
      return [];
    }
    // .popup / .modal / [class*=confirm]
    if (sel.indexOf('.popup') !== -1 || sel.indexOf('.modal') !== -1 || sel.indexOf('confirm') !== -1) {
      return [];
    }
    return [];
  }

  return {
    state,
    qsa,
    location: state.location
  };
}

// 跑表达式（mock 环境）
async function runExpr(mode, customerName, mock) {
  const doc = {
    location: mock.location,
    querySelectorAll: mock.qsa,
    querySelector(sel) {
      const r = mock.qsa(sel);
      return r.length > 0 ? r[0] : null;
    }
  };
  const asExpr = blockExprSrc
    .replace('__URL__', 'null')
    .replace('__CUSTOMER_NAME__', JSON.stringify(customerName))
    .replace('__MODE__', JSON.stringify(mode))
    .replace(/;\s*$/, '');
  const ctx = vm.createContext({
    document: doc,
    location: mock.location,
    setTimeout, clearTimeout, Promise, JSON, String, Array, Object, Set, Map, console
  });
  const val = vm.runInContext('(' + asExpr + ')', ctx);
  return await val;
}

test('preflight 模式返回 editHref（不导航）', async () => {
  const m = makeMock(['太郎']);
  // preflight：普通收件箱页（无 ?q=）
  m.state.location.href = 'https://sp.194964.com/mail/inbox/show_mailbox.html';
  m.state.phase = 'edit';
  const r = await runExpr('preflight', null, m);
  assert.equal(r.ok, true, 'preflight ok, got: ' + JSON.stringify(r));
  assert.equal(r.step, 'preflight');
  assert.match(r.editHref, /show_mailbox\.html\?q=/, 'editHref 带 ?q= token');
});

test('execute 多客户（数组）→ 勾选 N 个 → 删除 → 确认页 → 点「削除する」', async () => {
  const m = makeMock(['ふっくん', '太郎']);
  // 已处于编辑模式页（?q= 在 URL 里）
  m.state.location.href = 'https://sp.194964.com/mail/inbox/show_mailbox.html?q=TEST';
  m.state.phase = 'edit';
  const r = await runExpr('execute', ['ふっくん', '太郎'], m);
  // 验证：勾选了 2 个 checkbox（ふっくん idx=0 + 太郎 idx=1）
  assert.equal(m.state.checked.size, 2, '勾选了 2 个 checkbox, got: ' + JSON.stringify([...m.state.checked]));
  assert.equal(m.state.clickedButtons.includes('チェックを削除する'), true, '点过 チェックを削除する');
  assert.equal(m.state.clickedButtons.includes('削除する'), true, '点过 削除する（确认页）');
  assert.equal(m.state.phase, 'deleted');
  // 表达式返回
  assert.equal(r.ok, true, 'delete ok, got: ' + JSON.stringify(r));
  assert.equal(r.step, 'deleted');
  assert.equal(r.checkedCount, 2);
  assert.equal(JSON.stringify(r.matched, ['ふっくん', '太郎'][0]), JSON.stringify(r.matched, ['ふっくん', '太郎'][1]))
  assert.equal(r.partialMiss, false);
  assert.equal(r.confirmPage, true, '应识别到确认页');
  assert.equal(r.needNavBack, true, '必须显式回收件箱');
});

test('execute 单客户（字符串）→ 勾选 1 个 → 删除 → 确认', async () => {
  const m = makeMock(['ケイタ', 'ふっくん', '太郎']);
  m.state.location.href = 'https://sp.194964.com/mail/inbox/show_mailbox.html?q=TEST';
  m.state.phase = 'edit';
  const r = await runExpr('execute', 'ケイタ', m);
  assert.equal(m.state.checked.size, 1, '勾选 1 个');
  assert.equal([...m.state.checked][0], 0, '勾的是 ケイタ(idx=0)');
  assert.equal(r.ok, true, 'got: ' + JSON.stringify(r));
  assert.equal(r.checkedCount, 1);
  assert.equal(JSON.stringify(r.matched, ['ケイタ'][0]), JSON.stringify(r.matched, ['ケイタ'][1]))
});

test('execute 部分匹配（勾 1 缺 1）→ ok:true + partialMiss + missed', async () => {
  const m = makeMock(['ふっくん', '太郎']);
  m.state.location.href = 'https://sp.194964.com/mail/inbox/show_mailbox.html?q=TEST';
  m.state.phase = 'edit';
  // 请求里有「ケイタ」但 mock 列表里没有
  const r = await runExpr('execute', ['ふっくん', 'ケイタ'], m);
  assert.equal(r.ok, true, '部分匹配仍 ok, got: ' + JSON.stringify(r));
  assert.equal(r.checkedCount, 1);
  assert.equal(JSON.stringify(r.matched, ['ふっくん'][0]), JSON.stringify(r.matched, ['ふっくん'][1]))
  assert.equal(JSON.stringify(r.missed, ['ケイタ'][0]), JSON.stringify(r.missed, ['ケイタ'][1]))
  assert.equal(r.partialMiss, true);
});

test('execute 客户名全不匹配 → ok:false + customer-not-in-list（不盲勾）', async () => {
  const m = makeMock(['ふっくん', '太郎']);
  m.state.location.href = 'https://sp.194964.com/mail/inbox/show_mailbox.html?q=TEST';
  m.state.phase = 'edit';
  const r = await runExpr('execute', ['不存在的客户'], m);
  assert.equal(r.ok, false, 'got: ' + JSON.stringify(r));
  assert.equal(r.step, 'checkbox');
  assert.equal(r.reason, 'customer-not-in-list');
  assert.equal(JSON.stringify(r.missed, ['不存在的客户'][0]), JSON.stringify(r.missed, ['不存在的客户'][1]))
  assert.equal(m.state.checked.size, 0, '未勾任何 checkbox');
});

test('execute 空 customerName → ok:false + no-customer-named（拒盲勾）', async () => {
  const m = makeMock(['ふっくん']);
  m.state.location.href = 'https://sp.194964.com/mail/inbox/show_mailbox.html?q=TEST';
  m.state.phase = 'edit';
  const r = await runExpr('execute', [], m);
  assert.equal(r.ok, false, 'got: ' + JSON.stringify(r));
  assert.equal(r.reason, 'no-customer-named');
  assert.equal(m.state.checked.size, 0);
});


test('execute 窗口停在 show_mail_delete.html（确认页残留）→ 返回 stuck-confirm-page（自愈信号）', async () => {
  const m = makeMock(['ケイタ']);
  // 模拟窗口残留在确认页（URL=show_mail_delete，无 checkbox）
  m.state.location.href = 'https://sp.194964.com/mail/inbox/show_mail_delete.html';
  m.state.phase = 'confirm';
  // mock：确认页里 label[for^=checkbox] 应返回 0 个（alreadyEditMode=false）
  m.qsa = (function(orig) {
    return function(sel) {
      const s = String(sel);
      if (s.indexOf('label[for^="checkbox"]') !== -1 || s === 'label[for^=checkbox]') return []; // 确认页无 checkbox
      return orig(sel);
    };
  })(m.qsa.bind(m));
  const r = await runExpr('execute', ['ケイタ'], m);
  assert.equal(r.ok, false, 'got: ' + JSON.stringify(r));
  assert.equal(r.step, 'stuck-confirm-page');
  assert.equal(r.reason, 'window-on-confirm-page');
  assert.equal(r.needNavBack, true);
  assert.match(r.note, /show_mail_delete/);
  // 不应勾任何 checkbox
  assert.equal(m.state.checked.size, 0);
});

test('preflight 在确认页残留时 → 也返回 stuck-confirm-page（不误报 edit-btn-not-found）', async () => {
  const m = makeMock(['ケイタ']);
  m.state.location.href = 'https://sp.194964.com/mail/inbox/show_mail_delete.html';
  m.state.phase = 'confirm';
  m.qsa = (function(orig) {
    return function(sel) {
      const s = String(sel);
      if (s.indexOf('label[for^="checkbox"]') !== -1 || s === 'label[for^=checkbox]') return [];
      return orig(sel);
    };
  })(m.qsa.bind(m));
  const r = await runExpr('preflight', null, m);
  assert.equal(r.ok, false, 'got: ' + JSON.stringify(r));
  assert.equal(r.step, 'stuck-confirm-page');
  assert.equal(r.needNavBack, true);
});

test('fillUrl 的 __MODE__ 占位符替换（ichigoDeepScrape.js）', async () => {
  const src = fs.readFileSync(path.join(rootDir, 'server', 'adapter', 'ichigoDeepScrape.js'), 'utf8');
  const i = src.indexOf('function fillUrl(');
  assert.ok(i !== -1, 'fillUrl 函数存在');
  const body = src.slice(i, src.indexOf('}', i + 2000));
  assert.match(body, /__MODE__/, 'fillUrl 应替换 __MODE__ 占位符');
  assert.match(body, /modeInjected/, 'fillUrl 应生成 modeInjected 变量');
  assert.match(body, /JSON\.stringify\(customerName\)/, 'customerName 支持数组（JSON.stringify 直接注入）');
});
