'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHumanInputLeaseAuthority } = require('../dex/human-input-leases');
const { createHumanInputServerRoute } = require('../dex/server-human-input-route');
const { createDexServerRouting } = require('../dex/server-routing');
const { routeTerminalOperator } = require('../dex/server-terminal-operator-route');

const clone = value => JSON.parse(JSON.stringify(value));
function reorderJsonKeys(value) {
  if (Array.isArray(value)) return value.map(reorderJsonKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reorderJsonKeys(entry)]));
  return value;
}
function room(id, text = '') {
  return { id, name: `Room ${id}`, userName: 'Drift', members: [{ id: 'eve', name: 'Eve' }],
    messages: text ? [{ id: `msg-${id}-saved`, senderKind: 'user', senderId: 'user', senderName: 'Drift', text, at: '2026-10-22T12:00:00.000Z' }] : [],
    settings: { autoRelay: true, maxTurns: 8 }, relay: { active: false, waitingFor: null },
    createdAt: '2026-10-22T12:00:00.000Z', updatedAt: '2026-10-22T12:00:00.000Z' };
}
function harness({ initialRooms = null, nullInitialState = false } = {}) {
  let stamp = Date.parse('2026-10-22T12:00:00.000Z'), token = 0;
  let value = { version: 1, rooms: initialRooms ?? [room('room-one', 'keep one'), room('room-two', 'keep two')],
    activeRoomId: 'room-one', retiredRoomIds: [], retiredProviderControlReceipts: [] };
  if (nullInitialState) value = null;
  const first = { clientKind: 'dex', sent: [] }, second = { clientKind: 'dex', sent: [] };
  const uiSockets = new Set([first, second]);
  const safeSend = (ws, payload) => { ws.sent.push(payload); return true; };
  const authority = createHumanInputLeaseAuthority({ serverEpoch: 'epoch-one', now: () => stamp,
    tokenFactory: () => `lease-token-${++token}`, actorFactory: () => `actor-${token + 1}` });
  const routing = createDexServerRouting({ uiSockets, safeSend,
    onPrimaryChanged: ({ generation }) => authority.setControllerGeneration(generation) });
  authority.registerSocket(first); authority.registerSocket(second);
  routing.registerDex(first); routing.registerDex(second);
  const calls = [], pending = new Map();
  const scheduler = {
    onStateChanged() { calls.push('state'); },
    startRelay(msg) { calls.push(['start', msg.roomId, msg.sourceMessageId]); return { ok: true, code: 'DEX_RELAY_STARTED' }; },
    stopRelay(msg) { calls.push(['stop', msg.roomId]); return { ok: true }; },
    continueRelay(msg) { calls.push(['continue', msg.roomId]); return { ok: true }; }
  };
  const route = createHumanInputServerRoute({ authority, dexRouting: routing,
    stateStore: { load: () => value, save: next => (value = next) }, scheduler,
    providerControlRouting: { pending }, safeSend, broadcastState: snapshot => calls.push(['broadcast', snapshot.rooms.length]),
    idFactory: () => `created-${token}`, now: () => new Date(stamp).toISOString() });
  function lease(socket = first, roomId = 'room-one') {
    route.handle(socket, { type: 'dex_human_input_request', requestId: `request-${roomId}`, roomId });
    return socket.sent.filter(event => event.type === 'dex_human_input_status' && event.status === 'active').at(-1)?.lease;
  }
  return { first, second, uiSockets, authority, routing, route, scheduler, calls, pending, lease,
    state: () => value, setTime: value => { stamp = value; } };
}

