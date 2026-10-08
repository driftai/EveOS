'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chooseTarget,
  addOnlineAgentCommand,
  exactOriginPresence,
  controlReceiptFromStatus,
  parseArgs
} = require('../scripts/provider-provenance-qualify');

test('provider qualifier pins the requested real ChatGPT Online-Origin target', () => {
  const targets = [
    { id: 11, providerId: 'chatgpt' },
    { id: 22, providerId: 'chatgpt' },
    { id: 33, providerId: 'hark' }
  ];
  assert.deepEqual(chooseTarget(targets, 'chatgpt', '22'), targets[1]);
  assert.equal(chooseTarget(targets, 'chatgpt', '33'), null);
});

test('provider qualifier can pin the intended ChatGPT conversation by URL', () => {
  const targets = [
    { id: 11, providerId: 'chatgpt', url: 'https://chatgpt.com/c/other-chat?foo=1' },
    { id: 22, providerId: 'chatgpt', url: 'https://chatgpt.com/c/6ac740be-c8f0-83ea-a511-a1f36e45b59c' },
    { id: 33, providerId: 'hark', url: 'https://hark.example/chat' }
  ];
  assert.deepEqual(
    chooseTarget(targets, 'chatgpt', null, 'https://chatgpt.com/c/6ac740be-c8f0-83ea-a511-a1f36e45b59c/'),
    targets[1]
  );
  assert.equal(chooseTarget(targets, 'chatgpt', null, 'https://chatgpt.com/c/not-there'), null);
});

test('provider qualifier attaches an existing Online-Origin parent instead of locally spawning it', () => {
  const command = addOnlineAgentCommand(
    'room-proof',
    { id: 116817255, providerId: 'chatgpt' },
    'chatgpt',
    'Eve-Main-Agent-Qualification'
  );
  assert.deepEqual(command, {
    action: 'add_agent',
    room: 'room-proof',
    targetClassId: 'online-origin',
    targetId: 116817255,
    providerId: 'chatgpt',
    name: 'Eve-Main-Agent-Qualification'
  });
  assert.notEqual(command.action, 'spawn_agent');
});

test('relay-safe exact-origin proof requires one matching committed presence event', () => {
  const snapshot = {
    presence: [{
      agent: 'Eve', provider: 'chatgpt', roomId: 'room-proof', memberId: 'eve-member',
      evidenceId: 'msg-proof', source: 'dex-provider-control'
    }],
    events: [{
      type: 'presence', agent: 'Eve', provider: 'chatgpt', roomId: 'room-proof', memberId: 'eve-member',
      evidenceId: 'msg-proof', source: 'dex-provider-control'
    }]
  };
  const proof = exactOriginPresence(snapshot, { roomId: 'room-proof', memberId: 'eve-member' });
  assert.equal(proof.presence.evidenceId, 'msg-proof');
  assert.equal(proof.events.length, 1);

  snapshot.events.push({ ...snapshot.events[0] });
  const duplicate = exactOriginPresence(snapshot, { roomId: 'room-proof', memberId: 'eve-member' });
  assert.equal(duplicate.events.length, 2);
});

test('provider qualifier recognizes durable success and failure receipts for the exact randomized executor', () => {
  const state = {
    latest: [
      { sender: 'Dex', kind: 'system', text: '[DEX CONTROL RECEIPT]\nOther-Agent · quorum_presence · OK: ignored\nControl request: provider-control-old' },
      { sender: 'Dex', kind: 'system', text: '[DEX CONTROL RECEIPT]\nEve-Main-Agent-Qualification-abc123 · quorum_presence · OK: Eve availability evidence recorded.\nOrigin room: MS Provider Proof\nControl request: provider-control-good' }
    ]
  };
  assert.deepEqual(
    controlReceiptFromStatus(state, { executorName: 'Eve-Main-Agent-Qualification-abc123', action: 'quorum_presence' }),
    {
      ok: true,
      code: null,
      requestId: 'provider-control-good',
      text: state.latest[1].text
    }
  );

  state.latest.push({
    sender: 'Dex', kind: 'system',
    text: '[DEX CONTROL RECEIPT]\nEve-Main-Agent-Qualification-abc123 · quorum_vote · ERROR MACHINE_QUORUM_ORIGIN_REQUIRED: exact origin required\nControl request: provider-control-fail'
  });
  const failure = controlReceiptFromStatus(state, { executorName: 'Eve-Main-Agent-Qualification-abc123', action: 'quorum_vote' });
  assert.equal(failure.ok, false);
  assert.equal(failure.code, 'MACHINE_QUORUM_ORIGIN_REQUIRED');
  assert.equal(failure.requestId, 'provider-control-fail');
});

test('provider qualifier accepts explicit ChatGPT URL/tab and Hark target pins', () => {
  const options = parseArgs([
    '--source-target-id', 'local-2',
    '--chatgpt-tab-id', '116817925',
    '--chatgpt-url', 'https://chatgpt.com/c/6ac740be-c8f0-83ea-a511-a1f36e45b59c',
    '--hark-tab-id', '116817427',
    '--timeout-ms', '240000'
  ]);
  assert.equal(options.sourceTargetId, 'local-2');
  assert.equal(options.chatgptTabId, '116817925');
  assert.equal(options.chatgptUrl, 'https://chatgpt.com/c/6ac740be-c8f0-83ea-a511-a1f36e45b59c');
  assert.equal(options.harkTabId, '116817427');
  assert.equal(options.timeoutMs, 240000);
  assert.equal(options.skipQuorum, false);
});