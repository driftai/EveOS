'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const watch = require('../public/dex-done-watch');
const control = require('../public/dex-provider-control');
const { mergeBusyRoom, mergeIdleRoom } = require('../dex/server-state-merge');
const { createDoneWatchDelivery } = require('../dex/done-watch-delivery');
const { createProviderControlRouting } = require('../dex/provider-control-routing');

const now = '2026-09-25T00:00:00.000Z';
const later = '2026-09-25T00:01:00.000Z';
const eveBinding = { targetClassId: 'online-origin', targetId: 42, providerId: 'chatgpt', url: 'https://chatgpt.com/c/eve' };
const astroBinding = { targetClassId: 'local-origin', targetId: 'local:antigravity-existing:10872', providerId: 'local-antigravity-existing' };
const eveSource = { ...eveBinding, providerName: 'ChatGPT' };
function fixture() {
  return { rooms: [{
    id: 'room-astro', name: 'Eve + Astro', members: [
      { id: 'eve', name: 'Eve', binding: { ...eveBinding } },
      { id: 'astro', name: 'Astro', binding: { ...astroBinding } }
    ], relay: { active: false, waitingFor: null }, messages: []
  }] };
}
function arm(room, target = 'astro', id = 'watch-1') {
  const armed = watch.arm(room, { watcherMemberId: 'eve', targetMemberId: target, id, at: now });
  assert.equal(armed.ok, true);
  return armed.watch;
}
function complete(room, member = 'astro', id = 'reply-1') {
  return watch.consume(room, { completedMemberId: member, message: { id, text: 'ASTRO_LINK_ACK' }, at: later });
}