test('same-room lease succeeds while default, second-socket, cross-room and snapshot bypasses fail closed', () => {
  const h = harness(), base = clone(h.state());
  h.route.handle(h.first, { type: 'dex_state_put', requestId: 'no-lease', roomId: 'room-one', snapshot: base });
  assert.equal(h.first.sent.at(-1).code, 'DEX_HUMAN_LEASE_REQUIRED');
  const lease = h.lease();
  const edit = clone(h.state()); edit.rooms[0].name = 'Authorized rename';
  h.route.handle(h.first, { type: 'dex_state_put', requestId: 'same-room', roomId: 'room-one', snapshot: edit, authorization: lease });
  assert.equal(h.state().rooms[0].name, 'Authorized rename');
  assert.equal(h.first.sent.at(-1).type, 'dex_state_saved');
  assert.equal(h.authority.validate(h.second, lease, { operation: 'state:edit', roomId: 'room-one' }).code,
    'DEX_HUMAN_LEASE_SOCKET_MISMATCH');
  h.route.handle(h.first, { type: 'dex_state_put', requestId: 'cross-room', roomId: 'room-two', snapshot: clone(h.state()), authorization: lease });
  assert.equal(h.first.sent.at(-2).code, 'DEX_HUMAN_LEASE_SCOPE_MISMATCH');
  const bypass = clone(h.state()); bypass.rooms[1].name = 'unauthorized second edit';
  h.route.handle(h.first, { type: 'dex_state_put', requestId: 'snapshot-bypass', roomId: 'room-one', snapshot: bypass, authorization: lease });
  assert.equal(h.first.sent.at(-2).code, 'DEX_HUMAN_LEASE_SCOPE_MISMATCH');
  assert.equal(h.state().rooms[1].name, 'Room room-two');
});


test('room-scoped edits allow reordered keys in an untouched unrelated room', () => {
  const h = harness(), originalOther = clone(h.state().rooms[1]);
  const authorization = h.lease();
  const edit = clone(h.state());
  edit.rooms[0].name = 'Authorized with reordered neighbor';
  edit.rooms[1] = reorderJsonKeys(edit.rooms[1]);
  assert.deepEqual(edit.rooms[1], originalOther);
  assert.notEqual(JSON.stringify(edit.rooms[1]), JSON.stringify(originalOther));
  h.route.handle(h.first, { type: 'dex_state_put', requestId: 'order-only-room-edit',
    roomId: 'room-one', snapshot: edit, authorization });
  assert.equal(h.first.sent.at(-1).type, 'dex_state_saved');
  assert.equal(h.state().rooms[0].name, 'Authorized with reordered neighbor');
  assert.deepEqual(h.state().rooms[1], originalOther);
});

test('room-scoped edits reject real mutations hidden behind key reordering', () => {
  const h = harness(), before = clone(h.state());
  const authorization = h.lease();
  const edit = clone(h.state());
  edit.rooms[0].name = 'Unauthorized alongside other room mutation';
  edit.rooms[1] = reorderJsonKeys(edit.rooms[1]);
  edit.rooms[1].settings.maxTurns = 999;
  h.route.handle(h.first, { type: 'dex_state_put', requestId: 'order-and-mutation',
    roomId: 'room-one', snapshot: edit, authorization });
  assert.equal(h.first.sent.at(-2).code, 'DEX_HUMAN_LEASE_SCOPE_MISMATCH');
  assert.deepEqual(h.state(), before);
});

test('agent room-scoped rename accepts reordered keys but no unrelated mutations', () => {
  const h = harness(), originalOther = clone(h.state().rooms[1]);
  const grant = h.route.issueProviderAuthorization({ ws: h.first, requestId: 'order-agent',
    action: 'rename_room', roomId: 'room-one' });
  h.pending.set('order-agent', { requestId: 'order-agent', action: 'rename_room',
    roomId: 'room-one', uiAuthorization: grant });
  const edit = clone(h.state());
  edit.rooms[0].name = 'Agent reorder-safe rename';
  edit.rooms[1] = reorderJsonKeys(edit.rooms[1]);
  h.route.handle(h.first, { type: 'dex_state_put', requestId: 'order-agent-edit',
    roomId: 'room-one', snapshot: edit, authorization: grant });
  assert.equal(h.first.sent.at(-1).type, 'dex_state_saved');
  assert.equal(h.state().rooms[0].name, 'Agent reorder-safe rename');
  assert.deepEqual(h.state().rooms[1], originalOther);
});

