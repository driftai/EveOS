'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const journal = require('../dex/local-tool-result-journal');
const receipt = require('../dex/provider-control-receipt');
const merge = require('../dex/server-state-merge');
const binding = { targetClassId: 'local-origin',
  targetId: 'local:antigravity-existing:25032', providerId: 'local-antigravity-existing' };
function fixture() {
  const room = { id: 'room-one', relay: { active: false }, members: [
    { id: 'astro', binding: { ...binding } }, { id: 'eve',
      binding: { targetClassId: 'online-origin', targetId: 4, providerId: 'chatgpt' } }
  ], messages: [{ id: 'agent-one', senderKind: 'agent', senderId: 'astro',
    text: 'Sending.', at: '2026-09-26T00:00:00Z' }] };
  const intent = { roomId: room.id, executorMemberId: 'astro',
    executorTarget: { ...binding }, agentMessageId: 'agent-one',
    turnRequestId: 'dex-turn-unique-one', action: 'send', commandKey: 'key' };
  return { room, intent };
}
const result = { ok: true, action: 'send', message: 'Committed.',
  data: { commitState: 'committed', deliveryState: 'queued', commitId: 'msg-new' } };
test('exact local captured command yields one durable NOT-DELIVERED result with no native side effect', () => {
  const { room, intent } = fixture();
  const saved = journal.queue(room, intent, result, 'ctl-one');
  assert.equal(saved.ok, true);
  assert.equal(saved.record.targetId, binding.targetId);
  assert.match(saved.record.text, /^\[DEX TOOL RESULT\]/);
  assert.match(saved.record.text, /QUEUED, NOT DELIVERED/);
  assert.equal(saved.record.state, 'queued');
  assert.equal(journal.queue(room, intent, result, 'ctl-one').deduplicated, true);
  assert.equal(room.localToolResults.length, 1);
  assert.equal(journal.queue(room, intent, { ...result, message: 'Different' }, 'ctl-one').code,
    'DEX_LOCAL_RECEIPT_ID_CONFLICT');
});
test('wrong origin, local target and online executor cannot receive a local result', () => {
  const { room, intent } = fixture();
  assert.equal(journal.queue(room, { ...intent, agentMessageId: 'another' }, result, 'ctl').code,
    'DEX_LOCAL_RECEIPT_UNBOUND');
  assert.equal(journal.queue(room, { ...intent, executorTarget: { ...binding,
    targetId: 'local:antigravity-existing:999' } }, result, 'ctl').code,
    'DEX_LOCAL_RECEIPT_UNBOUND');
  assert.equal(journal.queue(room, { ...intent, executorTarget: {
    targetClassId: 'online-origin', targetId: 4 } }, result, 'ctl').skipped, true);
});
test('native result claim needs idle exact target AND independently verified same session', () => {
  const { room, intent } = fixture();
  journal.queue(room, intent, result, 'ctl-one');
  const args = { memberId: 'astro', targetId: binding.targetId,
    providerId: binding.providerId, verifiedSession: true, nativeIdle: true,
    attemptId: 'attempt-one' };
  assert.equal(journal.claim(room, 'ctl-one', { ...args, verifiedSession: false }).code,
    'DEX_LOCAL_RECEIPT_TARGET_NOT_SAFE');
  room.recovery = { requestId: 'old-turn' };
  assert.equal(journal.claim(room, 'ctl-one', args).code, 'DEX_LOCAL_RECEIPT_TARGET_NOT_SAFE');
  delete room.recovery;
  assert.equal(journal.claim(room, 'ctl-one', { ...args, targetId: 'local:antigravity-existing:999' }).code,
    'DEX_LOCAL_RECEIPT_IDENTITY_MISMATCH');
  assert.equal(journal.claim(room, 'ctl-one', args).ok, true);
  assert.equal(journal.claim(room, 'ctl-one', args).code, 'DEX_LOCAL_RECEIPT_ALREADY_CLAIMED');
  assert.equal(journal.acknowledge(room, 'ctl-one', { attemptId: 'wrong' }).code,
    'DEX_LOCAL_RECEIPT_ACK_MISMATCH');
  assert.equal(journal.acknowledge(room, 'ctl-one', { attemptId: 'attempt-one',
    exactNativeAck: true }).state, 'submitted-not-read');
  assert.equal(journal.claim(room, 'ctl-one', args).code, 'DEX_LOCAL_RECEIPT_ALREADY_CLAIMED');
});
test('native result timeout never resubmits the same control result', () => {
  const { room, intent } = fixture();
  journal.queue(room, intent, result, 'ctl-one');
  const args = { memberId: 'astro', targetId: binding.targetId,
    providerId: binding.providerId, verifiedSession: true, nativeIdle: true, attemptId: 'attempt-one' };
  journal.claim(room, 'ctl-one', args);
  assert.equal(journal.acknowledge(room, 'ctl-one', { attemptId: 'attempt-one',
    exactNativeAck: false }).state, 'outcome-unknown');
  assert.equal(journal.claim(room, 'ctl-one', args).code, 'DEX_LOCAL_RECEIPT_ALREADY_CLAIMED');
});
test('existing control receipt persists the local tool result before clearing its origin intent', () => {
  const { room, intent } = fixture();
  room.pendingProviderControlReceipt = { ...intent,
    executorName: 'Astro', originMessageId: 'human-one' };
  const snapshot = { rooms: [room] };
  const applied = receipt.applyResult(snapshot, intent, result, 'ctl-one');
  assert.ok(applied.receipt);
  assert.equal(applied.snapshot.rooms[0].localToolResults.length, 1);
  assert.equal(applied.snapshot.rooms[0].pendingProviderControlReceipt, undefined);
  assert.equal(applied.snapshot.rooms[0].messages.at(-1).senderKind, 'system');
});
test('stale browser snapshot cannot erase or claim server-owned local feedback', () => {
  const { room, intent } = fixture();
  journal.queue(room, intent, result, 'ctl-one');
  const snapshot = merge.mergeClientSnapshot({ rooms: [room] }, { rooms: [
    { ...room, localToolResults: [], members: room.members, messages: room.messages,
      settings: {}, relay: { active: false } }
  ] });
  assert.equal(snapshot.rooms[0].localToolResults.length, 1);
  assert.equal(snapshot.rooms[0].localToolResults[0].state, 'queued');
});

test('rememberIntent real local lifecycle enqueues its tool result in the correlated room', () => {
  const { room } = fixture();
  const command = { action: 'send', text: 'Status of test delivery.' };
  const pending = receipt.rememberIntent(room, {
    executorMember: room.members[0], sourceMessage: { id: 'human-one', senderKind: 'user' },
    command, agentMessage: room.messages[0], turnRequestId: 'dex-turn-real-one'
  });
  assert.equal(Object.hasOwn(pending, 'roomId'), false);
  const snapshot = { rooms: [room] };
  const origin = receipt.findIntent(snapshot, binding, command);
  assert.equal(origin.roomId, room.id);
  const applied = receipt.applyResult(snapshot, origin, result, 'ctl-real-one');
  assert.ok(applied.receipt);
  assert.equal(room.localToolResultFailure, undefined);
  assert.equal(room.localToolResults?.length, 1);
  assert.equal(room.localToolResults[0].requestId, 'ctl-real-one');
  assert.equal(room.localToolResults[0].roomId, room.id);
  assert.equal(room.localToolResults[0].agentMessageId, room.messages[0].id);
  assert.equal(room.pendingProviderControlReceipt, undefined);
});
