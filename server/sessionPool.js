// DevTools session pool: keep one long-lived CDP connection per browser window.
// Reuse existing /api/monitor sessions where present, otherwise lazily open a
// BitBrowser window and connect. Sessions are cached, health-checked and
// transparently recovered on connection-level failures.

const { BitBrowserClient } = require('./bitbrowser');
const { DevToolsClient } = require('./devtools');
const { fetchDevtoolsTargetList, pickProfileTarget } = require('./devtoolsTargets');

class SessionPool {
  constructor({ bit, apiBase, log }) {
    this.bit = bit || null;
    this.apiBase = apiBase || 'http://127.0.0.1:54345';
    this.log = log || console;
    this.sessions = new Map(); // browserId -> session
  }

  // Adopt an already-connected DevTools client (e.g. from /api/monitor).
  adopt(browserId, client) {
    this.sessions.set(String(browserId), {
      client,
      browserId: String(browserId),
      ws: client.wsUrl,
      targetId: null,
      lastUsed: Date.now(),
      lastError: null,
      closing: false
    });
  }

  release(browserId) {
    const s = this.sessions.get(String(browserId));
    if (!s) return false;
    this.sessions.delete(String(browserId));
    s.closing = true;
    try { s.client.close(); } catch {}
    return true;
  }

  stopAll() {
    for (const id of Array.from(this.sessions.keys())) this.release(id);
  }

  get size() { return this.sessions.size; }

  // Run fn(client, session) on a healthy pooled session; recover once on connection errors.
  async withSession(browserId, fn) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let session = this.sessions.get(String(browserId));
      if (!session || session.closing) {
        session = await this.open(browserId);
      } else {
        const ok = session.client.ws && (session.client.ws.readyState === 1 || session.client.ws.readyState === 0);
        if (!ok) {
          this.log.warn && this.log.warn('[session-pool] stale session for ' + browserId + ', reconnecting');
          this.sessions.delete(String(browserId));
          session.closing = true;
          try { session.client.close(); } catch {}
          session = await this.open(browserId);
        }
      }
      session.lastUsed = Date.now();
      try {
        session.lastError = null;
        return await fn(session.client, session);
      } catch (err) {
        session.lastError = err && err.message;
        const fatal = /连接失败|close|socket|websocket|ECONNRESET/i.test(String(err && err.message));
        if (fatal && attempt === 0) {
          this.log.warn && this.log.warn('[session-pool] devtools error for ' + browserId + ': ' + err.message + ' — recovering');
          this.sessions.delete(String(browserId));
          session.closing = true;
          try { session.client.close(); } catch {}
          continue;
        }
        throw err;
      }
    }
    throw new Error('session pool: unable to establish connection for ' + browserId);
  }

  async open(browserId) {
    const bit = this.bit || new BitBrowserClient(this.apiBase);
    const data = await bit.openBrowser({ id: browserId, queue: true });
    const ws = data.ws || data.http;
    if (!ws) throw new Error('比特浏览器未返回 DevTools 连接信息');
    const client = new DevToolsClient(ws);
    await client.connect();
    // Best-effort: attach a stable page target (profile-looking preferred).
    let targetId = null;
    try {
      const targets = await fetchDevtoolsTargetList(ws);
      const page = pickProfileTarget(targets, []);
      if (page && page.id) {
        targetId = page.id;
        await client.attachTarget(targetId, true).catch(() => {});
      }
    } catch {}
    const session = {
      client,
      browserId: String(browserId),
      ws,
      targetId,
      lastUsed: Date.now(),
      lastError: null,
      closing: false
    };
    this.sessions.set(String(browserId), session);
    this.log.log && this.log.log('[session-pool] opened session for window ' + browserId + ' (' + ws + ')');
    return session;
  }
}

module.exports = { SessionPool };
