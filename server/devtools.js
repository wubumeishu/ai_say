const WebSocket = require('ws');

// 页面级 ws 的 CDP 命令自增整数 id（CDP 要求整数 id，字符串 id 会报 'Message must have integer id'）
let pageSeq = 0;

class DevToolsClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.eventListeners = new Set();
    this.attachedSessions = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl, { perMessageDeflate: false });
      this.ws.on('open', () => resolve(this));
      this.ws.on('error', (err) => reject(new Error('DevTools WebSocket 连接失败: ' + err.message)));
      this.ws.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.method === 'Target.attachedToTarget') {
          if (msg.params && msg.params.targetInfo && msg.params.targetInfo.targetId) {
            this.attachedSessions.set(msg.params.targetInfo.targetId, msg.params.sessionId);
          }
        }
        for (const listener of this.eventListeners) {
          try { listener(msg); } catch (e) { /* 事件监听器异常不阻断消息循环 */ }
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || 'DevTools 错误'));
          else resolve(msg.result);
        }
      });
    });
  }

  send(method, params = {}) {
    this.seq += 1;
    const id = this.seq;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('DevTools 命令超时: ' + method));
      }, 8000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      this.ws.send(payload);
    });
  }

  addEventListener(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async attachTarget(targetId, flatten = true) {
    const result = await this.send('Target.attachToTarget', { targetId, flatten });
    if (result && result.sessionId) {
      this.attachedSessions.set(targetId, result.sessionId);
    }
    return result;
  }

  sessionIdForTarget(targetId) {
    return this.attachedSessions.get(targetId);
  }

  async evaluate(expression, targetId) {
    const params = { expression, returnByValue: true };
    let targetInfo = null;
    let sessionId = this.sessionIdForTarget(targetId);
    if (targetId && !sessionId) {
      await this.attachTarget(targetId);
      sessionId = this.sessionIdForTarget(targetId);
    }
    if (sessionId) {
      params.sessionId = sessionId;
    } else if (targetId) {
      const targets = await this.send('Target.getTargets');
      targetInfo = (targets.targetInfos || []).find((t) => t.targetId === targetId) || null;
    }
    const result = await this.send('Runtime.evaluate', params);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception && result.exceptionDetails.exception.description || '页面脚本执行异常');
    }
    return { value: result.result ? result.result.value : undefined, targetInfo };
  }

  // Capture a screenshot of the (current) page via CDP and return a base64 data URL.
  async captureScreenshot(targetId, opts) {
    const params = Object.assign({ format: 'png' }, opts || {});
    if (targetId) {
      const sid = this.sessionIdForTarget(targetId);
      if (!sid) await this.attachTarget(targetId);
      if (this.sessionIdForTarget(targetId)) params.sessionId = this.sessionIdForTarget(targetId);
    }
    const res = await this.send('Page.captureScreenshot', params);
    return String((res && res.data) || '');
  }

  close() {
    if (this.ws) this.ws.close();
  }

  /**
   * 页面级 ws 直连 evaluate（Bug 1 可靠通道，出会/快乐共用）。
   * 根因（总控 18595 真连冒烟坐实）：BitBrowser CDP 桥的浏览器级 ws 上
   *   Target.attachToTarget(flatten) 拿到的 attach sessionId 不支持 Runtime.evaluate
   *   （报 'Runtime.evaluate' wasn't found）。可行通道 = /json/list（HTTP）拿 page target 的
   *   webSocketDebuggerUrl（ws://host:port/devtools/page/{id}），直连该页面级 ws 发
   *   Runtime.evaluate（【不带 sessionId / 不做 Runtime.enable 握手】）→ 直接应答。
   * 参数：expression + targetId（page target id，仅用于无 pageWsUrl 时自动 resolvePageWs）
   *       + pageWsUrl（/devtools/page/{id} ws，缺时本方法 fetch /json/list 按 targetId 补）
   *       + cdpHttp（CDP http 端点 host:port，缺省用本 client 浏览器级 ws 同 host:port）
   * 页面级 ws 用完即关（仿 ichigoDeepScrape L205-208 withTargetOnce 模式）。
   * @returns {Promise<{value, targetInfo}>}（与 evaluate 主路径返回形态一致，调用方 res.value 取真值）
   */
  async evaluatePage(expression, targetId, pageWsUrl, cdpHttp) {
    let wsUrl = String(pageWsUrl || '');
    if (!wsUrl && targetId) {
      wsUrl = await this.resolvePageWs(targetId, cdpHttp);
    }
    if (wsUrl) {
      const pageWs = new WebSocket(wsUrl, { perMessageDeflate: false });
      await new Promise((resolve, reject) => {
        pageWs.once('open', () => resolve());
        pageWs.once('error', (err) => reject(new Error('页面级 ws 连接失败: ' + err.message)));
      });
      try {
        const reqId = ++pageSeq; // 整数 id（CDP 要求；字符串 id 报 'Message must have integer id'）
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('页面级 Runtime.evaluate 超时')), 15000);
          const onMsg = (data) => {
            const msg = JSON.parse(String(data));
            if (msg.id === reqId) {
              clearTimeout(timer);
              pageWs.off('message', onMsg);
              if (msg.error) reject(new Error(msg.error.message || 'CDP 页面级 evaluate 错误'));
              else resolve(msg.result);
            }
          };
          pageWs.on('message', onMsg);
          pageWs.send(JSON.stringify({ id: reqId, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
        });
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.exception && result.exceptionDetails.exception.description || '页面脚本执行异常');
        }
        // devtools.evaluate 返回 { value, targetInfo } 包装——evaluatePage 同形态，调用方 res.value 取真值
        return { value: result.result ? result.result.value : undefined, targetInfo: null };
      } finally {
        try { pageWs.close(); } catch (e) { /* ignore */ }
      }
    }
    // 无页面级 ws（targetId 缺失/拿不到）→ 回退浏览器级会话路由 evaluate（主路径，会话正常时可用）
    return this.evaluate(expression, targetId);
  }

  /**
   * 从 CDP /json/list（HTTP）按 targetId 取 page target 的 webSocketDebuggerUrl（缺时 evaluatePage 自动补）。
   */
  async resolvePageWs(targetId, cdpHttp) {
    const http = require('http');
    let hostPort = String(cdpHttp || '').replace(/^https?:\/\//, '');
    if (!hostPort && this.wsUrl) {
      const m = String(this.wsUrl).match(/^wss?:\/\/([^/]+)/);
      hostPort = m ? m[1] : '';
    }
    if (!hostPort) return '';
    const url = 'http://' + hostPort + '/json/list';
    try {
      const targets = await new Promise((resolve, reject) => {
        http.get(url, (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(raw);
              resolve(Array.isArray(parsed) ? parsed : []);
            } catch (e) { reject(e); }
          });
        }).on('error', reject);
      });
      const hit = (targets || []).find((t) => t && t.id === targetId && t.webSocketDebuggerUrl);
      return hit ? String(hit.webSocketDebuggerUrl) : '';
    } catch (e) {
      // /json/list 拿不到（404/解析失败）→ 回空（evaluatePage 回退会话路由）
      return '';
    }
  }
}

module.exports = { DevToolsClient };
