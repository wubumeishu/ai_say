class MessageMonitor {
  constructor({ devtoolsClient, browserId, pollInterval = 1500, onMessage, logger, profileStore, profileMeta }) {
    this.client = devtoolsClient;
    this.browserId = browserId;
    this.pollInterval = pollInterval;
    this.onMessage = onMessage;
    this.logger = logger || console;
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
      // task-36 修 Bug：onMessage 来自 HTTP body 时函数无法序列化恒 undefined，直接调用抛错被 poll catch 吞 → 监控空转
        if (typeof this.onMessage === 'function') this.onMessage({ text: line, browserId: this.browserId, source: 'poll', ts: Date.now() });
        else if (!this._onMsgWarned) { this._onMsgWarned = true; this.logger.warn('[monitor] onMessage 未配置，消息监控将空转（HTTP body 无法传函数，请用回调注册）'); }
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