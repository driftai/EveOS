'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const policy = require('../dex/provider-control-entry-check');
const members = require('../public/dex-members');
const source = { targetClassId: 'online-origin', providerId: 'chatgpt',
  targetId: 116814673, url: 'https://chatgpt.com/c/eve-room' };
const staleTab = { ...source, targetId: 116814674 };
const staleChat = { ...source, url: 'https://chatgpt.com/c/new-chat' };
function snapshot() { return { rooms: [{ id: 'room-eve', name: 'Eve + Astro',
  members: [{ id: 'eve', binding: { ...source } }] }] }; }
test('all bound commands reject partial tab-ID or URL-only matches', () => {
  const actions = require('../public/dex-provider-control').ACTIONS;
  for (const candidate of [staleTab, staleChat]) for (const action of actions) {
    if (policy.UNBOUND_ACTIONS.has(action)) continue;
    const r = policy.authorize(snapshot(), candidate, { action, room: 'room-eve' });
    assert.equal(r.ok, false, action);
    assert.equal(r.code, 'DEX_ROOM_STALE_BINDING', action);
  }
});
test('send, discovery, status and maintenance share the exact entry check', () => {
  for (const action of ['send', 'rooms', 'targets', 'status', 'room_budget',
    'room_log', 'tool_result_status', 'watch_done', 'reload_extension',
    'arm_post_idle', 'stop_relay', 'continue_relay']) {
    const r = policy.authorize(snapshot(), source, { action, room: 'room-eve' });
    assert.equal(r.ok, true, action);
    assert.equal(r.roomId, 'room-eve', action);
  }
  assert.equal(policy.authorize(snapshot(), source,
    { action: 'status', room: 'wrong' }).code, 'DEX_ROOM_NOT_BOUND');
});
test('only explicit unbound onboarding bypasses room membership', () => {
  for (const action of policy.UNBOUND_ACTIONS)
    assert.equal(policy.authorize({ rooms: [] }, source, { action }).ok, true);
  assert.equal(policy.authorize({ rooms: [] }, source, { action: 'targets' }).code,
    'DEX_ROOM_NOT_BOUND');
});
test('multiple exact rooms may be discovered but scoped operations must identify one', () => {
  const state = snapshot();
  state.rooms.push({ id: 'another', name: 'Another',
    members: [{ id: 'eve-other', binding: { ...source } }] });
  assert.equal(policy.authorize(state, source, { action: 'rooms' }).scope,
    'multiple-exact-rooms');
  assert.equal(policy.authorize(state, source,
    { action: 'room_budget', room: 'another' }).roomId, 'another');
});
test('ambiguous member binding in one room never authorizes a command', () => {
  const state = snapshot();
  state.rooms[0].members.push({ id: 'shadow', binding: { ...source } });
  assert.equal(policy.authorize(state, source, { action: 'send',
    room: 'room-eve' }).code, 'DEX_ROOM_NOT_BOUND');
  assert.equal(members.exactBinding(source, staleChat), false);
});
test('missing state and incomplete identity fail closed', () => {
  assert.equal(policy.authorize(null, source, { action: 'send' }).code,
    'DEX_ENTRY_STATE_UNAVAILABLE');
  assert.equal(policy.authorize({ rooms: [] }, {}, { action: 'help' }).code,
    'DEX_CONTROL_BAD_SOURCE');
});
