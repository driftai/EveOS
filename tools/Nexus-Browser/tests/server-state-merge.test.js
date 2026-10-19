const test = require('node:test');
const assert = require('node:assert/strict');
const merge = require('../dex/server-state-merge.js');

function activeRoom() {
  return {
    id: 'room-1',
    name: 'Server Name',
    userName: 'Drift',
    members: [{ id: 'eve', name: 'Eve' }],
    messages: [{ id: 'server-reply', senderKind: 'agent', senderId: 'eve', text: 'Server-owned reply' }],
    settings: { maxTurns: 8, contextMessages: 8 },
    relay: { active: true, remaining: 3, waitingFor: 'eve', lastStopReason: 'Running' },
    pendingTurn: { memberId: 'eve', sourceMessageId: 'source-1', queuedAt: '2026-09-18T23:50:00.000Z' },
    recovery: { requestId: 'dex-turn-1', memberId: 'eve', sourceMessageId: 'source-1', dispatched: true },
    agentCheckpoints: { eve: { note: 'server checkpoint' } },
    updatedAt: '2026-09-18T23:50:01.000Z'
  };
}

test('viewer writes cannot erase localhost-owned runtime state or messages', () => {
  const serverRoom = activeRoom();
  const clientRoom = {
    ...serverRoom,
    name: 'Renamed Room',
    members: [],
    messages: [{ id: 'client-note', senderKind: 'system', text: 'new client metadata' }],
    relay: { active: false, remaining: 0, waitingFor: null },
    pendingTurn: undefined,
    recovery: undefined,
    agentCheckpoints: { wren: { note: 'client checkpoint' } }
  };
  const result = merge.mergeClientSnapshot(
    { version: 1, rooms: [serverRoom], activeRoomId: 'room-1' },
    { version: 1, rooms: [clientRoom], activeRoomId: 'room-1' }
  );
  const room = result.rooms[0];
  assert.equal(room.name, 'Renamed Room');
  assert.deepEqual(room.members, serverRoom.members);
  assert.deepEqual(room.relay, serverRoom.relay);
  assert.deepEqual(room.pendingTurn, serverRoom.pendingTurn);
  assert.deepEqual(room.recovery, serverRoom.recovery);
  assert.deepEqual(room.messages.map((item) => item.id), ['server-reply', 'client-note']);
  assert.equal(room.agentCheckpoints.eve.note, 'server checkpoint');
  assert.equal(room.agentCheckpoints.wren.note, 'client checkpoint');
});

test('busy server rooms survive stale client deletion attempts', () => {
  const serverRoom = activeRoom();
  const result = merge.mergeClientSnapshot(
    { version: 1, rooms: [serverRoom], activeRoomId: 'room-1' },
    { version: 1, rooms: [], activeRoomId: null }
  );
  assert.equal(result.rooms.length, 1);
  assert.equal(result.rooms[0].id, 'room-1');
  assert.equal(result.rooms[0].recovery.requestId, 'dex-turn-1');
});

test('idle rooms still accept normal viewer/controller edits and deletion', () => {
  const idle = { ...activeRoom(), relay: { active: false, remaining: 0, waitingFor: null }, pendingTurn: undefined, recovery: undefined };
  const replacement = { ...idle, name: 'Client Authoritative While Idle', messages: [] };
  const replaced = merge.mergeClientSnapshot(
    { version: 1, rooms: [idle], activeRoomId: 'room-1' },
    { version: 1, rooms: [replacement], activeRoomId: 'room-1' }
  );
  assert.equal(replaced.rooms[0].name, 'Client Authoritative While Idle');
  assert.equal(replaced.rooms[0].messages.length, 0);

  const deleted = merge.mergeClientSnapshot(
    { version: 1, rooms: [idle], activeRoomId: 'room-1' },
    { version: 1, rooms: [], activeRoomId: null }
  );
  assert.equal(deleted.rooms.length, 0);
});