test('DONE watch is opt-in, one-shot, scoped to another participant, and preserves DONE stop', () => {
  const room = fixture().rooms[0];
  assert.equal(complete(room).length, 0, 'no unrequested notifications');
  const armed = arm(room);
  assert.ok(armed.expiresAt);
  assert.equal(watch.summary(room, 'eve').armed.length, 1);
  assert.equal(complete(room, 'eve').length, 0, 'own DONE never triggers watch');
  assert.equal(room.doneWatches.length, 1);
  const events = complete(room);
  assert.equal(events.length, 1);
  assert.equal(events[0].watcherMemberId, 'eve');
  assert.equal(events[0].completedMessageId, 'reply-1');
  assert.equal(events[0].delivery, 'pending');
  assert.equal(room.doneWatches.length, 0);
  assert.equal(complete(room, 'astro', 'reply-2').length, 0, 'consumed watch cannot loop');
  assert.match(watch.notificationText(room, events[0]), /not a Dex relay turn/);
  assert.doesNotMatch(watch.notificationText(room, events[0]), /\[\[DEX:CMD/);
  assert.equal(watch.arm(room, { watcherMemberId: 'astro', id: 'local-1', at: now }).code,
    'DEX_DONE_WATCH_ONLINE_ONLY');
  assert.equal(watch.arm(room, { watcherMemberId: 'eve', targetMemberId: 'eve', id: 'bad', at: now }).code,
    'DEX_DONE_WATCH_BAD_TARGET');
});

test('unwatch and rearm are explicit; expired watches do not fire', () => {
  const room = fixture().rooms[0];
  arm(room);
  assert.equal(watch.disarm(room, 'eve').removed, 1);
  assert.equal(complete(room).length, 0);
  arm(room, 'astro', 'watch-2');
  assert.equal(watch.consume(room, { completedMemberId: 'astro', message: { id: 'late' },
    at: '2026-09-26T01:00:00.000Z' }).length, 0);
  assert.equal(room.doneWatches.length, 0);
  arm(room, 'astro', 'watch-3');
  assert.equal(complete(room, 'astro', 'reply-3').length, 1);
});

test('stale browser snapshots cannot resurrect a watch consumed by localhost', () => {
  const server = fixture().rooms[0], client = structuredClone(server);
  arm(client);
  assert.equal(mergeIdleRoom(server, client).doneWatches.length, 1);
  server.doneWatches = [client.doneWatches[0]];
  server.doneWatchRevision = client.doneWatchRevision;
  complete(server);
  const idle = mergeIdleRoom(server, client);
  assert.equal(idle.doneWatches.length, 0);
  assert.equal(idle.doneWatchEvents.length, 1);
  const busy = mergeBusyRoom({ ...server, relay: { active: true } }, client);
  assert.equal(busy.doneWatches.length, 0);
  assert.equal(busy.doneWatchEvents.length, 1);
});

test('send attaches a one-shot watch before dispatch and rolls back a failed start', () => {
  const state = fixture(), room = state.rooms[0], deliveries = [];
  let shouldStart = true;
  const controller = control.createController({
    state, uid: (kind) => kind + '-one',
    roomMessage(r, kind, id, name, text) {
      const message = { id: 'msg-task', senderKind: kind, senderId: id, senderName: name, text };
      r.messages.push(message); return message;
    },
    startRelay(r, source) {
      deliveries.push({ source: source.id, watchCount: r.doneWatches?.length || 0 });
      return shouldStart;
    },
    persist() {}, renderAll() {}, storage: null
  });
  const result = controller.handle({ source: eveSource,
    command: { action: 'send', room: room.id, text: 'Astro, check the bridge.', relay: true,
      notifyOnDone: true, notifyMember: 'Astro' } });
  assert.equal(result.ok, true);
  assert.equal(deliveries[0].watchCount, 1, 'watch must be durable before dispatch');
  assert.equal(room.doneWatches[0].targetMemberId, 'astro');
  assert.equal(room.messages.length, 1);
  assert.equal(controller.handle({ source: eveSource, command: { action: 'send', room: room.id,
    text: 'No relay', relay: false, notifyOnDone: true } }).code, 'DEX_DONE_WATCH_RELAY_REQUIRED');
  shouldStart = false; room.doneWatches = []; room.messages = [];
  const failed = controller.handle({ source: eveSource, command: { action: 'send',
    room: room.id, text: 'Cannot dispatch', notifyOnDone: true, notifyMember: 'Astro' } });
  assert.equal(failed.ok, false);
  assert.equal(room.messages.length, 0);
  assert.equal(room.doneWatches.length, 0);
});

test('server watch_done and unwatch_done authorize only the exact room member', async () => {
  let snapshot = fixture(), saved = 0;
  const sourceSocket = { role: 'provider-control-extension', sent: [] };
  const router = createProviderControlRouting({
    uiSockets: new Set(), safeSend(s, msg) { s.sent.push(msg); return true; },
    validateSource: async () => true,
    getState: () => snapshot, saveState(next) { saved++; snapshot = next; return snapshot; },
    broadcastState() {}
  });
  const request = async (source, command, id) => {
    await router.handle(sourceSocket, { type: 'provider_control_request', requestId: id, source, command });
    return sourceSocket.sent.at(-1).result;
  };
  const armed = await request(eveSource, { action: 'watch_done', room: 'room-astro', member: 'Astro' }, 'ctl-arm');
  assert.equal(armed.ok, true);
  assert.equal(snapshot.rooms[0].doneWatches[0].targetMemberId, 'astro');
  const stranger = await request({ ...eveSource, targetId: 99, url: 'https://chatgpt.com/c/stranger' },
    { action: 'watch_done', room: 'room-astro' }, 'ctl-stranger');
  assert.equal(stranger.ok, false);
  assert.equal(stranger.code, 'DEX_DONE_WATCH_ROOM_REQUIRED');
  assert.equal((await request(eveSource, { action: 'unwatch_done', room: 'room-astro' }, 'ctl-cancel')).ok, true);
  assert.equal(snapshot.rooms[0].doneWatches.length, 0);
  assert.equal(saved, 2);
});

test('DONE delivery queues while offline, checks target and busy room, and never resends after dispatch', () => {
  let state = fixture(), socket = null, sent = [];
  const room = state.rooms[0];
  arm(room);
  complete(room);
  const delivery = createDoneWatchDelivery({
    load: () => structuredClone(state), save(next) { state = structuredClone(next); return state; },
    safeSend(s, msg) { sent.push(msg); return true; },
    getSocket: () => socket, getTabs: () => [{ id: 42, providerId: 'chatgpt', url: eveBinding.url }]
  });
  assert.equal(delivery.flush().sent, 0);
  assert.equal(state.rooms[0].doneWatchEvents[0].delivery, 'pending');
  socket = { readyState: 1 };
  state.rooms[0].relay.active = true;
  assert.equal(delivery.flush().sent, 0, 'busy exact tab must not receive a new prompt');
  state.rooms[0].relay.active = false;
  assert.equal(delivery.flush().sent, 1);
  assert.equal(sent[0].source.targetId, 42);
  assert.equal(sent[0].type, 'dex_done_watch_event');
  assert.equal(state.rooms[0].doneWatchEvents[0].delivery, 'sent-unconfirmed');
  assert.equal(delivery.flush().sent, 0);
  assert.equal(sent.length, 1, 'no automatic replay');
  assert.equal(delivery.handleAck({}, { type: 'dex_done_watch_ack', eventId: sent[0].eventId, ok: true }), false);
  assert.equal(delivery.handleAck(socket, { type: 'dex_done_watch_ack', eventId: sent[0].eventId, ok: true }), true);
  assert.equal(state.rooms[0].doneWatchEvents[0].delivery, 'confirmed');
});
