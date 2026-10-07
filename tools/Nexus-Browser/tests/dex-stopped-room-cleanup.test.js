'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const stateApi = require('../dex/server-scheduler-state.js');
const roomTools = require('../dex/room-tools.js');
const orchestration = require('../dex/provider-orchestration-policy.js');
const { createDexServerScheduler } = require('../dex/server-scheduler.js');

function seedRoom() {
  return {
    id: 'room-cleanup',
    name: 'Cleanup',
    members: [{
      id: 'eve', name: 'Eve Bootstrap', relayEnabled: true,
      binding: {
        targetClassId: 'online-origin', providerId: 'chatgpt', targetId: 7,
        url: 'https://chatgpt.com/c/cleanup'
      }
    }, {
      id: 'nova', name: 'Nova', relayEnabled: false,
      binding: { targetClassId: 'local-origin', providerId: 'local-codex-existing', targetId: 'nova' }
    }],
    messages: [
      { id: 'm1', senderKind: 'agent', senderId: 'eve', senderName: 'Eve Bootstrap', text: 'queued handoff' }
    ],
    settings: { maxTurns: 1 },
    relay: { active: false, remaining: 0, waitingFor: null, lastStopReason: 'Idle' },
    deferredRelays: [{
      requestId: 'provider-control-queued', messageId: 'm1', targetMemberId: 'nova',
      queuedAt: '2026-10-07T11:21:32.331Z', budget: 1
    }],
    deferredSendReceipts: [{
      requestId: 'provider-control-queued', messageId: 'm1', senderId: 'eve',
      intentDigest: 'abc', phase: 'queued', at: '2026-10-07T11:21:32.331Z'
    }]
  };
}

function memoryStore(room) {
  let current = { version: 1, activeRoomId: room.id, rooms: [JSON.parse(JSON.stringify(room))] };
  return {
    load() { return JSON.parse(JSON.stringify(current)); },
    save(value) { current = JSON.parse(JSON.stringify(value)); return this.load(); },
    value() { return this.load(); }
  };
}

test('explicit idle stop cancels orphaned deferred handoffs and unblocks room mutations', () => {
  const store = memoryStore(seedRoom());
  const scheduler = createDexServerScheduler({
    stateStore: store,
    durability: { recordIncident() {} },
    broadcastState() {},
    setTimer() { return 1; },
    clearTimer() {}
  });

  const result = scheduler.stopRelay({ roomId: 'room-cleanup', reason: 'Stopped by Eve Bootstrap' });
  assert.equal(result.ok, true);
  assert.equal(result.inFlight, false);

  const room = store.value().rooms[0];
  assert.deepEqual(room.deferredRelays, []);
  assert.equal(room.deferredSendReceipts[0].phase, 'cancelled');
  assert.equal(room.deferredSendReceipts[0].cancelReason, 'Stopped by Eve Bootstrap');
  assert.equal(room.lastDeferredCancellation.count, 1);
  assert.equal(orchestration.roomBusy(room), false);

  const changed = roomTools.execute(store.value(), {
    source: {
      targetClassId: 'online-origin', providerId: 'chatgpt', targetId: 7,
      url: 'https://chatgpt.com/c/cleanup'
    },
    command: { action: 'set_room_budget', room: 'room-cleanup', turns: 8 },
    at: '2026-10-07T13:45:00.000Z'
  });
  assert.equal(changed.result.ok, true);
  assert.equal(changed.changed, true);
  assert.equal(changed.snapshot.rooms[0].settings.maxTurns, 8);
});

test('automatic/internal stop reasons preserve durable deferred handoffs', () => {
  const room = seedRoom();
  const cancelled = stateApi.setStopped(room, 'Relay budget complete', '2026-10-07T13:46:00.000Z');
  assert.equal(cancelled, 0);
  assert.equal(room.deferredRelays.length, 1);
  assert.equal(room.deferredSendReceipts[0].phase, 'queued');
  assert.equal(room.lastDeferredCancellation, undefined);
});

test('requestStop keeps deferred handoffs while an in-flight reply is still settling', () => {
  const room = seedRoom();
  stateApi.requestStop(room, 'Stopped by Eve Bootstrap', '2026-10-07T13:47:00.000Z');
  assert.equal(room.relay.active, false);
  assert.equal(room.deferredRelays.length, 1);
  assert.equal(room.deferredSendReceipts[0].phase, 'queued');
});