test('idle client snapshots cannot resurrect scheduler runtime after server resolution', () => {
  const serverRoom = {
    ...activeRoom(),
    relay: { active: false, remaining: 0, waitingFor: null, lastStopReason: 'Passive recovery resolved' }
  };
  delete serverRoom.pendingTurn;
  delete serverRoom.recovery;

  const staleClient = {
    ...serverRoom,
    relay: { active: false, remaining: 0, waitingFor: null, lastStopReason: 'Interrupted turn recovery timed out' },
    recovery: { requestId: 'dex-turn-stale', memberId: 'eve', passiveAt: '2026-09-20T07:15:23.181Z' }
  };

  const result = merge.mergeClientSnapshot(
    { version: 1, rooms: [serverRoom], activeRoomId: 'room-1' },
    { version: 1, rooms: [staleClient], activeRoomId: 'room-1' }
  );
  const room = result.rooms[0];
  assert.equal(room.recovery, undefined);
  assert.equal(room.pendingTurn, undefined);
  assert.deepEqual(room.relay, serverRoom.relay);
});

test('a known idle room cannot acquire a provider-control intent from its UI mirror', () => {
  const serverRoom = { ...activeRoom(), relay: { active: false, waitingFor: null } };
  delete serverRoom.pendingTurn;
  delete serverRoom.recovery;
  const clientRoom = { ...serverRoom,
    pendingProviderControlReceipt: { commandKey: 'injected', agentMessageId: 'client-message' } };
  const room = merge.mergeClientSnapshot({ rooms: [serverRoom] }, { rooms: [clientRoom] }).rooms[0];
  assert.equal(room.pendingProviderControlReceipt, undefined);
  assert.equal(merge.runtimeBusy(room), false);
});

test('valid UI edits preserve an active canonical provider-control intent', () => {
  const intent = { commandKey: 'canonical', agentMessageId: 'server-message' };
  const serverRoom = { ...activeRoom(), relay: { active: false, waitingFor: null },
    pendingProviderControlReceipt: intent };
  delete serverRoom.pendingTurn;
  delete serverRoom.recovery;
  for (const value of [undefined, { commandKey: 'replacement', agentMessageId: 'client-message' }]) {
    const clientRoom = { ...serverRoom, name: 'Renamed by UI', pendingProviderControlReceipt: value };
    const room = merge.mergeClientSnapshot({ rooms: [serverRoom] }, { rooms: [clientRoom] }).rooms[0];
    assert.equal(room.name, 'Renamed by UI');
    assert.equal(merge.executionBusy(room), false);
    assert.deepEqual(room.pendingProviderControlReceipt, intent);
    assert.equal(merge.runtimeBusy(room), true);
  }
});

test('receipt-pending stopped rooms accept structural edits but reject implicit deletion', () => {
  const intent = { action: 'quorum_presence', turnRequestId: 'dex-turn-old' };
  const serverRoom = { ...activeRoom(), relay: { active: false, waitingFor: null }, pendingProviderControlReceipt: intent };
  delete serverRoom.pendingTurn; delete serverRoom.recovery;
  const client = { ...serverRoom, name: 'Editable proof room', members: [{ id: 'vera', name: 'Vera' }], pendingProviderControlReceipt: undefined };
  const edited = merge.mergeClientSnapshot({ rooms: [serverRoom] }, { rooms: [client] });
  assert.equal(edited.rooms[0].name, 'Editable proof room');
  assert.equal(edited.rooms[0].members[0].id, 'vera');
  assert.deepEqual(edited.rooms[0].pendingProviderControlReceipt, intent);
  assert.equal(merge.mergeClientSnapshot({ rooms: [serverRoom] }, { rooms: [] }).rooms.length, 1);
});

test('viewer saves preserve the server retirement ledger and reject injected entries', () => {
  const canonical = [{ roomId: 'retired-room', disposition: 'USER_RETIRED_UNRESOLVED' }];
  const result = merge.mergeClientSnapshot(
    { rooms: [], retiredProviderControlReceipts: canonical },
    { rooms: [], retiredProviderControlReceipts: [{ roomId: 'injected' }] }
  );
  assert.deepEqual(result.retiredProviderControlReceipts, canonical);
});
