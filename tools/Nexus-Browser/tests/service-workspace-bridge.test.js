'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bridge = require('../service-workspace-bridge');

const TLO_ID = 'local:tlo-chat:default';
const MOE_ID = 'local:local-moe-chat:default';

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
    workspaceId: 'search-monitor-a', text: 'same conversation'
  });

  assert.equal(await turn, 'same conversation');
  assert.deepEqual(events.map((event) => [event.type, event.text]), [
    ['response_partial', 'same'],
    ['response_final', 'same conversation']
  ]);
  assert.equal(bridge.snapshot(TLO_ID).busy, false);
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

test.afterEach(() => bridge._resetForTests());
