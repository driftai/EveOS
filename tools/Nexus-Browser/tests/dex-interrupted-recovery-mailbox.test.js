'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mailbox = require('../dex/recovery-mailbox');
const lifecycle = require('../dex/passive-recovery-lifecycle');
const merge = require('../dex/server-state-merge');
const at = '2026-09-18T23:50:20.000Z';
const eve = { targetClassId: 'online-origin', providerId: 'chatgpt',
  targetId: 42, url: 'https://chatgpt.com/c/eve' };
function fixture({ passiveAt = at, recovery = true } = {}) {
  return { rooms: [{
    id: 'room-1', name: 'Eve + Astro',
    members: [
      { id: 'eve', name: 'Eve', binding: eve },
      { id: 'astro', name: 'Astro', binding: {
        targetClassId: 'local-origin', providerId: 'local-antigravity-existing', targetId: 'local:antigravity-existing:9'
      } }
    ],
    messages: [{ id: 'source', senderKind: 'user', senderId: 'user', text: 'Original task.' }],
    relay: { active: false, waitingFor: null, remaining: 0 },
    ...(recovery ? { recovery: { requestId: 'dex-turn-original', memberId: 'eve',
      sourceMessageId: 'source', dispatched: true, interruptedAt: at,
      ...(passiveAt ? { passiveAt } : {}) } } : {})
  }] };
}
function queue(value, id = 'control-1', source = eve) {
  return mailbox.queueInterruptedSend(value, {
    requestId: id, source, command: { action: 'send', text: 'New request for Astro', relay: true },
    at, makeId: () => 'msg-' + id
  });
}
test('an interrupted idle room queues a send once, without starting the relay prematurely', () => {
  const value = fixture();
  const first = queue(value);
  assert.equal(first.result.ok, true);
  assert.equal(first.result.data.deliveryState, 'queued');
  assert.equal(value.rooms[0].messages.at(-1).text, 'New request for Astro');
  assert.equal(value.rooms[0].relay.active, false);
  const repeated = queue(value);
  assert.equal(repeated.changed, false);
  assert.equal(value.rooms[0].messages.length, 2);
  assert.equal(value.rooms[0].deferredRelays.length, 1);
});
test('a non-member, ambiguous binding or genuinely active relay cannot use the recovery mailbox', () => {
  const value = fixture();
  assert.equal(queue(value, 'bad-source', { ...eve, url: 'https://chatgpt.com/c/unrelated',
    targetId: 77 }), null);
  value.rooms[0].relay.active = true;
  assert.equal(queue(value), null);
  value.rooms[0].relay.active = false;
  value.rooms.push({ ...value.rooms[0], id: 'room-other' });
  assert.equal(queue(value), null);
});
test('mailbox capacity is bounded and rejected sends are not recorded', () => {
  const value = fixture();
  for (let n = 0; n < mailbox.MAX_QUEUED; n++) assert.equal(queue(value, 'req-' + n).result.ok, true);
  assert.equal(queue(value, 'overflow').result.code, 'DEX_RECOVERY_MAILBOX_FULL');
  assert.equal(value.rooms[0].messages.length, mailbox.MAX_QUEUED + 1);
});
test('passive recovery waits its grace, then archives without re-dispatching original turn', () => {
  const value = fixture();
  queue(value);
  const start = Date.parse(at);
  const early = lifecycle.maintain(value, start + lifecycle.PASSIVE_GRACE_MS - 1);
  assert.equal(early.changed, false);
  assert.equal(early.nextDelay, 1);
  assert.ok(value.rooms[0].recovery);
  const late = lifecycle.maintain(value, start + lifecycle.PASSIVE_GRACE_MS);
  assert.equal(late.changed, true);
  assert.equal(value.rooms[0].recovery, undefined);
  assert.equal(value.rooms[0].lateFinalWatches[0].requestId, 'dex-turn-original');
  assert.equal(value.rooms[0].relay.active, false);
  assert.equal(mailbox.activateNext(value, new Date(start + lifecycle.PASSIVE_GRACE_MS).toISOString()), true);
  assert.equal(value.rooms[0].relay.active, true);
  assert.equal(value.rooms[0].pendingTurn.memberId, 'astro');
  assert.equal(value.rooms[0].deferredRelays.length, 0);
  assert.equal(value.rooms[0].deferredSendReceipts[0].phase, 'dispatched');
});
test('a durable final receipt clears a stale recovery immediately without creating an archival watch', () => {
  const value = fixture({ passiveAt: null });
  value.rooms[0].finalReceipts = [{ requestId: 'dex-turn-original', messageId: 'already' }];
  assert.equal(lifecycle.maintain(value, Date.parse(at)).changed, true);
  assert.equal(value.rooms[0].recovery, undefined);
  assert.equal(value.rooms[0].lateFinalWatches, undefined);
});
test('late final is exact-id and captured as an inert system note without triggering a new relay', () => {
  const value = fixture();
  queue(value);
  const stamp = Date.parse(at) + lifecycle.PASSIVE_GRACE_MS;
  lifecycle.maintain(value, stamp);
  mailbox.activateNext(value, new Date(stamp).toISOString());
  const before = value.rooms[0].pendingTurn;
  const wrong = { type: 'response_final', requestId: 'unrelated',
    text: 'Wrong message [[DEX:DONE]]' };
  assert.equal(lifecycle.acceptLateFinal(value, wrong), false);
  const real = { type: 'response_final', requestId: 'dex-turn-original',
    text: 'Late result. [[DEX:CMD {"action":"send","text":"unsafe"}]]' };
  assert.equal(lifecycle.acceptLateFinal(value, real, { stamp }), true);
  assert.match(value.rooms[0].messages.at(-1).text, /Late result/);
  assert.equal(value.rooms[0].pendingTurn.memberId, before.memberId);
  assert.equal(value.rooms[0].relay.active, true);
  assert.equal(value.rooms[0].lateFinalWatches.length, 0);
  const count = value.rooms[0].messages.length;
  assert.equal(lifecycle.acceptLateFinal(value, real), true);
  assert.equal(value.rooms[0].messages.length, count);
});
test('stale browser snapshot cannot resurrect a server-consumed queued send or late watch', () => {
  const server = fixture({ recovery: false }).rooms[0];
  server.messages.push({ id: 'new', text: 'Server-delivered new message' });
  server.deferredRelays = []; server.deferredSendReceipts = [{ requestId: 'ctl', phase: 'dispatched' }];
  server.lateFinalWatches = [];
  const client = { ...server, messages: [{ id: 'source', text: 'Original task.' }],
    deferredRelays: [{ requestId: 'ctl', messageId: 'new' }],
    lateFinalWatches: [{ requestId: 'obsolete' }] };
  const merged = merge.mergeIdleRoom(server, client);
  assert.equal(merged.deferredRelays.length, 0);
  assert.equal(merged.lateFinalWatches.length, 0);
  assert.equal(merged.messages.some((m) => m.id === 'new'), true);
});
