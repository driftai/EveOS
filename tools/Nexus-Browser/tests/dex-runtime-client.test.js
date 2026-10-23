const test = require('node:test');
const assert = require('node:assert/strict');
const runtimeApi = require('../public/dex-runtime-client.js');

function harness() {
  const sent = [], persisted = [], logs = [];
  const room = {
    id: 'room-1',
    members: [{ id: 'eve' }],
    relay: { active: false, waitingFor: null },
    messages: [{ id: 'm1', senderKind: 'user', text: 'hello' }]
  };
  const state = { rooms: [room] };
  const runtime = runtimeApi.createController({
    state,
    send(payload) { sent.push(payload); return true; },
    persist(options) { persisted.push(options); },
    roomMessage() {},
    renderAll() {},
    log(message) { logs.push(message); }
  });
  return { runtime, room, sent, persisted, logs };
}

test('browser controller starts relay with one localhost command and no provider transport', () => {
  const { runtime, room, sent, persisted } = harness();
  assert.equal(runtime.startRelay(room, room.messages[0], 4), true);
  assert.equal(persisted.length, 0, 'locked user messages are committed by the server additive path');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'dex_relay_start');
  assert.equal(sent[0].roomId, 'room-1');
  assert.equal(sent[0].sourceMessageId, 'm1');
  assert.deepEqual(sent[0].sourceMessage, room.messages[0]);
  assert.equal(sent[0].budget, 4);
  assert.equal(sent.some((item) => ['send_prompt', 'select_target', 'ensure_target', 'capture_latest'].includes(item.type)), false);
});

test('agent-origin relay starts still flush correlated state before dispatch', () => {
  const { runtime, room, persisted } = harness();
  const message = { id: 'agent-message-1', senderKind: 'agent', senderId: 'eve', text: 'provider control' };
  room.messages.push(message);
  assert.equal(runtime.startRelay(room, message, 1), true);
  assert.equal(persisted[0].immediate, true);
});

test('browser controller stop and continue remain control-plane only', () => {
  const { runtime, room, sent } = harness();
  room.relay.active = true;
  runtime.stopRoom(room, 'Stopped by test');
  runtime.continueRelay(room, 3);
  assert.deepEqual(sent.map((item) => item.type), ['dex_relay_stop', 'dex_relay_continue']);
});

test('leaving Dex can stop every active room without mutating scheduler state locally', () => {
  const { runtime, room, sent } = harness();
  room.relay.active = true;
  room.relay.waitingFor = 'eve';
  assert.equal(runtime.stopAllRelays('Base Mode opened'), 1);
  assert.equal(sent[0].type, 'dex_relay_stop');
  assert.equal(room.relay.active, true);
  assert.equal(room.relay.waitingFor, 'eve');
});

test('relay command failures are surfaced without running fallback browser orchestration', () => {
  const { runtime, logs } = harness();
  assert.equal(runtime.handleMessage({
    type: 'dex_relay_result',
    result: { ok: false, code: 'DEX_RELAY_BUSY', message: 'busy' }
  }), true);
  assert.match(logs[0], /DEX_RELAY_BUSY/);
});
