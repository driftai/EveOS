'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../extension/dex-provider-control-bridge.js'), 'utf8');
const ACTIONS = require('../public/dex-provider-control').ACTIONS;
function harness(accept) {
  const outbound = [], injected = [];
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 1; this.listeners = new Map();
      queueMicrotask(() => this.listeners.get('open')?.()); }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    send(raw) { outbound.push(JSON.parse(raw)); }
  }
  const context = {
    NexusBrowserRuntimeConfig: { websocketUrl: 'ws://localhost/ws',
      healthUrl: 'http://localhost/health' },
    BrowserAiBridgeProviders: { providerForUrl: () => ({ id: 'chatgpt', name: 'ChatGPT' }) },
    BrowserAiBridgeProviderAdapterFreshness: { ensure: async () => {} },
    BrowserAiBridgeDexToolResult: { formatResult: (result, id) =>
      '[DEX TOOL RESULT]\n' + (result.ok ? 'OK' : 'ERROR ' + result.code)
      + ': ' + result.message + '\nRequest ID: ' + id },
    chrome: { tabs: { async sendMessage(tabId, payload) {
      injected.push({ tabId, payload });
      return accept ? { ok: true, submissionMode: 'click' }
        : { ok: false, error: 'Composer gesture did not complete.' };
    } } },
    fetch: async () => ({ ok: true }), WebSocket: Socket,
    setTimeout, clearTimeout, setInterval: () => 0
  };
  vm.runInNewContext(source, context, { filename: 'dex-provider-control-bridge.js' });
  return { bridge: context.BrowserAiBridgeDexProviderControlBridge,
    outbound, injected };
}
async function exercise(accept) {
  const h = harness(accept);
  const sender = { tab: { id: 42, url: 'https://chatgpt.com/c/exact' } };
  let index = 0;
  for (const action of ACTIONS) {
    const request = h.bridge.handleContentMessage({ type: 'dex_provider_command',
      providerId: 'chatgpt', clientActionId: 'message-' + index,
      command: { action, room: 'room-one' } }, sender);
    await new Promise(resolve => setImmediate(resolve));
    const dispatched = h.outbound.filter(x => x.type === 'provider_control_request').at(-1);
    assert.equal(dispatched.command.action, action);
    h.bridge.handleServerMessage(JSON.stringify({ type: 'provider_control_received',
      requestId: dispatched.requestId }));
    assert.equal((await request).accepted, true);
    const result = JSON.stringify({ type: 'provider_control_result',
      requestId: dispatched.requestId, source: { targetId: 42, url: sender.tab.url },
      result: { ok: true, action, message: action + ' completed' } });
    h.bridge.handleServerMessage(result);
    h.bridge.handleServerMessage(result); // duplicate result must never submit twice
    await new Promise(resolve => setImmediate(resolve));
    index++;
  }
  assert.equal(h.injected.length, ACTIONS.size);
  assert.equal(h.bridge.diagnostics().duplicateResultsSuppressed, ACTIONS.size);
  for (const { tabId, payload } of h.injected) {
    assert.equal(tabId, 42);
    assert.match(payload.text, /^\[DEX TOOL RESULT\]\nOK:/);
    assert.match(payload.text, /Request ID:/);
    assert.equal(payload.delivery.kind, 'dex-control-result');
  }
  assert.equal(h.bridge.diagnostics().deliveriesAccepted, accept ? ACTIONS.size : 0);
  assert.equal(h.bridge.diagnostics().deliveriesRejected, accept ? 0 : ACTIONS.size);
}
test('all registered CMDs use the same exact-tab positive submission ACK', async () => {
  await exercise(true);
});
test('all registered CMDs treat negative composer ACK as not delivered, never replay', async () => {
  await exercise(false);
});
