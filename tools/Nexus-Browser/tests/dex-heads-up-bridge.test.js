'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../extension/dex-provider-control-bridge.js'), 'utf8');
function fixture(ack = { ok: true }) {
  const sockets = [], injected = [];
  class Socket {
    static OPEN = 1;
    constructor() {
      this.readyState = 1; this.listeners = new Map();
      sockets.push(this);
      queueMicrotask(() => this.listeners.get('open')?.());
    }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    send(raw) { (this.sent ||= []).push(JSON.parse(raw)); }
  }
  const context = {
    NexusBrowserRuntimeConfig: { websocketUrl: 'ws://localhost/ws', healthUrl: 'http://localhost/health' },
    BrowserAiBridgeProviders: { providerForUrl: () => ({ id: 'chatgpt', name: 'ChatGPT' }) },
    BrowserAiBridgeProviderAdapterFreshness: { ensure: async () => {} },
    chrome: { tabs: { async sendMessage(tabId, payload) { injected.push({ tabId, payload }); return ack; } } },
    fetch: async () => ({ ok: true }), WebSocket: Socket,
    setTimeout, clearTimeout, setInterval: () => 0
  };
  vm.runInNewContext(source, context);
  return { bridge: context.BrowserAiBridgeDexProviderControlBridge, sockets, injected };
}
const event = { type: 'dex_done_watch_event', kind: 'heads-up',
  eventId: 'headsup-msg-1-eve',
  source: { targetClassId: 'online-origin', targetId: 42,
    providerId: 'chatgpt', url: 'https://chatgpt.com/c/eve' },
  text: '[DEX HEADS UP]\nAstro completed the qualification and explicitly requested Eve.'
};
test('one exact-recipient HEADSUP is injected once, with its own non-relay delivery category', async () => {
  const { bridge, sockets, injected } = fixture();
  await bridge.ensureSocket();
  bridge.handleServerMessage(JSON.stringify(event));
  bridge.handleServerMessage(JSON.stringify(event));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(injected.length, 1);
  assert.equal(injected[0].tabId, 42);
  assert.equal(injected[0].payload.delivery.kind, 'dex-heads-up');
  assert.equal(injected[0].payload.requestId, 'dex-heads-up-' + event.eventId);
  const receipts = sockets[0].sent.filter((packet) => packet.type === 'dex_done_watch_ack');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].eventId, event.eventId);
  assert.equal(receipts[0].ok, true);
  assert.equal(bridge.diagnostics().headsUpsReceived, 1);
  assert.equal(bridge.diagnostics().headsUpsConfirmed, 1);
});
test('uncertain provider acknowledgement fails visibly without generating a retry or another relay turn', async () => {
  const { bridge, sockets, injected } = fixture({ ok: false, error: 'Composer did not submit.' });
  await bridge.ensureSocket();
  bridge.handleServerMessage(JSON.stringify(event));
  bridge.handleServerMessage(JSON.stringify(event));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(injected.length, 1);
  const receipts = sockets[0].sent.filter((packet) => packet.type === 'dex_done_watch_ack');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].ok, false);
  assert.match(receipts[0].error, /Composer did not submit/);
  assert.equal(bridge.diagnostics().headsUpsFailed, 1);
});
