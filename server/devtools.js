const WebSocket = require('ws');

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
          try { listener(msg); } catch {}
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
}

module.exports = { DevToolsClient };