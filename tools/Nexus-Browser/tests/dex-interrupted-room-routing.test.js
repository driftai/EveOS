'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderControlRouting } = require('../dex/provider-control-routing');
const source = { targetClassId: 'online-origin', targetId: 42,
  providerId: 'chatgpt', url: 'https://chatgpt.com/c/eve' };
function harness() {
  let state = { rooms: [{
    id: 'room-1', name: 'Eve + Astro',
    members: [{ id: 'eve', name: 'Eve', binding: source }, { id: 'astro', name: 'Astro',
      binding: { targetClassId: 'local-origin', providerId: 'local-antigravity-existing',
        targetId: 'local:antigravity-existing:9' } }],
    relay: { active: false, waitingFor: null, remaining: 0 },
    recovery: { requestId: 'old-interrupted', memberId: 'eve',
      sourceMessageId: 'source', dispatched: true, passiveAt: new Date().toISOString() },
    messages: [{ id: 'source', senderKind: 'user', text: 'Old task' }]
  }] };
  const ws = { role: 'provider-control-extension', sent: [] }, events = [];
  const routing = createProviderControlRouting({
    uiSockets: new Set(), safeSend(socket, payload) { socket.sent.push(payload); return true; },
    validateSource: async () => true,
    ensureDexClient() { throw Error('Interrupted sends must not require UI'); },
    getDexClient: () => null, getState: () => structuredClone(state),
    saveState(next) { state = structuredClone(next); return structuredClone(state); },
    broadcastState(next) { events.push(next); },
    now: () => Date.parse('2026-09-18T23:52:00.000Z')
  });
  return { routing, ws, events, get state() { return state; } };
}
function request(requestId) {
  return { type: 'provider_control_request', requestId, source,
    command: { action: 'send', room: 'room-1', text: 'One new request', relay: true } };
}
test('paused recovery accepts one durable queued send even when Dex UI is offline', async () => {
  const h = harness();
  assert.equal(await h.routing.handle(h.ws, request('ctl-1')), true);
  const result = h.ws.sent.find((x) => x.type === 'provider_control_result');
  assert.equal(result.result.ok, true);
  assert.equal(result.result.data.deliveryState, 'queued');
  assert.equal(h.state.rooms[0].messages.length, 2);
  assert.equal(h.state.rooms[0].deferredRelays.length, 1);
  assert.equal(h.state.rooms[0].relay.active, false);
  assert.equal(h.events.length, 1);
});
test('retrying the same interrupted send does not create a second message', async () => {
  const h = harness();
  await h.routing.handle(h.ws, request('ctl-1'));
  await h.routing.handle(h.ws, request('ctl-1'));
  assert.equal(h.state.rooms[0].messages.length, 2);
  assert.equal(h.state.rooms[0].deferredRelays.length, 1);
});
