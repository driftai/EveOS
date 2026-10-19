'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileDormant, APPROVAL_TTL_MS, PRESENCE_TTL_MS } = require('../dex/stale-room-work');
const { startStaleRoomSweeper } = require('../dex/stale-room-sweeper');
const past = new Date(Date.now() - 36 * 60 * 1000).toISOString();
const room = () => ({ id: 'room-safe', name: 'Safe Room', relay: { active: false, waitingFor: null },
  messages: [{ id: 'msg-source', text: 'preserve' }],
  pendingProviderControlReceipt: { action: 'quorum_presence', commandKey: '{"action":"quorum_presence"}',
    turnRequestId: 'turn-a', agentMessageId: 'agent-a', createdAt: past },
  machineSpaces: { spaces: [{ id: 'space-a', requests: [
    { requestId: 'approve-a', state: 'approval-required', terminalId: 'terminal-stale', command: 'echo old', createdAt: past },
    { requestId: 'running-a', state: 'running', terminalId: 'terminal-live', createdAt: past }
  ], ledger: null }] } });
test('no automatic cleanup when room has a running machine command', () => {
  const r = room(), state = { rooms: [r], retiredProviderControlReceipts: [] };
  const before = JSON.stringify(state);
  const out = reconcileDormant(state);
  assert.equal(out.changed, false);
  assert.equal(JSON.stringify(state), before);
});
test('expired undisbursed approvals and presence are retired with distinct evidence', () => {
  const r = room(); r.machineSpaces.spaces[0].requests.pop();
  const state = { rooms: [r], retiredProviderControlReceipts: [] };
  const out = reconcileDormant(state);
  assert.equal(out.changed, true);
  assert.deepEqual(out.events.map(e => e.code), ['EXPIRED_PRESENCE_UNRESOLVED_ARCHIVED','EXPIRED_UNAPPROVED_REQUEST_DENIED']);
  assert.equal(state.rooms[0].machineSpaces.spaces[0].requests[0].state, 'denied');
  assert.equal(state.rooms[0].machineSpaces.spaces[0].requests[0].command, undefined);
  assert.equal(state.rooms[0].messages[0].text, 'preserve');
  assert.equal(state.retiredProviderControlReceipts[0].disposition, 'AUTO_RETIRED_UNRESOLVED_EXPIRED_PRESENCE');
  assert.equal(state.rooms[0].pendingProviderControlReceipt, undefined);
  assert.equal(reconcileDormant(state).changed, false);
});
test('never infer outcomes for dispatched, recently-created, malformed or non-presence work', () => {
  const r = room(); r.machineSpaces.spaces[0].requests.pop();
  r.pendingProviderControlReceipt.action = 'quorum_vote';
  r.machineSpaces.spaces[0].ledger = { events: [{ requestId: 'approve-a', state: 'queued' }] };
  const state = { rooms: [r], retiredProviderControlReceipts: [] };
  assert.equal(reconcileDormant(state).changed, false);
  r.pendingProviderControlReceipt.action = 'quorum_presence';
  r.pendingProviderControlReceipt.createdAt = new Date().toISOString();
  assert.equal(reconcileDormant(state).changed, false);
  r.pendingProviderControlReceipt.createdAt = 'garbled';
  assert.equal(reconcileDormant(state).changed, false);
});
test('receipt archive at capacity blocks expiry without dropping audit records', () => {
  const r = room(); r.machineSpaces.spaces[0].requests = [];
  const state = { rooms: [r], retiredProviderControlReceipts: Array.from({ length: 100 }, (_, i) => ({ i })) };
  assert.equal(reconcileDormant(state).changed, false);
  assert.equal(state.retiredProviderControlReceipts.length, 100);
  assert.ok(r.pendingProviderControlReceipt);
});
test('supervisor refuses maintenance while any lease is active and keeps operations separate', () => {
  const r = room(); r.machineSpaces.spaces[0].requests.pop();
  let value = { rooms: [r], retiredProviderControlReceipts: [] };
  let saves = 0, broadcast = 0;
  const supervisor = startStaleRoomSweeper({
    stateStore: { load: () => structuredClone(value), save(next) { saves++; value = next; return next; } },
    broadcast: () => broadcast++, hasPendingControls: () => true,
    setTimeoutImpl: () => null, setIntervalImpl: () => null });
  assert.equal(supervisor.sweep().skipped, true);
  assert.equal(saves, 0);
  assert.equal(broadcast, 0);
});
test('approval and presence expiration budgets exceed native authority TTLs', () => {
  assert.ok(APPROVAL_TTL_MS >= 60000);
  assert.ok(PRESENCE_TTL_MS >= 120000);
});
test('when an old-format snapshot has no retired receipt field, archive is explicitly persisted', () => {
  const r = room(); r.machineSpaces.spaces[0].requests = [];
  const snapshot = { rooms: [r] };
  const outcome = reconcileDormant(snapshot);
  assert.equal(outcome.changed, true);
  assert.equal(snapshot.retiredProviderControlReceipts.length, 1);
  assert.equal(snapshot.retiredProviderControlReceipts[0].turnRequestId, 'turn-a');
});
