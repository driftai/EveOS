'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const watcherSource = fs.readFileSync(path.join(__dirname, '..', 'extension/content/dex-provider-control.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(__dirname, '..', 'extension/dex-provider-control-bridge.js'), 'utf8');
const MARKER = '[[DEX:CMD {"action":"status","room":"room-eve-astro"}]]';

test('one DIL assistant turn dispatches once despite late content-block reflow', () => {
  let now = 10000;
  const timers = [], sent = [];
  let onMutation;
  const originalTurn = {
    getAttribute(name) { return name === 'data-chatgpt-selection-message-id' ? 'turn-one' : null; }
  };
  let nodes = [
    { innerText: 'Ready.', closest: () => originalTurn },
    { innerText: MARKER, closest: () => originalTurn }
  ];
  const context = {
    window: {},
    document: { body: {} },
    Date: { now: () => now },
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    MutationObserver: class {
      constructor(callback) { onMutation = callback; }
      observe() {}
    },
    chrome: { runtime: {
      onMessage: { addListener() {} },
      sendMessage(msg) { sent.push(msg); return Promise.resolve(); }
    } },
    BrowserAiBridgeChatGptAnswer: {
      assistantNodes: () => nodes,
      latestAssistantText: () => MARKER
    },
    BrowserAiBridgeChatGptInput: { generationLooksActive: () => false }
  };
  vm.runInNewContext(watcherSource, context, { filename: 'dex-provider-control.js' });
  const flush = () => {
    const next = timers.shift();
    assert.ok(next, 'watcher timer is scheduled');
    now += Math.max(next.delay, 451);
    next.fn();
  };
  flush();
  flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].clientActionId, 'chatgpt:message:turn-one');

  nodes.push({ innerText: 'Copy', closest: () => originalTurn });
  onMutation();
  flush();
  assert.equal(sent.length, 1, 'DIL content-block growth cannot replay the same command');
  assert.equal(context.BrowserAiBridgeDexProviderControlContent.diagnostics().duplicateTurnsSuppressed, 1);

  const secondTurn = {
    getAttribute(name) { return name === 'data-chatgpt-selection-message-id' ? 'turn-two' : null; }
  };
  nodes = [{ innerText: MARKER, closest: () => secondTurn }];
  onMutation();
  flush();
  flush();
  assert.equal(sent.length, 2, 'a genuinely new assistant turn can issue the same read-only command');
  assert.equal(sent[1].clientActionId, 'chatgpt:message:turn-two');
});

test('background sends each content action once and injects each result ID once', async () => {
  const outbound = [], injected = [];
  class Socket {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
      this.listeners = new Map();
      queueMicrotask(() => this.listeners.get('open')?.());
    }
    addEventListener(event, fn) { this.listeners.set(event, fn); }
    send(text) { outbound.push(JSON.parse(text)); }
  }
  const context = {
    NexusBrowserRuntimeConfig: { websocketUrl: 'ws://localhost/ws', healthUrl: 'http://localhost/health' },
    BrowserAiBridgeProviders: { providerForUrl: () => ({ id: 'chatgpt', name: 'ChatGPT' }) },
    BrowserAiBridgeProviderAdapterFreshness: { ensure: async () => {} },
    chrome: { tabs: { async sendMessage(tabId, payload) { injected.push({ tabId, payload }); } } },
    fetch: async () => ({ ok: true }),
    WebSocket: Socket,
    // vm contexts do not inherit Node timers; ensureSocket needs both.
    setTimeout,
    clearTimeout,
    setInterval: () => 0
  };
  vm.runInNewContext(bridgeSource, context, { filename: 'dex-provider-control-bridge.js' });
  const bridge = context.BrowserAiBridgeDexProviderControlBridge;
  const sender = { tab: { id: 42, url: 'https://chatgpt.com/c/eve' } };
  const command = {
    type: 'dex_provider_command', providerId: 'chatgpt',
    clientActionId: 'chatgpt:message:turn-one', command: { action: 'status' }
  };
  await Promise.all([
    bridge.handleContentMessage(command, sender),
    bridge.handleContentMessage(command, sender)
  ]);
  const requests = outbound.filter(msg => msg.type === 'provider_control_request');
  assert.equal(requests.length, 1);

  const response = JSON.stringify({
    type: 'provider_control_result',
    requestId: requests[0].requestId,
    source: { targetId: 42, url: sender.tab.url },
    result: { ok: true, message: 'Status read.' }
  });
  bridge.handleServerMessage(response);
  bridge.handleServerMessage(response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(injected.length, 1);
  assert.equal(bridge.diagnostics().duplicateCommandsSuppressed, 1);
  assert.equal(bridge.diagnostics().duplicateResultsSuppressed, 1);
  assert.equal(bridge.diagnostics().lastDeliveryError, null);
});

test('provider negative send acknowledgement is reported rather than mistaken for delivered Dex result', async () => {
  const outbound = [], injected = [];
  class Socket {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
      this.listeners = new Map();
      queueMicrotask(() => this.listeners.get('open')?.());
    }
    addEventListener(event, fn) { this.listeners.set(event, fn); }
    send(text) { outbound.push(JSON.parse(text)); }
  }
  const context = {
    NexusBrowserRuntimeConfig: { websocketUrl: 'ws://localhost/ws', healthUrl: 'http://localhost/health' },
    BrowserAiBridgeProviders: { providerForUrl: () => ({ id: 'chatgpt', name: 'ChatGPT' }) },
    BrowserAiBridgeProviderAdapterFreshness: { ensure: async () => {} },
    chrome: { tabs: { async sendMessage(tabId, payload) {
      injected.push({ tabId, payload });
      return { ok: false, error: 'ChatGPT composer remained populated after submission attempts.' };
    } } },
    fetch: async () => ({ ok: true }),
    WebSocket: Socket,
    setTimeout,
    clearTimeout,
    setInterval: () => 0
  };
  vm.runInNewContext(bridgeSource, context, { filename: 'dex-provider-control-bridge.js' });
  const bridge = context.BrowserAiBridgeDexProviderControlBridge;
  await bridge.handleContentMessage({
    type: 'dex_provider_command', providerId: 'chatgpt',
    clientActionId: 'chatgpt:message:turn-negative-ack', command: { action: 'targets' }
  }, { tab: { id: 42, url: 'https://chatgpt.com/c/eve' } });
  const requests = outbound.filter(msg => msg.type === 'provider_control_request');
  assert.equal(requests.length, 1);
  const response = JSON.stringify({
    type: 'provider_control_result', requestId: requests[0].requestId,
    source: { targetId: 42, url: 'https://chatgpt.com/c/eve' },
    result: { ok: true, message: 'Targets returned.' }
  });
  bridge.handleServerMessage(response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(injected.length, 1);
  assert.equal(bridge.diagnostics().deliveriesRejected, 1);
  assert.equal(bridge.diagnostics().deliveriesAccepted, 0);
  assert.match(bridge.diagnostics().lastDeliveryError, /DEX_RESULT_SUBMISSION_FAILED: ChatGPT composer remained populated/);
  bridge.handleServerMessage(response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(injected.length, 1, 'negative acknowledgement must not trigger unsafe replay');
});
