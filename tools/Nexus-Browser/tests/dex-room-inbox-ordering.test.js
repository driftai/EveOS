'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../public/dex-protocol');
const mailbox = require('../dex/recovery-mailbox');
const stateApi = require('../dex/server-scheduler-state');
const merge = require('../dex/server-state-merge');
const directSend = require('../dex/provider-control-direct-send');
const eve = { targetClassId: 'online-origin', targetId: 42, providerId: 'chatgpt', url: 'https://chatgpt.com/c/eve' };
const astro = { targetClassId: 'local-origin', targetId: 'local:antigravity-existing:9', providerId: 'local-antigravity-existing' };
function fixture() {
  return { version: 1, rooms: [{ id: 'room-1', name: 'Eve + Astro', members: [
    { id: 'eve', name: 'Eve', relayEnabled: true, binding: eve },
    { id: 'astro', name: 'Astro', relayEnabled: true, binding: astro }
  ], settings: { maxTurns: 8, contextMessages: 8 },
  messages: [{ id: 'm1', senderKind: 'user', senderName: 'Drift', text: 'Original request.' }],
  relay: { active: true, remaining: 3, turnBudgetTotal: 8, scheduledTurns: 5, waitingFor: 'eve' },
  recovery: { requestId: 'dex-turn-inflight', memberId: 'eve', sourceMessageId: 'm1', dispatched: true }
  }] };
}
function admit(snapshot, id, text, from = astro, room = 'room-1') {
  return mailbox.queueRoomSend(snapshot, { source: from, requestId: id,
    command: { action: 'send', room, relay: true, text },
    at: '2026-09-26T18:00:00Z', makeId: () => 'msg-' + id });
}
test('active room admits two later reports durably in FIFO order without aborting the in-flight turn', () => {
  const state = fixture(), room = state.rooms[0];
  const a = admit(state, 'control-1', 'Astro started tests.');
  const b = admit(state, 'control-2', 'Astro finished: two failures found.');
  assert.equal(a.result.data.deliveryState, 'queued');
  assert.equal(b.result.data.deliveryState, 'queued');
  assert.equal(room.recovery.requestId, 'dex-turn-inflight');
  assert.equal(room.relay.waitingFor, 'eve');
  assert.deepEqual(room.deferredRelays.map(e => e.messageId), ['msg-control-1', 'msg-control-2']);
  assert.deepEqual(room.messages.slice(-2).map(m => m.text),
    ['Astro started tests.', 'Astro finished: two failures found.']);
  assert.equal(mailbox.activateNext(state), false, 'queued reports cannot interrupt an in-flight gesture');
});
test('pending next hop batches FIFO updates and retains the full old source plus latest-per-agent policy', () => {
  const state = fixture(), room = state.rooms[0];
  admit(state, 'control-1', 'Astro started tests.');
  admit(state, 'control-2', 'Astro finished: two failures found.');
  delete room.recovery;
  room.pendingTurn = { memberId: 'eve', sourceMessageId: 'm1', queuedAt: '2026-09-26T18:00:00Z' };
  assert.equal(mailbox.stageForPending(room), 2);
  assert.equal(room.deferredRelays.length, 0);
  assert.deepEqual(room.pendingTurn.inboxMessageIds, ['msg-control-1', 'msg-control-2']);
  assert.deepEqual(room.deferredSendReceipts.map(r => r.phase), ['batched', 'batched']);
  const prompt = protocol.buildRelayPrompt({ room, recipient: room.members[0],
    sourceMessage: room.messages[0], requestId: 'dex-turn-next',
    inboxMessageIds: room.pendingTurn.inboxMessageIds });
  assert.ok(prompt.indexOf('Astro started tests.') < prompt.indexOf('Astro finished: two failures found.'));
  assert.match(prompt, /Queued message IDs: msg-control-1, msg-control-2/);
  assert.match(prompt, /Current message:\nOriginal request/);
  assert.doesNotMatch(prompt, /deliveryState:.*delivered/);
});
test('exact request retry is idempotent after the inbox is drained and the short receipt list is gone', () => {
  const state = fixture(), room = state.rooms[0];
  const initial = admit(state, 'control-1', 'Final report text');
  room.deferredSendReceipts = [];
  room.deferredRelays = [];
  const retry = admit(state, 'control-1', 'Final report text');
  assert.equal(retry.changed, false);
  assert.equal(retry.result.data.messageId, initial.result.data.messageId);
  assert.equal(room.messages.length, 2);
  const changedPayload = admit(state, 'control-1', 'Different report body');
  assert.equal(changedPayload.result.code, 'DEX_REQUEST_ID_CONFLICT');
  assert.equal(room.messages.length, 2);
});
test('same request id in a different authorized room fails closed', () => {
  const state = fixture(), second = structuredClone(state.rooms[0]);
  second.id = 'room-2'; second.name = 'Backup room'; second.messages = [];
  second.deferredRelays = []; second.deferredSendReceipts = [];
  state.rooms.push(second);
  admit(state, 'control-1', 'Original report');
  const result = admit(state, 'control-1', 'Original report', astro, 'room-2');
  assert.equal(result.result.code, 'DEX_REQUEST_ID_CONFLICT');
  assert.equal(second.messages.length, 0);
});
test('online room identity requires its exact bound tab and URL, not a matching URL alone', () => {
  const state = fixture();
  assert.equal(admit(state, 'wrong-tab', 'Untrusted', { ...eve, targetId: 77 }), null);
  assert.equal(admit(state, 'wrong-url', 'Untrusted', { ...eve, url: 'https://chatgpt.com/c/other' }), null);
  assert.equal(admit(state, 'exact-eve', 'Authenticated', eve).result.ok, true);
});
test('stale browser room sync cannot erase newly queued messages while nominal relay is idle', () => {
  const state = fixture(), server = state.rooms[0];
  server.relay = { active: false, waitingFor: null, remaining: 0 };
  delete server.recovery;
  admit(state, 'control-1', 'New durable report');
  const client = { ...structuredClone(server), messages: [], deferredRelays: [] };
  const merged = merge.mergeClientSnapshot(state, { rooms: [client], activeRoomId: 'room-1' });
  assert.deepEqual(merged.rooms[0].deferredRelays.map(r => r.requestId), ['control-1']);
  assert.equal(merged.rooms[0].messages.at(-1).text, 'New durable report');
});
test('stopped NOTE room starts queued updates exactly once after the old turn settles', () => {
  const state = fixture(), room = state.rooms[0];
  admit(state, 'control-1', 'First result.');
  admit(state, 'control-2', 'Final result.');
  delete room.recovery;
  room.relay = { active: false, waitingFor: null, remaining: 0, lastStopReason: 'Eve posted a note' };
  assert.equal(mailbox.activateNext(state), true);
  assert.equal(room.pendingTurn.memberId, 'eve');
  assert.equal(room.pendingTurn.sourceMessageId, 'msg-control-2');
  assert.deepEqual(room.pendingTurn.inboxMessageIds, ['msg-control-1']);
  assert.equal(room.deferredRelays.length, 0);
  assert.equal(mailbox.activateNext(state), false, 'no second activation of a dispatched batch');
  assert.equal(room.deferredSendReceipts[0].phase, 'dispatched');
  assert.equal(room.deferredSendReceipts[1].phase, 'dispatched');
});
test('disabled participants and pending control receipt hold the FIFO instead of losing it', () => {
  const state = fixture(), room = state.rooms[0];
  admit(state, 'control-1', 'Needs attention.');
  delete room.recovery;
  room.relay = { active: false, waitingFor: null, remaining: 0 };
  room.members.forEach(m => { m.relayEnabled = false; });
  assert.equal(mailbox.activateNext(state), false);
  assert.equal(room.deferredRelays.length, 1);
  room.members[0].relayEnabled = true;
  room.pendingProviderControlReceipt = { action: 'status', agentMessageId: 'unsettled' };
  assert.equal(mailbox.activateNext(state), false);
  assert.equal(room.deferredRelays.length, 1);
  delete room.pendingProviderControlReceipt;
  assert.equal(mailbox.activateNext(state), true);
});
test('bounded queue rejects overflow without appending a phantom room message', () => {
  const state = fixture();
  for (let i = 0; i < mailbox.MAX_QUEUED; i++)
    assert.equal(admit(state, 'r-' + i, 'Update ' + i).result.ok, true);
  const before = state.rooms[0].messages.length;
  const overflow = admit(state, 'r-overflow', 'Must not be committed');
  assert.equal(overflow.result.code, 'DEX_ROOM_INBOX_FULL');
  assert.equal(state.rooms[0].messages.length, before);
});
test('a full pending-hop inbox leaves later FIFO entries queued for the next safe hop', () => {
  const state = fixture(), room = state.rooms[0];
  for (let i = 0; i < mailbox.MAX_QUEUED; i++) admit(state, 'r-' + i, 'Update ' + i);
  room.pendingTurn = { memberId: 'eve', sourceMessageId: 'm1',
    inboxMessageIds: Array.from({ length: 8 }, (_, i) => 'previous-' + i) };
  assert.equal(mailbox.stageForPending(room), 0);
  assert.equal(room.deferredRelays.length, 8);
});
test('direct provider-control admission commits before replying and does not require the Dex UI', () => {
  let state = fixture(), replies = [], persisted = 0, resumed = 0;
  const result = directSend.route({ source: astro, requestId: 'ctl-direct', ws: {},
    command: { action: 'send', room: 'room-1', text: 'Ready to report', relay: true } }, {
    getState: () => structuredClone(state),
    saveState: next => { persisted++; state = structuredClone(next); return state; },
    broadcastState: () => {},
    getScheduler: () => ({ onStateChanged() { resumed++; } }),
    now: () => Date.parse('2026-09-26T18:00:00Z'),
    findOrigin: () => null, commitOriginReceipt: () => null,
    sendResult: (_waiter, response) => { assert.equal(persisted, 1);
      replies.push(response); }
  });
  assert.equal(result, true);
  assert.equal(resumed, 1);
  assert.equal(replies[0].data.deliveryState, 'queued');
  assert.equal(state.rooms[0].deferredRelays.length, 1);
});

test('ambiguous disk-write outcome never claims inbox delivery or retries under a new request ID', () => {
  const state = fixture(), sent = [];
  assert.equal(directSend.route({
    source: astro, requestId: 'ctl-write-uncertain', ws: {},
    command: { action: 'send', room: 'room-1', relay: true, text: 'One durable report' }
  }, {
    getState: () => structuredClone(state),
    saveState() { throw Error('Disk write state unknown'); },
    broadcastState() { throw Error('Must not broadcast an unconfirmed write'); },
    getScheduler() { throw Error('Must not dispatch after a failed write'); },
    now: () => Date.parse('2026-09-26T18:00:00Z'),
    findOrigin: () => null, commitOriginReceipt: () => null,
    sendResult: (_origin, result) => sent.push(result)
  }), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].code, 'DEX_INBOX_COMMIT_UNCERTAIN');
  assert.match(sent[0].message, /same request ID/);
});
