'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const bridge = require('../service-workspace-bridge');

const TLO_ID = 'local:tlo-chat:default';
const MOE_ID = 'local:local-moe-chat:default';
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HOST_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, 'js', 'modules', 'gemini', 'search_monitor', 'nexusServiceChatBridge.js'),
  'utf8'
);

function socket() {
  return { readyState: 1, sent: [] };
}

function configure() {
  bridge._resetForTests();
  bridge.configure({
    safeSend(ws, payload) {
      ws.sent.push(payload);
      return true;
    }
  });
}

function target(id, providerId, providerName) {
  return { id, providerId, providerName };
}

function hostLifecycleHarness() {
  let mutation = null;
  let runtime = { running: true, state: 'running', url: 'http://127.0.0.1:9088/' };
  const listeners = new Map(), sockets = [];
  const frame = {
    nodeType: 1, src: runtime.url,
    getAttribute(name) { return name === 'src' ? this.src : ''; },
    matches(selector) { return selector === '[data-nexus-browser-frame]'; }
  };
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(url) { this.url = url; this.readyState = 1; this.listeners = new Map(); sockets.push(this); }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    send() {}
    close() { this.closed = true; this.readyState = 3; this.listeners.get('close')?.(); }
  }
  const window = {
    crypto: { randomUUID: () => 'workspace-test' },
    location: { href: 'file:///EveOS.html' },
    EveOSPortRegistry: { url: () => runtime.url },
    EveOSNexusBrowser: { runtimeSnapshot: () => runtime },
    WebSocket: FakeWebSocket,
    setTimeout(fn) { fn(); return 1; }, clearTimeout() {},
    setInterval() { return 2; }, clearInterval() {},
    addEventListener(type, fn) { listeners.set(type, fn); }
  };
  const document = { documentElement: {}, querySelector: () => frame };
  class MutationObserver { constructor(fn) { mutation = fn; } observe() {} }
  vm.runInNewContext(HOST_SOURCE, { window, document, WebSocket: FakeWebSocket, MutationObserver, URL },
    { filename: 'nexusServiceChatBridge.js' });
  return {
    bridge: window.EveOSServiceChatBridge,
    sockets,
    blankFrame() {
      frame.src = 'about:blank';
      mutation([{ type: 'attributes', target: frame }]);
    },
    runtimeStopped() {
      runtime = { running: false, state: 'stopped', url: runtime.url };
      listeners.get('eveos:nexus-browser-runtime')?.({ detail: runtime });
    }
  };
}

test('routes TLO through the registered Search Monitor workspace and preserves streaming events', async () => {
  configure();
  const ws = socket();
  bridge.registerHost(ws, { workspaceId: 'search-monitor-a', targets: [TLO_ID, MOE_ID] });
  assert.equal(bridge.snapshot(TLO_ID).bound, true);

  const events = [];
  const turn = bridge.sendPrompt({
    requestId: 'turn-1',
    text: 'This chat',
    target: target(TLO_ID, 'tlo-chat', 'TLO'),
    emit: (event) => events.push(event),
    timeoutMs: 1000
  });

  const dispatch = ws.sent.find((message) => message.type === 'service_workspace_request');
  assert.deepEqual(dispatch, {
    type: 'service_workspace_request',
    targetId: TLO_ID,
    requestId: 'turn-1',
    text: 'This chat',
    workspaceId: 'search-monitor-a'
  });
  assert.equal(bridge.snapshot(TLO_ID).busy, true);

  bridge.handleHostMessage(ws, {
    type: 'service_workspace_partial', targetId: TLO_ID, requestId: 'turn-1',
    workspaceId: 'search-monitor-a', text: 'same'
  });
  bridge.handleHostMessage(ws, {
    type: 'service_workspace_final', targetId: TLO_ID, requestId: 'turn-1',
    workspaceId: 'search-monitor-a', text: 'same conversation',
    capabilityContext: { schema: 'eveos.agent-capability-context.v1', digest: 'a'.repeat(64),
      packs: [{ id: 'machine-spaces', revision: 'b'.repeat(24), sha256: 'c'.repeat(64) }] }
  });

  assert.equal(await turn, 'same conversation');
  assert.deepEqual(events.map((event) => [event.type, event.text]), [
    ['response_partial', 'same'],
    ['response_final', 'same conversation']
  ]);
  assert.equal(events.at(-1).controlEvidence, undefined);
  assert.equal(bridge.snapshot(TLO_ID).busy, false);
  assert.equal(events.at(-1).capabilityContext.packs[0].id, 'machine-spaces');
});

