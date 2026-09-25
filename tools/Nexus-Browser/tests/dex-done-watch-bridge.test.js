'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '..', 'extension/dex-provider-control-bridge.js'), 'utf8');

function fixture(ack = { ok: true }) {
  const sockets = [], injected = [];
  class Socket {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
      this.listeners = new Map();
      sockets.push(this);
      queueMicrotask(() => this.listeners.get('open')?.());
    }
    addEventListener(event, fn) { this.listeners.set(event, fn); }
    send(text) { this.sent ||= []; this.sent.push(JSON.parse(text)); }
  }
  const context = {
    NexusBrowserRuntimeConfig: { websocketUrl: 'ws://localhost/ws', healthUrl: 'http://localhost/health' },
    BrowserAiBridgeProviders: { providerForUrl: () => ({ id: 'chatgpt', name: 'ChatGPT' }) },
    BrowserAiBridgeProviderAdapterFreshness: { ensure: async () => {} },
    chrome: { tabs: { async sendMessage(tabId, payload) { injected.push({ tabId, payload }); return ack; } } },
    fetch: async () => ({ ok: true }),
    WebSocket: Socket, setTimeout, clearTimeout, setInterval: () => 0
  };
  vm.runInNewContext(code, context);
  return { bridge: context.BrowserAiBridgeDexProviderControlBridge, sockets, injected };
}
const event = {
  type: 'dex_done_watch_event', eventId: 'done-watch-watch-1-msg-1',
  source: { targetClassId: 'online-origin', targetId: 42,
    providerId: 'chatgpt', url: 'https://chatgpt.com/c/eve' },
  text: '[DEX DONE WATCH]\nAstro completed the task.'
};
test('one server DONE event is injected once outside the relay and ACKed once', async () => {
  const { bridge, sockets, injected } = fixture();
  await bridge.ensureSocket();
  bridge.handleServerMessage(JSON.stringify(event));
  bridge.handleServerMessage(JSON.stringify(event));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(injected.length, 1);
  assert.equal(injected[0].tabId, 42);
  assert.equal(injected[0].payload.delivery.kind, 'dex-done-watch');
  assert.equal(injected[0].payload.requestId, 'dex-done-watch-' + event.eventId);
  const acks = sockets[0].sent.filter((msg) => msg.type === 'dex_done_watch_ack');
  assert.equal(acks.length, 1);
  assert.equal(acks[0].ok, true);
  assert.equal(bridge.diagnostics().doneWatchesReceived, 1);
  assert.equal(bridge.diagnostics().doneWatchesConfirmed, 1);
});
test('failed provider submission is recorded and is not automatically retried', async () => {
  const { bridge, sockets, injected } = fixture({ ok: false, error: 'Send button unavailable.' });
  await bridge.ensureSocket();
  bridge.handleServerMessage(JSON.stringify(event));
  bridge.handleServerMessage(JSON.stringify(event));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(injected.length, 1);
  const acks = sockets[0].sent.filter((msg) => msg.type === 'dex_done_watch_ack');
  assert.equal(acks.length, 1);
  assert.equal(acks[0].ok, false);
  assert.match(acks[0].error, /Send button unavailable/);
  assert.equal(bridge.diagnostics().doneWatchesFailed, 1);
});