test('expiry, explicit revoke, controller handoff, disconnect/reconnect and server epoch fence stale leases', () => {
  const h = harness();
  let lease = h.lease();
  h.setTime(Date.parse(lease.expiresAt));
  assert.equal(h.authority.validate(h.first, lease, { operation: 'state:edit', roomId: 'room-one' }).code,
    'DEX_HUMAN_LEASE_EXPIRED');
  h.setTime(Date.parse('2026-10-22T12:00:00.000Z'));
  lease = h.lease();
  h.route.handle(h.first, { type: 'dex_human_input_disable', requestId: 'disable-one' });
  assert.equal(h.authority.validate(h.first, lease, { operation: 'state:edit', roomId: 'room-one' }).code,
    'DEX_HUMAN_LEASE_REVOKED');
  lease = h.lease();
  h.routing.claimPrimaryDex(h.second);
  assert.equal(h.authority.validate(h.first, lease, { operation: 'state:edit', roomId: 'room-one' }).code,
    'DEX_HUMAN_LEASE_GENERATION_STALE');
  h.routing.claimPrimaryDex(h.first); lease = h.lease();
  h.authority.revokeSocket(h.first);
  assert.equal(h.authority.validate(h.first, lease, { operation: 'state:edit', roomId: 'room-one' }).code,
    'DEX_HUMAN_LEASE_REVOKED');
  assert.equal(h.authority.validate({ clientKind: 'dex' }, lease, { operation: 'state:edit', roomId: 'room-one' }).code,
    'DEX_HUMAN_LEASE_SOCKET_MISMATCH');
  h.authority.registerSocket(h.first); lease = h.lease();
  h.authority.setServerEpoch('epoch-two');
  assert.equal(h.authority.validate(h.first, lease, { operation: 'state:edit', roomId: 'room-one' }).code,
    'DEX_HUMAN_LEASE_EPOCH_STALE');
});

test('creation is one-use and re-scopes without changing existing rooms or transcripts', () => {
  const h = harness(), before = clone(h.state().rooms);
  h.route.handle(h.first, { type: 'dex_human_input_request', requestId: 'create-lease', scope: 'create' });
  const creation = h.first.sent.at(-1).lease;
  h.route.handle(h.first, { type: 'dex_room_create', requestId: 'create-room', authorization: creation });
  const result = h.first.sent.find(event => event.type === 'dex_room_create_result');
  assert.equal(result.ok, true);
  assert.deepEqual(h.state().rooms.slice(0, 2), before);
  assert.equal(h.state().rooms.length, 3);
  assert.equal(result.lease.roomId, result.roomId);
  assert.equal(h.authority.validate(h.first, creation, { operation: 'room:create', scopeType: 'create' }).code,
    'DEX_HUMAN_LEASE_REPLAYED');
  assert.equal(h.authority.validate(h.first, result.lease, { operation: 'state:edit', roomId: 'room-one' }).code,
    'DEX_HUMAN_LEASE_SCOPE_MISMATCH');
});