test('server workspace boundary binds control-like final payloads to privacy-safe evidence', async () => {
  configure();
  const ws = socket(), events = [];
  bridge.registerHost(ws, { workspaceId: 'search-monitor-control', targets: [TLO_ID] });
  const turn = bridge.sendPrompt({ requestId: 'turn-control', text: 'request commands',
    target: target(TLO_ID, 'tlo-chat', 'TLO'), emit: (event) => events.push(event), timeoutMs: 1000 });
  const text = 'Requesting.\n[[DEX:CMD {"action":"onboard"}]]';
  bridge.handleHostMessage(ws, { type: 'service_workspace_final', targetId: TLO_ID,
    requestId: 'turn-control', workspaceId: 'search-monitor-control', text });
  assert.equal(await turn, text);
  const evidence = events.at(-1).controlEvidence;
  assert.equal(evidence.schema, 'eveos.dex-final-control-evidence.v1');
  assert.equal(evidence.payloadChars, text.length);
  assert.match(evidence.payloadSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(evidence).includes(text), false);
});

test('fails closed instead of inventing a second Local MoE conversation', async () => {
  configure();
  await assert.rejects(
    bridge.sendPrompt({
      requestId: 'turn-2', text: 'hello',
      target: target(MOE_ID, 'local-moe-chat', 'Local MoE'),
      timeoutMs: 1000
    }),
    (error) => error.code === 'SEARCH_MONITOR_WORKSPACE_UNAVAILABLE'
  );
});

test('newest Search Monitor host replaces the old owner and rejects its in-flight turn', async () => {
  configure();
  const oldHost = socket();
  const newHost = socket();
  bridge.registerHost(oldHost, { workspaceId: 'old', targets: [TLO_ID] });
  const turn = bridge.sendPrompt({
    requestId: 'turn-3', text: 'hello', target: target(TLO_ID, 'tlo-chat', 'TLO'), timeoutMs: 1000
  });
  bridge.registerHost(newHost, { workspaceId: 'new', targets: [TLO_ID] });
  await assert.rejects(turn, (error) => error.code === 'SEARCH_MONITOR_WORKSPACE_REPLACED');
  assert.equal(bridge.snapshot(TLO_ID).workspaceId, 'new');
});

test('embedded-to-detached iframe transitions preserve the service host until the runtime actually stops', () => {
  const h = hostLifecycleHarness();
  assert.equal(h.bridge.isEnabled(), true);
  assert.equal(h.sockets.length, 1);
  h.blankFrame();
  assert.equal(h.bridge.isEnabled(), true);
  assert.equal(h.sockets[0].closed, undefined);
  h.runtimeStopped();
  assert.equal(h.bridge.isEnabled(), false);
  assert.equal(h.sockets[0].closed, true);
});

test('active request closure is terminal, late finals are ignored, and reconnect does not replay', async () => {
  configure();
  const first = socket();
  bridge.registerHost(first, { workspaceId: 'stable-page', targets: [TLO_ID] });
  const turn = bridge.sendPrompt({ requestId: 'turn-disconnected', text: 'once',
    target: target(TLO_ID, 'tlo-chat', 'TLO'), timeoutMs: 1000 });
  assert.equal(first.sent.filter((message) => message.type === 'service_workspace_request').length, 1);
  bridge.unregisterHost(first);
  await assert.rejects(turn, (error) => error.code === 'SEARCH_MONITOR_WORKSPACE_DISCONNECTED');

  const replacement = socket();
  bridge.registerHost(replacement, { workspaceId: 'stable-page', targets: [TLO_ID] });
  assert.equal(replacement.sent.filter((message) => message.type === 'service_workspace_request').length, 0);
  bridge.handleHostMessage(replacement, { type: 'service_workspace_final', targetId: TLO_ID,
    requestId: 'turn-disconnected', workspaceId: 'stable-page', text: 'late' });
  assert.equal(bridge.snapshot(TLO_ID).busy, false);
});

