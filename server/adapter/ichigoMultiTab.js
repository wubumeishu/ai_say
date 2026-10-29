'use strict';
// 出会平台 多标签并行调度器（ichigoMultiTab.js）
// 规则（用户 2026-10-27 定）：
//   * 并发最多 3：主1（主标签，可做多类操作）+ worker2 + worker3（只读 worker）
//   * worker2/3 只读：只跑只读白名单 action（fetch*），禁写
//   * worker2/3 串行：同一时刻只有一个 worker 活跃（全局 worker lock）
//   * 主1 操作时 worker 不操作（主1 忙时 worker 阻塞）
//   * 用完自动关标签：worker 任务结束即 close
//   * 主1 始终保留（永不 close）
//   * 风险护栏：只读 worker 抓取间隔 ≥3s、并发上限 3、写操作拒进 worker

const WAIT3 = function() { return new Promise(function(r){ setTimeout(r, 3000); }); };

// 只读白名单 action（worker 只能跑这些）
var READONLY_ACTIONS = {
  fetchChatInbox: true,      // P1 正在聊（只读）
  fetchTypedLikes: true,     // P2 点赞（只读）
  fetchAshiato: true,        // P4/P5 足迹（只读）
  fetchFaces: true,          // P6 大厅（只读）
  runProfileSearch: true,    // 高级搜索（只读）
  fetchInbox: true,          // 收件箱（只读）
};

// 写操作黑名单（worker 拒绝；仅主1 可跑）
var WRITE_ACTIONS = {
  sendToContact: true, manageIgnore: true, manageCalendar: true,
  manageDiary: true, manageBbs: true, fillDraft: true,
};

// 全局互斥锁（worker 串行 + 主1 忙时 worker 阻塞）
var workerLock = false;
var mainBusy = false;
var closedTargets = [];

function isReadOnly(action) { return !!READONLY_ACTIONS[action]; }
function isWrite(action) { return !!WRITE_ACTIONS[action]; }

// 主1 操作（可多类，含写）；操作期间置 mainBusy=true，worker 阻塞
function runOnMain(action, deepScrape, opts) {
  mainBusy = true;
  try {
    var m = deepScrape[action];
    if (typeof m !== 'function') return Promise.resolve({ ok: false, reason: 'unknown-action', action: action });
    return Promise.resolve(m.call(deepScrape, opts)).then(function(r) {
      r = r || {};
      r.via = r.via || 'main1-' + action;
      return r;
    });
  } finally {
    mainBusy = false;
  }
}

// 只读 worker（串行 + 主1 忙时阻塞 + 只读白名单）
function runOnWorker(action, deepScrape, opts, tabManager) {
  return new Promise(function(resolve, reject) {
    // 等主1 空闲 + worker 锁
    function tryAcquire() {
      if (mainBusy || workerLock) { setTimeout(tryAcquire, 500); return; }
      workerLock = true;
      // 开新标签（只读 worker 用独立 target，用完 close）
      tabManager.createReadonlyTab().then(function(targetId) {
        var m = deepScrape[action];
        if (typeof m !== 'function') {
          workerLock = false;
          tabManager.closeTab(targetId);
          return resolve({ ok: false, reason: 'unknown-action', action: action });
        }
        // 只读校验
        if (isWrite(action)) {
          workerLock = false;
          tabManager.closeTab(targetId);
          return resolve({ ok: false, reason: 'write-rejected-on-worker', action: action });
        }
        if (!isReadOnly(action)) {
          workerLock = false;
          tabManager.closeTab(targetId);
          return resolve({ ok: false, reason: 'not-readonly-whitelisted', action: action });
        }
        // 风险护栏：worker 抓取间隔 ≥3s
        WAIT3().then(function() {
          return Promise.resolve(m.call(deepScrape, opts)).then(function(r) {
            r = r || {};
            r.via = r.via || 'worker-' + action;
            r.workerTab = true;
            // 用完自动关标签
            tabManager.closeTab(targetId);
            workerLock = false;
            return resolve(r);
          }).catch(function(e) {
            tabManager.closeTab(targetId);
            workerLock = false;
            return reject(e);
          });
        });
      }).catch(function(e) {
        workerLock = false;
        reject(e);
      });
    }
    tryAcquire();
  });
}

module.exports = {
  READONLY_ACTIONS: READONLY_ACTIONS,
  WRITE_ACTIONS: WRITE_ACTIONS,
  runOnMain: runOnMain,
  runOnWorker: runOnWorker,
  isReadOnly: isReadOnly,
  isWrite: isWrite,
};