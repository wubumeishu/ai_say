class MessageMonitor {
  constructor({ devtoolsClient, browserId, pollInterval = 1500, onMessage, logger, profileStore, profileMeta }) {
    this.client = devtoolsClient;
    this.browserId = browserId;
    this.pollInterval = pollInterval;
    this.logger = logger || console;
    // task-6 修 §3.3.4 空转：onMessage 可能来自 HTTP body（函数无法 JSON 序列化，恒 undefined）。
    // 缺省不抛错——分发改走「进程内 sink 列表」registerSink(fn)（函数引用不经 HTTP）；
    // 显式传入的 onMessage 保持旧语义（回归兼容）。
    this.onMessage = typeof onMessage === 'function' ? onMessage : null;
    this.sinks = []; // 进程内消息消费者（registerSink 注册）
    if (!this.onMessage) {
      this.logger.warn && this.logger.warn('[MessageMonitor] onMessage 缺省（HTTP body 无法传函数，§3.3.4），消息分派走 registerSink；未注册 sink 时新消息仅记日志不丢事件');
    }
    this.timer = null;
    this.running = false;
    this.lastTexts = new Set();
    // --- M1 画像接入（task-22，纯增量；不影响既有 onMessage 语义）---
    // profileStore: M0 SQLite store（server/db/store.js 的 createStore() 返回值）。
    //   为 null 时整个画像 hook 关闭，行为与旧版完全一致（JSON/SQLite 共存）。
    // profileMeta: { contactKey, platform, windowId }，把聊天补充写回 upsertContact 用。
    // messageBuffer: 累计聊天消息，供 supplementFromChat 抽取（带上限防无限增长）。
    this.profileStore = profileStore || null;
    this.profileMeta = profileMeta || {};
    this.messageBuffer = [];
    this._profileExtractor = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.poll(), this.pollInterval);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * task-6：注册进程内消息消费者（函数引用不经 HTTP 序列化，消除 onMessage 空转）。
   * @param {(evt: {text:string,browserId:string,source:string,ts:number}) => void} fn
   * @returns {MessageMonitor} this（链式）
   */
  registerSink(fn) {
    if (typeof fn !== 'function') throw new Error('registerSink: fn 必须是函数');
    this.sinks.push(fn);
    return this;
  }

  async poll() {
    try {
      const evalRes = await this.client.evaluate('document.body ? document.body.innerText : ""');
      this.extractMessages(String((evalRes && evalRes.value !== undefined) ? evalRes.value : '') || '');
    } catch (e) {
      this.logger.warn('[monitor] poll failed: ' + e.message);
    }
  }

  extractMessages(pageText) {
    const lines = pageText.split('\n').map((s) => s.trim()).filter(Boolean);
    for (const line of lines.slice(-8)) {
      if (this.lastTexts.has(line)) continue;
      this.lastTexts.add(line);
      if (this.lastTexts.size > 200) this.lastTexts = new Set(Array.from(this.lastTexts).slice(-100));
      const evt = { text: line, browserId: this.browserId, source: 'poll', ts: Date.now() };
      // task-6 分派：显式 onMessage（旧轨回归）+ 进程内 sinks（§3.3.4 修复）
      if (this.onMessage) this.onMessage(evt);
      if (this.sinks.length) {
        for (const fn of this.sinks) {
          try { fn(evt); } catch (err) { this.logger.error && this.logger.error('[monitor] sink 分派失败（不影响其他 sink）:', err && err.message); }
        }
      } else if (!this.onMessage) {
        this.logger.warn && this.logger.warn('[monitor] 新消息行无消费者（onMessage 缺省且未 registerSink）：' + String(line).slice(0, 40));
      }
      // M1 画像 hook：仅在显式传入 profileStore 时生效（增量，旧行为不变）
      if (this.profileStore) {
        this._appendBufferMessage(line);
        this.supplementProfileHook();
      }
    }
  }

  /**
   * 把一条新消息追加进聊天缓冲（供 supplementFromChat 消费）。
   * 带上限：保留最近 40 条，防无限增长。
   */
  _appendBufferMessage(line) {
    const ts = Date.now();
    this.messageBuffer.push({
      role: 'other',
      original: String(line || ''),
      text: String(line || ''),
      timeText: new Date(ts).toISOString(),
      timeIso: new Date(ts).toISOString(),
      ts,
    });
    if (this.messageBuffer.length > 40) {
      this.messageBuffer = this.messageBuffer.slice(-40);
    }
  }

  /**
   * M1 画像 hook（task-22）：
   *   新消息 → createProfileExtractor({store}).supplementFromChat(messages)
   *          → store.upsertContact（单一写入路径，M0 SQLite store）
   * 纯增量、可失败不影响主消息流：profileStore 为 null 时直接返回 null。
   * 失败仅 warn，不抛（不破坏现有监控循环）。
   */
  supplementProfileHook() {
    if (!this.profileStore) return null;
    try {
      if (!this._profileExtractor) {
        const { createProfileExtractor } = require('./db/profileExtractor');
        this._profileExtractor = createProfileExtractor({ store: this.profileStore });
      }
      const extractor = this._profileExtractor;
      const chatResult = extractor.supplementFromChat(this.messageBuffer);
      const merged = extractor.merge({ fields: {} }, chatResult); // 仅聊天来源（monitor 无资料页）
      return extractor.writeProfile({
        contactKey: this.profileMeta.contactKey,
        platform:   this.profileMeta.platform,
        windowId:   this.profileMeta.windowId,
        profile:    merged,
      });
    } catch (e) {
      this.logger.warn && this.logger.warn('[monitor] profile hook failed: ' + e.message);
      return null;
    }
  }
}

module.exports = { MessageMonitor };