test('service-chat adapter has no shadow history or direct inference route', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'local-targets', 'eveos-service-chats.js'), 'utf8');
  assert.match(source, /serviceWorkspaceBridge\.sendPrompt/);
  assert.match(source, /shared-search-monitor-workspace/);
  assert.doesNotMatch(source, /createHistoryStore/);
  assert.doesNotMatch(source, /\/api\/chat\/stream/);
  assert.doesNotMatch(source, /\/api\/eve-state\/modular\/tlo\/chat\/stream/);
});

test('TLO Nexus path calls the mounted Search Monitor TLO chat instead of its own provider route', () => {
  const host = fs.readFileSync(
    path.join(REPO_ROOT, 'js', 'modules', 'gemini', 'search_monitor', 'nexusServiceChatBridge.js'),
    'utf8'
  );
  const tlo = fs.readFileSync(
    path.join(REPO_ROOT, 'js', 'modules', 'gemini', 'search_monitor', 'tloChat.js'),
    'utf8'
  );
  assert.match(host, /EveOSTloChat/);
  assert.match(host, /sendWorkspaceMessage/);
  assert.doesNotMatch(host, /\/api\/eve-state\/modular\/tlo\/chat\/stream/);
  assert.match(tlo, /const priorHistory = conversation\.slice\(-40\)/);
  assert.match(tlo, /external: true/);
  assert.match(tlo, /conversation\.push\(\{ role: 'assistant'/);
});

test('Gemini manifest keeps credential workflow while loading the Search Monitor service-chat host', () => {
  const manifest = fs.readFileSync(
    path.join(REPO_ROOT, 'js', 'config', 'manifest', 'scripts.parts', '13-gemini.js'),
    'utf8'
  );
  assert.match(manifest, /search_monitor\/nexusServiceChatBridge\.js/);
  assert.match(manifest, /geminiCredentialWorkflow\.js/);
});

test.afterEach(() => bridge._resetForTests());

test('TLO history control is exact-socket, challenge-bound and one-use', async () => {
  let outbound;
  const socket = { readyState: 1, send(raw) { outbound = JSON.parse(raw); } };
  bridge.registerHost(socket, { workspaceId: 'search-monitor-history-test',
    targets: ['local:tlo-chat:default'] });
  const pending = bridge.exportTloHistory({ scopeId: 'default', generation: 1 },
    { challenge: 'history-challenge-unit-test-0001', timeoutMs: 1000 });
  assert.equal(outbound.type, 'service_workspace_tlo_history_export');
  assert.equal(bridge.handleHostMessage({ readyState: 1 }, { type: 'service_workspace_tlo_history_result',
    requestId: outbound.requestId, workspaceId: outbound.workspaceId,
    challenge: outbound.challenge, operation: 'exportWorkspaceHistory', ok: true,
    result: { history: [], digest: 'a'.repeat(64) } }), true);
  bridge.handleHostMessage(socket, { type: 'service_workspace_tlo_history_result',
    requestId: outbound.requestId, workspaceId: outbound.workspaceId,
    challenge: 'wrong-challenge-unit-test-0001', operation: 'exportWorkspaceHistory', ok: true,
    result: { history: [], digest: 'b'.repeat(64) } });
  bridge.handleHostMessage(socket, { type: 'service_workspace_tlo_history_result',
    requestId: outbound.requestId, workspaceId: outbound.workspaceId,
    challenge: outbound.challenge, operation: 'exportWorkspaceHistory', ok: true,
    result: { history: [], digest: 'a'.repeat(64) } });
  assert.deepEqual(await pending, { history: [], digest: 'a'.repeat(64) });
});

test('TLO history control rejects lost host acknowledgement without fallback', async () => {
  const socket = { readyState: 1, send() {} };
  bridge.registerHost(socket, { workspaceId: 'search-monitor-history-loss',
    targets: ['local:tlo-chat:default'] });
  const pending = bridge.hydrateTloHistory({}, {
    challenge: 'history-challenge-unit-test-0002', timeoutMs: 1000 });
  bridge.unregisterHost(socket);
  await assert.rejects(pending, { code: 'SEARCH_MONITOR_WORKSPACE_DISCONNECTED' });
});
