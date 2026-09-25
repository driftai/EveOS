'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServerSchedulerRecovery } = require('../dex/server-scheduler-recovery');
const receipt = require('../dex/provider-control-receipt');
const done = require('../public/dex-done-watch');
const protocol = require('../public/dex-protocol');

test('late recovered DONE is stitched once, disarms the watch and schedules its out-of-band ping', () => {
  const at = new Date().toISOString(), sent = [], scheduled = [];
  const room = {
    id: 'eve-astro', name: 'Eve + Astro',
    members: [
      { id: 'eve', name: 'Eve', binding: { targetClassId: 'online-origin', targetId: 42, providerId: 'chatgpt', url: 'https://chatgpt.com/c/eve' } },
      { id: 'astro', name: 'Astro', binding: { targetClassId: 'local-origin', targetId: 'local:antigravity-existing:10872', providerId: 'local-antigravity-existing' } }
    ],
    messages: [{ id: 'request', senderKind: 'agent', senderId: 'eve', text: 'Please verify the patch.' }],
    relay: { active: false, waitingFor: null, remaining: 1 },
    recovery: {
      requestId: 'dex-turn-recover', memberId: 'astro', sourceMessageId: 'request',
      targetClassId: 'local-origin', providerId: 'local-antigravity-existing',
      relayActive: true, relayRemaining: 1, retryCount: 0, dispatched: true,
      startedAt: at, interruptedAt: at
    }
  };
  assert.equal(done.arm(room, { watcherMemberId: 'eve', targetMemberId: 'astro',
    id: 'watch-recovery', at }).ok, true);
  let value = { rooms: [room] }, sequence = 0, deliveryFlushes = 0;
  const recovery = createServerSchedulerRecovery({
    load: () => structuredClone(value), save(next) { value = structuredClone(next); return structuredClone(value); },
    uid: () => 'id-1', nowMs: () => Date.now(),
    addMessage(r, payload) {
      const message = { id: 'recovered-' + (++sequence), ...payload };
      r.messages.push(message);
      return message;
    },
    setStopped(r, reason) {
      r.relay = { active: false, waitingFor: null, remaining: 0, lastStopReason: reason };
    },
    enqueueNext() { throw new Error('DONE must not create another agent turn'); },
    processSoon(delay) { scheduled.push(delay); },
    onRecovered({ room: r, member, message, parsed }) {
      if (parsed.done) done.consume(r, { completedMemberId: member.id, message, at });
    },
    onTurnSettled() { deliveryFlushes += 1; }
  });
  assert.equal(recovery.handleEvent({
    type: 'response_final', requestId: 'dex-turn-recover',
    text: 'ASTRO_LINK_ACK [[DEX:DONE]]', observedAt: at
  }), true);
  assert.equal(value.rooms[0].recovery, undefined);
  assert.equal(value.rooms[0].relay.active, false);
  assert.equal(value.rooms[0].doneWatches.length, 0);
  assert.equal(value.rooms[0].doneWatchEvents.length, 1);
  assert.equal(value.rooms[0].doneWatchEvents[0].delivery, 'pending');
  assert.equal(deliveryFlushes, 1);
  assert.deepEqual(scheduled, [0]);
  assert.equal(recovery.handleEvent({
    type: 'response_final', requestId: 'dex-turn-recover', text: 'ASTRO_LINK_ACK [[DEX:DONE]]'
  }), false);
  assert.equal(value.rooms[0].doneWatchEvents.length, 1);
});

test('passive recovery stops blocking newly issued independent control commands', () => {
  const room = {
    id: 'room-1', members: [
      { id: 'eve', binding: { targetClassId: 'online-origin', providerId: 'chatgpt', targetId: 42, url: 'https://chatgpt.com/c/eve' } }
    ],
    relay: { active: false, waitingFor: null },
    recovery: { memberId: 'eve', requestId: 'old-turn', passiveAt: new Date().toISOString() }
  };
  const source = room.members[0].binding;
  assert.equal(receipt.activeSourceTurn({ rooms: [room] }, source), null);
  delete room.recovery.passiveAt;
  assert.equal(receipt.activeSourceTurn({ rooms: [room] }, source).requestId, 'old-turn');
});

test('recovery callback must not weaken exact origin correlation or DONE relay stop', () => {
  const reply = protocol.parseAgentReply('ASTRO_LINK_ACK [[DEX:DONE]]');
  assert.equal(reply.done, true);
  assert.equal(protocol.relayDisposition(reply, 'Astro', false,
    { active: true, remaining: 1 }).action, 'stop');
});
