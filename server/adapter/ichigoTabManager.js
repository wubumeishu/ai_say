'use strict';
// 出会平台 只读 worker 标签管理（ichigoTabManager.js）
// 规则（用户 2026-10-27 定）：
//   * 主1 标签永远保留（main1，可多类操作）
//   * worker2/3 只读标签：用完自动 close
//   * CDP：Target.createTarget（新开标签）+ Target.attachToTarget（attach session）
//   * 风险护栏：worker 标签数量 ≤ 2（加上主1 = 总并发 3）

const http = require('http');

function TabManager(options) {
  this.cdpHost = (options && options.cdpHost) || 'http://127.0.0.1:' + (options && options.debugPort || 9222);
  this.platformUrl = (options && options.platformUrl) || 'https://sp.194964.com/mypage.html';
  this.maxWorkers = (options && options.maxWorkers) || 2; // 主1 之外最多 2 个 worker
  this.openTabs = new Set(); // 当前活跃的 worker tabId
  this.log = options && options.log || function(){};
}

TabManager.prototype._cdpGet = function(path) {
  return new Promise((resolve, reject) => {
    http.get(this.cdpHost + path, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('cdp-get-parse')); } });
    }).on('error', reject);
  });
};

// 开一个只读 worker 标签（navigate 到 platformUrl）
TabManager.prototype.createReadonlyTab = function() {
  var self = this;
  // 护栏：worker 数量上限
  if (this.openTabs.size >= this.maxWorkers) {
    return Promise.resolve({ reason: 'worker-tab-limit', open: this.openTabs.size, max: this.maxWorkers });
  }
  // CDP Target.createTarget
  return http.request({
    host: this.cdpHost.replace(/^http:\/\//, '').split(':')[0],
    port: parseInt(this.cdpHost.replace(/^http:\/\//, '').split(':')[1], 10),
    path: '/json/new?' + encodeURIComponent(this.platformUrl),
    method: 'PUT'
  }, res => {
    let b = '';
    res.on('data', d => b += d);
    res.on('end', () => {
      try {
        var t = JSON.parse(b);
        if (t && t.id) {
          self.openTabs.add(t.id);
          self.log('worker tab opened: ' + t.id);
          // 等标签加载
          setTimeout(function() { resolve({ targetId: t.id, url: self.platformUrl }); }, 4000);
        } else {
          resolve({ reason: 'create-target-no-id', raw: b.slice(0,200) });
        }
      } catch (e) { resolve({ reason: 'create-target-parse-error', raw: b.slice(0,200) }); }
    });
  }).on('error', e => resolve({ reason: 'create-target-network', msg: String(e.message || e) }));
};

// 关闭 worker 标签（主1 不关）
TabManager.prototype.closeTab = function(targetId) {
  if (!targetId) return Promise.resolve({ closed: false });
  this.openTabs.delete(targetId);
  this.log('worker tab closing: ' + targetId);
  return http.request({
    host: this.cdpHost.replace(/^http:\/\//, '').split(':')[0],
    port: parseInt(this.cdpHost.replace(/^http:\/\//, '').split(':')[1], 10),
    path: '/json/close/' + targetId,
    method: 'GET'
  }, res => {
    let b = '';
    res.on('data', d => b += d);
    res.on('end', () => resolve({ closed: true, targetId: targetId }));
  }).on('error', e => resolve({ closed: false, targetId: targetId, err: String(e.message||e) }));
};

// 当前活跃 worker tab 数（护栏监控）
TabManager.prototype.activeWorkerCount = function() {
  return this.openTabs.size;
};

module.exports = { TabManager: TabManager };