test('locked user messages commit through the additive path and agent controls use independent grants', () => {
  const h = harness();
  const user = { id: 'msg-user-0001', senderKind: 'user', senderId: 'user', senderName: 'Drift',
    text: 'Continue while Human Input is locked.', at: '2026-10-22T12:01:00.000Z' };
  h.route.handle(h.first, { type: 'dex_relay_start', requestId: 'user-send', roomId: 'room-one',
    sourceMessageId: user.id, sourceMessage: user, budget: 1 });
  assert.equal(h.first.sent.at(-1).result.ok, true);
  assert.equal(h.state().rooms[0].messages.at(-1).text, user.text);
  assert.deepEqual(h.calls.find(call => Array.isArray(call) && call[0] === 'start'), ['start', 'room-one', user.id]);

  const grant = h.route.issueProviderAuthorization({ ws: h.first, requestId: 'agent-edit', action: 'rename_room', roomId: 'room-one' });
  h.pending.set('agent-edit', { requestId: 'agent-edit', action: 'rename_room', roomId: 'room-one', uiAuthorization: grant });
  const edit = clone(h.state()); edit.rooms[0].name = 'Agent-authorized rename';
  h.route.handle(h.first, { type: 'dex_state_put', requestId: 'agent-edit-state', roomId: 'room-one', snapshot: edit, authorization: grant });
  assert.equal(h.state().rooms[0].name, 'Agent-authorized rename');
  h.route.revokeProviderAuthorization(grant);
  h.route.handle(h.first, { type: 'dex_state_put', requestId: 'agent-replay', roomId: 'room-one', snapshot: clone(h.state()), authorization: grant });
  assert.equal(h.first.sent.at(-1).code, 'DEX_AGENT_GRANT_REVOKED');
});

test('terminal/TUI and Machine Spaces commands remain outside the Human Input route', () => {
  const h = harness(), terminal = { clientKind: 'terminal-operator', remoteAddress: '127.0.0.1', terminalOperatorOrigin: null };
  assert.equal(h.route.handle(terminal, { type: 'dex_terminal_rooms', requestId: 'terminal-rooms-1' }), false);
  assert.equal(routeTerminalOperator(terminal, { type: 'dex_terminal_rooms', requestId: 'terminal-rooms-1' },
    { handle: () => ({ ok: true }) }).type, 'dex_terminal_result');
  assert.equal(h.route.handle(h.first, { type: 'machine_approve_command', requestId: 'machine-approval-1' }), false);
});

test('empty-server first use requires an explicit one-use bootstrap authorization', () => {
  const h = harness({ initialRooms: [] });
  const ghost = 'room-provisional-local';

  h.route.handle(h.first, {
    type: 'dex_human_input_request', requestId: 'ordinary',
    roomId: ghost
  });
  assert.equal(h.first.sent.at(-1).code, 'DEX_ROOM_NOT_FOUND');

  h.route.handle(h.first, {
    type: 'dex_human_input_request', requestId: 'first-use',
    roomId: ghost, bootstrap: true
  });

  const status = h.first.sent.at(-1);
  assert.equal(status.status, 'creation-authorized');
  assert.equal(h.state().rooms.length, 0);

  h.route.handle(h.first, {
    type: 'dex_room_create', requestId: 'create-first',
    authorization: status.lease
  });

  const result = h.first.sent.find(event =>
    event.type === 'dex_room_create_result');

  assert.equal(result.ok, true);
  assert.equal(h.state().rooms.length, 1);
  assert.equal(result.lease.roomId, result.roomId);

  assert.equal(
    h.authority.validate(h.first, status.lease, {
      operation: 'room:create', scopeType: 'create'
    }).code,
    'DEX_HUMAN_LEASE_REPLAYED'
  );

  h.route.handle(h.first, {
    type: 'dex_human_input_request', requestId: 'stale',
    roomId: ghost, bootstrap: true
  });
  assert.equal(h.first.sent.at(-1).code, 'DEX_ROOM_NOT_FOUND');
});
test('first room creates safely when persisted Dex state is null', () => {
  const h = harness({ nullInitialState: true });

  assert.equal(h.state(), null);

  h.route.handle(h.first, {
    type: 'dex_human_input_request',
    requestId: 'bootstrap-null',
    roomId: 'room-local-provisional',
    bootstrap: true
  });

  const grant = h.first.sent.at(-1);
  assert.equal(grant.status, 'creation-authorized');

  h.route.handle(h.first, {
    type: 'dex_room_create',
    requestId: 'create-from-null',
    authorization: grant.lease
  });

  const created = h.first.sent.find(
    event => event.type === 'dex_room_create_result'
  );

  assert.equal(created?.ok, true);
  assert.equal(h.state().rooms.length, 1);
  assert.equal(h.state().activeRoomId, created.roomId);
  assert.deepEqual(h.state().retiredRoomIds, []);
  assert.deepEqual(h.state().retiredProviderControlReceipts, []);

  assert.equal(
    h.authority.validate(h.first, grant.lease, {
      operation: 'room:create',
      scopeType: 'create'
    }).code,
    'DEX_HUMAN_LEASE_REPLAYED'
  );
});

