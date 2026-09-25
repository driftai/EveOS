'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../public/dex-protocol');
const watch = require('../public/dex-done-watch');
const { createDoneWatchDelivery } = require('../dex/done-watch-delivery');

const TURN = 'dex-turn-12345678-1234-1234-1234-123456789012';
const CLOCK = '2026-09-25T06:00:00.000Z';
function fixture() {
  return { id: 'room-astro', name: 'Eve + Astro', members: [
    { id: 'astro', name: 'Astro', binding: { targetClassId: 'local-origin',
      targetId: 'local:antigravity-existing:10872', providerId: 'local-antigravity-existing' } },
    { id: 'eve', name: 'Eve', binding: { targetClassId: 'online-origin',
      targetId: 42, providerId: 'chatgpt', url: 'https://chatgpt.com/c/eve' } },
    { id: 'eve2', name: 'Eve', binding: { targetClassId: 'online-origin',
      targetId: 43, providerId: 'chatgpt', url: 'https://chatgpt.com/c/eve2' } }
  ], relay: { active: true, remaining: 2 }, messages: [] };
}
function cleanRoom() {
  const room = fixture();
  room.members.pop(); // unique Eve
  return room;
}
function emit(room, id = 'msg-1', at = CLOCK, targetRef = 'Eve', done = true, invalid = false) {
  return watch.emitHeadsUp(room, { senderMemberId: 'astro', targetRef, invalid, done,
    message: { id, text: 'Qualification completed.' }, at });
}
test('only a trailing explicit HEADSUP and DONE select one recipient without a relay turn', () => {
  const text = 'Qualification complete. [[DEX:RETURN:' + TURN + ']] [[DEX:HEADSUP:Eve]] [[DEX:DONE]]';
  const parsed = protocol.parseAgentReply(text);
  assert.equal(parsed.text, 'Qualification complete.');
  assert.equal(parsed.headsUpTarget, 'Eve');
  assert.equal(parsed.returnRequestId, TURN);
  assert.equal(parsed.done, true);
  assert.equal(protocol.relayDisposition(parsed, 'Astro', false,
    { active: true, remaining: 2 }).action, 'stop');
  assert.equal(protocol.parseAgentReply('Mention [[DEX:HEADSUP:Eve]] in prose, keep working.').headsUpTarget, undefined);
  assert.equal(protocol.parseAgentReply('Done. [[DEX:HEADSUP:Eve]] [[DEX:HEADSUP:Bob]] [[DEX:DONE]]').headsUpInvalid, true);
});
test('DONE without HEADSUP causes no unrequested notification; explicit HEADSUP selects only one online agent', () => {
  const room = cleanRoom();
  assert.equal(watch.consume(room, { completedMemberId: 'astro',
    message: { id: 'msg-0', text: 'Finished.' }, at: CLOCK }).length, 0);
  assert.equal(room.doneWatchEvents, undefined);
  const result = emit(room);
  assert.equal(result.ok, true);
  assert.equal(result.event.kind, 'heads-up');
  assert.equal(result.event.watcherMemberId, 'eve');
  assert.equal(result.event.completedMemberId, 'astro');
  assert.equal(result.event.delivery, 'pending');
  assert.equal(room.doneWatches, undefined, 'HEADSUP never arms a subscriber');
  const text = watch.notificationText(room, result.event);
  assert.match(text, /\[DEX HEADS UP\]/);
  assert.match(text, /not a Dex relay turn/i);
  assert.match(text, /Do not automatically reply/);
  assert.equal(watch.headsUpSummary(room, 'astro').lastSent.status, 'queued');
  assert.equal(watch.headsUpSummary(room, 'eve').latest.length, 1);
});
test('ambiguous, self, local-origin, repeated and non-DONE requests fail closed', () => {
  const ambiguous = fixture();
  assert.equal(emit(ambiguous).code, 'DEX_HEADSUP_TARGET_AMBIGUOUS');
  assert.equal(ambiguous.doneWatchEvents, undefined);
  const room = cleanRoom();
  assert.equal(emit(room, 'm1', CLOCK, 'astro').code, 'DEX_HEADSUP_SELF');
  assert.equal(watch.emitHeadsUp(room, { senderMemberId: 'eve', targetRef: 'Astro',
    done: true, message: { id: 'm2', text: 'FYI' }, at: CLOCK }).code,
    'DEX_HEADSUP_ONLINE_ONLY');
  assert.equal(emit(room, 'm3', CLOCK, 'Eve', false).code, 'DEX_HEADSUP_DONE_REQUIRED');
  assert.equal(emit(room, 'm4', CLOCK, 'Eve', true, true).code, 'DEX_HEADSUP_MULTIPLE_TARGETS');
  const first = emit(room, 'm5');
  assert.equal(first.ok, true);
  assert.equal(emit(room, 'm5').suppressed, 'already-notified');
  assert.equal(emit(room, 'm6', '2026-09-25T06:01:00.000Z').suppressed, 'cooldown');
  assert.equal(room.doneWatchEvents.length, 1);
});
test('the exact browser receives one bounded notification only after its other rooms are idle', () => {
  let state = { rooms: [cleanRoom()] }, socket = null, messages = [];
  const room = state.rooms[0];
  room.relay.active = false;
  emit(room);
  const api = createDoneWatchDelivery({
    load: () => structuredClone(state),
    save(snapshot) { state = structuredClone(snapshot); return state; },
    getSocket: () => socket,
    getTabs: () => [{ id: 42, providerId: 'chatgpt', url: 'https://chatgpt.com/c/eve' }],
    safeSend(_socket, message) { messages.push(message); return true; },
    now: () => '2026-09-25T06:00:15.000Z'
  });
  assert.equal(api.flush().sent, 0);
  assert.equal(state.rooms[0].doneWatchEvents[0].delivery, 'pending');
  socket = { readyState: 1 };
  state.rooms[0].relay.active = true;
  assert.equal(api.flush().sent, 0);
  state.rooms[0].relay.active = false;
  assert.equal(api.flush().sent, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'heads-up');
  assert.equal(messages[0].source.targetId, 42);
  assert.equal(api.flush().sent, 0, 'do not resend an uncertain submission');
  assert.equal(api.handleAck(socket, { type: 'dex_done_watch_ack',
    eventId: messages[0].eventId, ok: true }), true);
  assert.equal(state.rooms[0].doneWatchEvents[0].delivery, 'confirmed');
});
test('an offline heads-up expires without pinging a previously absent agent', () => {
  let state = { rooms: [cleanRoom()] };
  const room = state.rooms[0]; room.relay.active = false; emit(room);
  const socket = { readyState: 1 }, delivered = [];
  const api = createDoneWatchDelivery({
    load: () => structuredClone(state),
    save(snapshot) { state = structuredClone(snapshot); return state; },
    getSocket: () => socket,
    getTabs: () => [{ id: 42, providerId: 'chatgpt', url: 'https://chatgpt.com/c/eve' }],
    safeSend(_socket, item) { delivered.push(item); return true; },
    now: () => '2026-09-25T06:31:00.000Z'
  });
  assert.equal(api.flush().sent, 0);
  assert.equal(delivered.length, 0);
  assert.equal(state.rooms[0].doneWatchEvents[0].delivery, 'expired');
});
