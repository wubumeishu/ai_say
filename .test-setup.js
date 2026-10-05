// =============================================================================
// .test-setup.js · 统一测试清理工具（node --test 并行跑多文件时消除 SQLite 残留锁 flaky）
// 每个测试文件在顶部 require('./.test-setup.js')，并在 cleanup 中调用 safeUnlink。
// =============================================================================
'use strict';
const fs = require('fs');

/**
 * 带 retry 的 unlink（SQLite 跨进程锁偶尔让 unlinkSync 失败，重试 3 次）
 * @param {string} filePath
 * @param {object} [opts]
 * @param {number} [opts.maxRetries=3]
 * @param {number} [opts.delayMs=200]
 * @returns {boolean} 是否成功删除
 */
function safeUnlink(filePath, { maxRetries = 3, delayMs = 200 } = {}) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (e) {
      if (i === maxRetries - 1) {
        // 最后一次失败：打印但不 throw（避免 flaky 级联）
        console.warn('[test-setup] safeUnlink failed after ' + maxRetries + ' retries: ' + filePath + ' (' + e.message + ')');
        return false;
      }
      // 同步等待（node 没有 sleepSync，用 Atomics.wait）
      const buf = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(buf, 0, 0, delayMs);
    }
  }
  return false;
}

/**
 * 注册 process exit 钩子，清理残留 .db 文件（防止跨测试文件残留）
 * @param {string[]} dbFiles  要清理的 .db 文件路径列表
 */
function onExitUnlink(dbFiles) {
  process.once('exit', () => {
    for (const f of dbFiles) {
      try { fs.unlinkSync(f); } catch (_) { /* 已不存在则忽略 */ }
    }
  });
}

module.exports = { safeUnlink, onExitUnlink };
