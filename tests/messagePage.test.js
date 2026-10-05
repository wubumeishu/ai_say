const test = require('node:test');
const assert = require('node:assert');
const {
  buildMessagePageScanJs,
  normalizeTime,
  normalizeMessageItem,
  detectPeerName,
  summarizeMessagePage,
  translateMessages
} = require('../server/messagePageScanner');

test('buildMessagePageScanJs returns an IIFE string that references message selectors', () => {
  const js = buildMessagePageScanJs();
  assert.ok(typeof js === 'string' && js.length > 100);
  assert.ok(js.includes('(function () {'));
  assert.ok(js.includes('[class*=message]'));
  assert.ok(js.includes('devtools-message-scan'));
  assert.ok(js.includes('peerNames'));
  assert.ok(js.includes('bottomNav'));
  assert.ok(js.includes('timestamp'));
});

test('normalizeTime builds structured time info', () => {
  const info = normalizeTime({ timeText: '2025/01/15 10:30', time: { iso: '2025-01-15 10:30:00' } });
  assert.strictEqual(info.text, '2025/01/15 10:30');
  assert.strictEqual(info.iso, '2025-01-15 10:30:00');
  assert.strictEqual(info.has, true);
  assert.ok(info.parsedIso, 'parsedIso should be set for valid iso');
});

test('normalizeTime handles marker-only text', () => {
  const info = normalizeTime({ timeText: '昨日 10:30' });
  assert.strictEqual(info.marker, 'yesterday');
  assert.strictEqual(info.time, '10:30:00');
  assert.strictEqual(info.has, true);
});

test('normalizeMessageItem preserves role, name and time', () => {
  const item = normalizeMessageItem({
    rawText: 'こんにちは',
    role: 'other',
    name: '田中さん',
    timeText: '2025/01/15 10:30',
    time: { iso: '2025-01-15 10:30:00' },
    kind: 'text',
    url: '',
    selector: 'div.chat-item > .bubble'
  }, 7);
  assert.strictEqual(item.index, 7);
  assert.strictEqual(item.text, 'こんにちは');
  assert.strictEqual(item.original, 'こんにちは');
  assert.strictEqual(item.role, 'other');
  assert.strictEqual(item.name, '田中さん');
  assert.strictEqual(item.time.iso, '2025-01-15 10:30:00');
  assert.strictEqual(item.selector, 'div.chat-item > .bubble');
  assert.strictEqual(item.translation, '');
});

test('detectPeerName prefers named message item over page title', () => {
  const raw = {
    page: { url: 'https://sp.example.com/sns/message/', title: 'メッセージ' },
    peerNames: ['メッセージ'],
    messages: [
      { rawText: 'こんにちは', name: '田中さん', role: 'other' },
      { rawText: 'はじめまして', role: 'self' }
    ]
  };
  const peer = detectPeerName(raw, {});
  assert.strictEqual(peer.name, '田中さん');
  assert.strictEqual(peer.source, 'message-item-name');
  assert.ok(Array.isArray(peer.candidates));
});

test('detectPeerName falls back to peerNames when no named message item exists', () => {
  const raw = {
    page: { url: 'https://sp.example.com/sns/message/', title: 'メッセージ' },
    peerNames: ['山田', '佐藤'],
    messages: [
      { rawText: 'こんにちは', role: 'other' },
      { rawText: 'はじめまして', role: 'self' }
    ]
  };
  const peer = detectPeerName(raw, {});
  assert.strictEqual(peer.name, '山田');
  assert.strictEqual(peer.source, 'page-header-or-title');
});

test('summarizeMessagePage returns a full summary with messages, peer, profile and detection', () => {
  const raw = {
    source: 'devtools-message-scan',
    page: { url: 'https://sp.example.com/sns/message/', title: 'メッセージ', readyState: 'complete' },
    messages: [
      { rawText: 'こんにちは', role: 'other', name: '田中さん', timeText: '2025/01/15 10:30', time: { iso: '2025-01-15 10:30:00' } },
      { rawText: 'はじめまして', role: 'self', timeText: '2025/01/15 10:31' }
    ],
    peerNames: ['田中さん'],
    profile: [
      { label: '年齢', value: '30', selector: '.profile-detail .item' }
    ],
    nextActions: ['詳細を見る', 'プロフィール'],
    bottomNav: [
      { label: 'メッセージ', url: '/sns/message/', badge: '99', selector: '.bottom-nav-item' }
    ],
    lines: ['田中さん', 'こんにちは'],
    timestamp: '2025-01-15T10:35:00.000Z'
  };
  const summary = summarizeMessagePage(raw);
  assert.strictEqual(summary.ok, true);
  assert.strictEqual(summary.source, 'devtools-message-scan');
  assert.strictEqual(summary.peer.name, '田中さん');
  assert.strictEqual(summary.messages.length, 2);
  assert.strictEqual(summary.messages[0].original, 'こんにちは');
  assert.strictEqual(summary.messages[0].role, 'other');
  assert.strictEqual(summary.messages[0].time.iso, '2025-01-15 10:30:00');
  assert.strictEqual(summary.profile.length, 1);
  assert.strictEqual(summary.profile[0].label, '年齢');
  assert.strictEqual(summary.nextActions.length, 2);
  assert.strictEqual(summary.bottomNav.length, 1);
  assert.strictEqual(summary.bottomNav[0].label, 'メッセージ');
  assert.strictEqual(summary.detection.isLikelyMessagePage, true);
  assert.strictEqual(summary.scannedAt, '2025-01-15T10:35:00.000Z');
});

test('summarizeMessagePage handles empty raw input', () => {
  const summary = summarizeMessagePage({});
  assert.strictEqual(summary.ok, true);
  assert.strictEqual(summary.peer.name, '');
  assert.deepStrictEqual(summary.messages, []);
  assert.deepStrictEqual(summary.profile, []);
  assert.strictEqual(summary.detection.isLikelyMessagePage, false);
});

test('translateMessages applies translator to each message and preserves order', async () => {
  const messages = [
    { original: 'こんにちは', text: 'こんにちは', role: 'other' },
    { original: 'さようなら', text: 'さようなら', role: 'self' }
  ];
  const translator = (text) => Promise.resolve('【中文】' + text);
  const out = await translateMessages(messages, translator);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].translation, '【中文】こんにちは');
  assert.strictEqual(out[1].translation, '【中文】さようなら');
  assert.strictEqual(out[0].role, 'other');
});

test('translateMessages falls back to original text when translator rejects', async () => {
  const messages = [{ original: 'こんにちは', text: 'こんにちは' }];
  const translator = () => Promise.reject(new Error('translator down'));
  const out = await translateMessages(messages, translator);
  assert.strictEqual(out[0].translation, 'こんにちは');
});

test('app.js exposes /api/messages/inspect route', () => {
  const fs = require('fs');
  const appSrc = fs.readFileSync(__dirname + '/../server/app.js', 'utf8');
  assert.ok(appSrc.includes('/api/messages/inspect'));
  assert.ok(appSrc.includes('readMessagePage'));
  assert.ok(appSrc.includes('buildMessagePageScanJs'));
  assert.ok(appSrc.includes('summarizeMessagePage'));
  assert.ok(appSrc.includes('translateMessages'));
});