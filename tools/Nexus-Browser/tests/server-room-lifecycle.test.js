const test = require('node:test');
const assert = require('node:assert/strict');
const lifecycle = require('../dex/server-room-lifecycle');
const { createRoomDeleteRoute } = require('../dex/server-room-delete-route');
const control = require('../public/dex-provider-control');

function room(id, extra = {}) {
  return { id, name: `Room ${id}`, members: [], messages: [], relay: { active: false, waitingFor: null }, ...extra };
}
function snapshot(first = room('one')) {
  return { version: 1, rooms: [first, room('two')], activeRoomId: first.id, retiredProviderControlReceipts: [] };
}

test('an unresolved receipt fences sends without blocking stopped-room structure controls', () => {
  const pending = room('one', { pendingProviderControlReceipt: {} });
  assert.equal(control.roomExecutionBusy({}, pending), false);
  assert.equal(control.roomHasPendingControlReceipt({}, pending), true);
  assert.equal(control.roomBusy({}, pending), true);
});

test('room deletion requires Human Input, exact identity, and genuine runtime idleness', () => {
  assert.equal(lifecycle.deleteRoom(snapshot(), { roomId: 'one', confirmName: 'Room one' }).code, 'DEX_HUMAN_INPUT_LOCKED');
  assert.equal(lifecycle.deleteRoom(snapshot(), { roomId: 'one', confirmName: 'wrong' }, { humanInputEnabled: true }).code, 'DEX_ROOM_CONFIRMATION_MISMATCH');
  const busy = snapshot(room('one', { relay: { active: true, waitingFor: 'eve' } }));
  assert.equal(lifecycle.deleteRoom(busy, { roomId: 'one', confirmName: 'Room one' }, { humanInputEnabled: true }).code, 'DEX_ROOM_EXECUTION_BUSY');
});

test('explicit retirement preserves unresolved receipt identity before deleting a stopped room', () => {
  const pending = { action: 'quorum_presence', turnRequestId: 'dex-turn-1', executorMemberId: 'eve', originMessageId: 'msg-1', agentMessageId: 'msg-2', createdAt: '2026-10-18T00:00:00.000Z', commandKey: 'private command content' };
  const value = snapshot(room('one', { pendingProviderControlReceipt: pending }));
  const denied = lifecycle.deleteRoom(value, { roomId: 'one', confirmName: 'Room one' }, { humanInputEnabled: true });
  assert.equal(denied.code, 'DEX_UNRESOLVED_RECEIPT_CONFIRMATION_REQUIRED');
  const active = lifecycle.deleteRoom(value, { roomId: 'one', confirmName: 'Room one', retireUnresolved: true }, { humanInputEnabled: true, providerControlActive: () => true });
  assert.equal(active.code, 'DEX_PROVIDER_CONTROL_ACTIVE');

  const result = lifecycle.deleteRoom(value, { roomId: 'one', confirmName: 'Room one', retireUnresolved: true }, { humanInputEnabled: true, now: () => '2026-10-19T00:00:00.000Z' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshot.rooms.map((entry) => entry.id), ['two']);
  assert.equal(result.snapshot.retiredProviderControlReceipts[0].disposition, 'USER_RETIRED_UNRESOLVED');
  assert.equal(result.snapshot.retiredProviderControlReceipts[0].turnRequestId, 'dex-turn-1');
  assert.equal('commandKey' in result.snapshot.retiredProviderControlReceipts[0], false);
});

test('retirement ledger stays bounded and the final room cannot be deleted', () => {
  const first = snapshot(room('one', { pendingProviderControlReceipt: { action: 'quorum_open' } }));
  first.retiredProviderControlReceipts = Array.from({ length: 100 }, (_, index) => ({ index }));
  const result = lifecycle.deleteRoom(first, { roomId: 'one', confirmName: 'Room one', retireUnresolved: true }, { humanInputEnabled: true });
  assert.equal(result.snapshot.retiredProviderControlReceipts.length, lifecycle.MAX_RETIRED_RECEIPTS);
  const final = { rooms: [room('one')], activeRoomId: 'one' };
  assert.equal(lifecycle.deleteRoom(final, { roomId: 'one', confirmName: 'Room one' }, { humanInputEnabled: true }).code, 'DEX_ROOM_LAST_ROOM');
});

test('server route requires the primary local controller and broadcasts the committed deletion', () => {
  let value = snapshot(), broadcast = null, sent = null;
  const ws = { clientKind: 'dex' };
  const route = createRoomDeleteRoute({
    dexRouting: { isPrimaryDex: (candidate) => candidate === ws },
    machineSpaces: { humanInputGate: { enabled: () => true } },
    providerControlRouting: { pending: new Map() },
    stateStore: { load: () => value, save: (next) => (value = next) },
    broadcastState: (next) => { broadcast = next; },
    safeSend: (_socket, message) => { sent = message; }
  });
  assert.equal(route.handle(ws, { type: 'other' }), false);
  assert.equal(route.handle(ws, { type: 'dex_room_delete', requestId: 'delete-1', roomId: 'one', confirmName: 'Room one' }), true);
  assert.equal(sent.type, 'dex_room_delete_result');
  assert.equal(sent.ok, true);
  assert.deepEqual(broadcast.rooms.map((entry) => entry.id), ['two']);
  assert.equal('snapshot' in sent && sent.snapshot !== undefined, false);
});

test('server route lets an explicit connected Dex viewer claim editing authority', () => {
  const ws = { clientKind: 'dex' }, sent = [], value = snapshot();
  const route = createRoomDeleteRoute({
    dexRouting: { claimPrimaryDex: (candidate) => candidate === ws },
    stateStore: { load: () => value },
    safeSend: (_socket, message) => { sent.push(message); }
  });
  assert.equal(route.handle(ws, { type: 'dex_request_primary', requestId: 'dex-primary-1' }), true);
  assert.equal(sent[0].type, 'dex_state_snapshot');
  assert.equal(sent[0].snapshot, value);
});
