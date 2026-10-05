const http = require('http');

class BitBrowserClient {
  constructor(baseUrl) {
    this.baseUrl = (baseUrl || 'http://127.0.0.1:54345').replace(/\/+$/, '');
  }

  call(endpoint, body = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + endpoint);
      const payload = JSON.stringify(body);
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 10000
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(raw); }
          catch { return reject(new Error('比特浏览器返回数据格式异常: ' + raw.slice(0, 300))); }
          if (!parsed.success) {
            return reject(new Error(parsed.msg || '比特浏览器 API 请求失败'));
          }
          resolve(parsed.data !== undefined ? parsed.data : parsed);
        });
      });
      req.on('error', (err) => reject(new Error('无法连接比特浏览器本地服务 ' + this.baseUrl + '：' + err.message)));
      req.on('timeout', () => { req.destroy(new Error('比特浏览器 API 请求超时')); });
      req.write(payload);
      req.end();
    });
  }

  health() { return this.call('/health'); }
  listBrowsers(params = {}) { return this.call('/browser/list', params); }
  openBrowser(body) { return this.call('/browser/open', body); }
  closeBrowser(id) { return this.call('/browser/close', { id }); }

  /**
   * 打开窗口并返回已连接的 DevToolsClient（M5 控制台实时抓页面用）。
   * 调用 /browser/open 拿 { ws, http }，用 ws 连 DevToolsClient，连接成功后返回 client。
   * 调用方负责在不用时 client.close()。
   * @param {string} windowId 比特浏览器窗口 id
   * @param {object} [opts]
   * @param {boolean} [opts.queue] 是否队列方式打开（默认 true，防并发报错）
   * @param {string[]} [opts.args] 浏览器启动参数
   * @returns {Promise<{ client: DevToolsClient, ws: string, http: string, windowId: string }>}
   */
  async openLiveCdp(windowId, opts = {}) {
    const { DevToolsClient } = require('./devtools');
    const data = await this.openBrowser({
      id: windowId,
      queue: opts.queue !== undefined ? opts.queue : true,
      ...(opts.args ? { args: opts.args } : {}),
    });
    const ws = data && (data.ws || data.http);
    if (!ws) throw new Error('比特浏览器 /browser/open 未返回 DevTools 连接信息');
    const client = new DevToolsClient(ws);
    await client.connect();
    return { client, ws: String(ws), http: String((data && data.http) || ''), windowId: String(windowId) };
  }
}

module.exports = { BitBrowserClient };