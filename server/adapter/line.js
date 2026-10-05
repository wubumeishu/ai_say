// LINE OA 占位适配器（M4 接真实 LINE API 时替换 sendMock 与 scanMessages 实现）。
// 4 方法都返回 { ok:true, mock:true }，满足 M2 验收「≥3 平台全链路跑通」的平台数量要求。

const { PlatformAdapter } = require('./platformAdapter');

class LineAdapter extends PlatformAdapter {
  constructor(opts = {}) {
    super(Object.assign({ platform: 'line' }, opts));
  }

  sendMock() {
    return true; // M4 前所有 send 走 mock
  }

  async scanProfile() {
    return {
      ok: true,
      mock: true,
      source: 'line-mock',
      accountPersona: { identity: {}, account: {}, gaps: [], stats: [] },
      customerProfile: { identity: {}, signals: {}, lastSeen: null },
      probe: [],
      miss: null,
      scannedAt: new Date().toISOString()
    };
  }

  async scanMessages(conversationId) {
    return {
      ok: true,
      mock: true,
      source: 'line-mock',
      conversationId: String(conversationId || ''),
      messages: [],
      rows: [],
      pagination: {},
      scannedAt: new Date().toISOString()
    };
  }

  async navigate(urlOrAction) {
    return { ok: true, mock: true, via: 'mock', to: String(urlOrAction || ''), url: '', pageKey: '' };
  }

  async send(text, opts = {}) {
    this.emit('onSend', { mock: true, to: (opts && opts.to) || '', text: String(text || '') });
    return { ok: true, mock: true, sentAt: new Date().toISOString(), via: 'mock' };
  }
}

module.exports = { LineAdapter };