test('agent grants are request/action correlated, action-limited and one-use per operation', () => {
  const h = harness();
  const grant = h.route.issueProviderAuthorization({ ws: h.first, requestId: 'job-one', action: 'rename_room', roomId: 'room-one' });
  const edit = clone(h.state()); edit.rooms[0].name = 'Safe rename';
  const send = (snapshot, id = 'state-update') => h.route.handle(h.first, { type: 'dex_state_put', requestId: id, roomId: 'room-one', snapshot, authorization: grant });
  send(edit);
  assert.equal(h.first.sent.at(-1).code, 'DEX_AGENT_GRANT_REQUEST_MISMATCH');
  h.pending.set('job-one', { requestId: 'job-one', action: 'rename_room', roomId: 'room-one', uiAuthorization: grant });
  assert.equal(h.authority.validate(h.first, grant, { operation: 'state:edit', requestId: 'other', action: 'rename_room' }).code, 'DEX_AGENT_GRANT_REQUEST_MISMATCH');
  const overreach = clone(h.state()); overreach.rooms[0].members[0].name = 'Illicit';
  send(overreach, 'overreach');
  assert.equal(h.first.sent.at(-1).code, 'DEX_AGENT_GRANT_ACTION_DENIED');
  send(edit, 'valid');
  assert.equal(h.first.sent.at(-1).type, 'dex_state_saved');
  send(clone(h.state()), 'repeated');
  assert.equal(h.first.sent.at(-1).code, 'DEX_AGENT_GRANT_REPLAYED');
  h.pending.delete('job-one');
  assert.equal(h.state().rooms[0].name, 'Safe rename');
});

test('user relay source and durable request IDs fence mismatches and replay', () => {
  const h = harness();
  const message = { id: 'msg-replay-0001', senderKind: 'user', senderId: 'user', text: 'One dispatch', at: '2026-10-22T12:01:00Z' };
  const send = (value, sourceMessageId = value.id, requestId = 'user-relay-1') =>
    h.route.handle(h.first, { type: 'dex_relay_start', requestId, roomId: 'room-one',
      sourceMessage: value, sourceMessageId, budget: 1 });
  send(message, 'msg-different-0002');
  assert.equal(h.first.sent.at(-1).result.code, 'DEX_USER_RELAY_SOURCE_MISMATCH');
  assert.equal(h.state().rooms[0].messages.length, 1);
  send(message);
  assert.equal(h.first.sent.at(-1).result.ok, true);
  assert.equal(h.state().rooms[0].messages.at(-1).relayStartRequestId, 'user-relay-1');
  assert.equal(h.state().rooms[0].messages.at(-1).relayStartDisposition, 'started');
  send(message);
  assert.equal(h.first.sent.at(-1).result.code, 'DEX_USER_RELAY_REPLAYED');
  send({ ...message, id: 'msg-replay-0003' });
  assert.equal(h.first.sent.at(-1).result.code, 'DEX_USER_RELAY_REQUEST_CONFLICT');
  assert.equal(h.calls.filter(call => Array.isArray(call) && call[0] === 'start').length, 1);
});

