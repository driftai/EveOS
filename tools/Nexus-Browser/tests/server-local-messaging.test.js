'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServerLocalMessaging } = require('../server-local-messaging');

function harness() {
  const sent = [];
  const source = { id: 'source', clientKind: 'browser', localTargetId: 'local-a' };
  const consolePeer = { id: 'console', clientKind: 'console', localTargetId: 'local-a' };
  const otherPeer = { id: 'other', clientKind: 'console', localTargetId: 'local-b' };
  const messaging = createServerLocalMessaging({
    safeSend: (socket, payload) => { sent.push({ socket, payload }); return true; },
    uiSockets: new Set([source, consolePeer, otherPeer]),
    localTargets: { getLocalTargetStatus: (id) => ({ id, state: 'ready' }) },
    dexRouting: { allowLocalPeer: () => true },
    getTargets: () => [{ id: 'local-a', title: 'Agent A' }]
  });
  return { sent, source, consolePeer, otherPeer, messaging };
}

test('local messaging preserves exact target routing and console prompt mirroring', () => {
  const { sent, source, consolePeer, otherPeer, messaging } = harness();
  assert.equal(messaging.selectedLocalTarget(source)?.title, 'Agent A');
  messaging.sendLocalEvent('local-a', source, { type: 'response_partial', text: 'hello' });
  assert.deepEqual(sent.map((entry) => entry.socket), [source, consolePeer]);
  sent.length = 0;
  messaging.mirrorPromptToConsoles('local-a', source, { requestId: 'req-1', text: 'ping' }, { providerId: 'codex', providerName: 'Codex' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].socket, consolePeer);
  assert.deepEqual(sent[0].payload, {
    type: 'local_prompt_echo', requestId: 'req-1', text: 'ping', targetId: 'local-a',
    providerId: 'codex', providerName: 'Codex'
  });
  assert.equal(sent.some((entry) => entry.socket === otherPeer), false);
});

test('local status delivery stays console-scoped and target-scoped', () => {
  const { sent, source, consolePeer, messaging } = harness();
  assert.equal(messaging.sendLocalStatus(source), true);
  assert.equal(sent[0].payload.type, 'local_target_status');
  sent.length = 0;
  source.clientKind = 'console';
  messaging.broadcastLocalStatus('local-a', source);
  assert.deepEqual(sent.map((entry) => entry.socket), [source, consolePeer]);
});