test('compound provider send has one authorized state edit and one relay start', () => {
  const h = harness();
  const grant = h.route.issueProviderAuthorization({ ws: h.first, requestId: 'provider-send-1', action: 'send', roomId: 'room-one' });
  h.pending.set('provider-send-1', { requestId: 'provider-send-1', action: 'send', roomId: 'room-one', uiAuthorization: grant });
  const snap = clone(h.state());
  const source = { id: 'msg-provider-1', senderKind: 'agent', senderId: 'eve', senderName: 'Eve', text: 'Deliver one response' };
  snap.rooms[0].messages.push(source);
  h.route.handle(h.first, { type: 'dex_state_put', requestId: 'send-state', roomId: 'room-one', snapshot: snap, authorization: grant });
  assert.equal(h.first.sent.at(-1).type, 'dex_state_saved');
  h.route.handle(h.first, { type: 'dex_relay_start', requestId: 'send-relay', roomId: 'room-one', sourceMessageId: source.id, authorization: grant });
  assert.equal(h.first.sent.at(-1).result.ok, true);
  h.route.handle(h.first, { type: 'dex_relay_start', requestId: 'replay', roomId: 'room-one', sourceMessageId: source.id, authorization: grant });
  assert.equal(h.first.sent.at(-1).result.code, 'DEX_AGENT_GRANT_REPLAYED');
  assert.equal(h.calls.filter(call => Array.isArray(call) && call[0] === 'start').length, 1);
});
test('replay receipts survive clear-chat, stale room copies and serialized reload', () => {
  const h = harness();
  const message = { id: 'msg-persist-0001', senderKind: 'user', senderId: 'user', text: 'Only once' };
  const send = (requestId, source = message) => h.route.handle(h.first, {
    type: 'dex_relay_start', requestId, roomId: 'room-one',
    sourceMessageId: source.id, sourceMessage: source, budget: 1
  });
  send('relay-persist-1');
  assert.equal(h.first.sent.at(-1).result.ok, true);
  const first = clone(h.state());
  assert.deepEqual(first.rooms[0].userRelayReceipts, [
    { requestId: 'relay-persist-1', messageId: message.id }
  ]);
  const edit = clone(first);
  edit.rooms[0].messages = [];
  delete edit.rooms[0].userRelayReceipts; // older browser without canonical ledger
  const lease = h.lease();
  h.route.handle(h.first, { type: 'dex_state_put', requestId: 'clear-messages',
    roomId: 'room-one', snapshot: edit, authorization: lease });
  assert.equal(h.first.sent.at(-1).type, 'dex_state_saved');
  assert.equal(h.state().rooms[0].messages.length, 0);
  assert.deepEqual(clone(h.state()).rooms[0].userRelayReceipts, first.rooms[0].userRelayReceipts);
  send('relay-persist-1');
  assert.equal(h.first.sent.at(-1).result.code, 'DEX_USER_RELAY_REPLAYED');
  send('relay-persist-2');
  assert.equal(h.first.sent.at(-1).result.code, 'DEX_USER_RELAY_REQUEST_CONFLICT');
  send('relay-persist-1', { ...message, id: 'msg-persist-0002' });
  assert.equal(h.first.sent.at(-1).result.code, 'DEX_USER_RELAY_REQUEST_CONFLICT');
  assert.equal(h.calls.filter(call => Array.isArray(call) && call[0] === 'start').length, 1);
});

test('exhausted user relay ledger fails closed instead of losing replay history', () => {
  const h = harness();
  h.state().rooms[0].userRelayReceipts = Array.from({ length: 8192 }, (_, i) =>
    ({ requestId: `used-${i}`, messageId: `saved-${i}` }));
  h.route.handle(h.first, { type: 'dex_relay_start', requestId: 'new-request',
    roomId: 'room-one', sourceMessageId: 'msg-exhaustion-0001',
    sourceMessage: { id: 'msg-exhaustion-0001', senderKind: 'user', senderId: 'user', text: 'No dispatch' } });
  assert.equal(h.first.sent.at(-1).result.code, 'DEX_USER_RELAY_LEDGER_FULL');
  assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'start'), false);
});
