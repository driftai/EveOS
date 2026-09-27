'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const identity = require('../public/dex-members');
const ui = require('../public/dex-provider-control');
const mailbox = require('../dex/recovery-mailbox');
const origin = require('../dex/provider-control-receipt');
const server = require('../dex/room-tools');
const direct = require('../dex/provider-control-direct-send');
const eve = { targetClassId: 'online-origin', providerId: 'chatgpt',
  targetId: 116814673, url: 'https://chatgpt.com/c/eve-room' };
const staleTab = { ...eve, targetId: 116814674 };
const staleChat = { ...eve, url: 'https://chatgpt.com/c/another-conversation' };
const unrelated = { ...eve, targetId: 116815000, url: 'https://chatgpt.com/c/unrelated' };
const astro = { targetClassId: 'local-origin', providerId: 'local-antigravity-existing',
  targetId: 'local:antigravity-existing:25032' };
function state() {
  return { version: 1, activeRoomId: 'room-one', rooms: [{
    id: 'room-one', name: 'Eve + Astro', settings: { maxTurns: 8 },
    relay: { active: false }, messages: [], members: [
      { id: 'eve', name: 'Eve', relayEnabled: true, binding: eve },
      { id: 'astro', name: 'Astro', relayEnabled: true, binding: astro }
    ] }] };
}
function controller(snapshot) {
  return ui.createController({ state: snapshot, storage: {
    getItem: () => null, setItem: () => {}
  }, roomMessage() { throw Error('Must not write during stale binding.'); },
  startRelay() { throw Error('Must not run relay.'); }, persist() {}, renderAll() {} });
}
test('one shared entry check requires both known chat URL and exact tab for online agents', () => {
  assert.equal(identity.exactBinding(eve, eve), true);
  assert.equal(identity.exactBinding(eve, staleTab), false);
  assert.equal(identity.exactBinding(eve, staleChat), false);
  assert.equal(identity.exactBinding(eve, unrelated), false);
  assert.equal(identity.staleBinding(eve, staleTab), true);
  assert.equal(identity.staleBinding(eve, staleChat), true);
  assert.equal(identity.staleBinding(eve, unrelated), false);
  assert.equal(identity.exactBinding(astro, astro), true);
  assert.equal(identity.exactBinding(astro, { ...astro, targetId: 'local:antigravity-existing:9' }), false);
  assert.equal(ui.bindingMatchesSource(eve, staleTab), false);
  assert.equal(origin.bindingMatchesSource(eve, staleChat), false);
  assert.equal(mailbox.matchingMember(state().rooms[0], staleTab), null);
  assert.equal(mailbox.matchingMember(state().rooms[0], staleChat), null);
});
test('browser entry checks agree for discovery, read-only and state-changing commands', () => {
  for (const source of [staleTab, staleChat]) {
    const c = controller(state());
    for (const action of ['rooms', 'targets', 'status', 'use_room', 'send',
      'checkpoint', 'set_self_relay', 'continue_relay', 'rename_room']) {
      const result = c.handle({ source, command: { action, room: 'room-one',
        text: 'Never enqueue this test', enabled: false } });
      assert.equal(result.ok, false, action);
      assert.equal(result.code, 'DEX_CONTROL_STALE_BINDING', action);
    }
  }
  assert.deepEqual(ui.authorizedRooms(state().rooms, eve).map(r => r.id), ['room-one']);
});
test('server read-only and direct SEND refuse identical stale sources and explain rebind', () => {
  for (const source of [staleTab, staleChat]) {
    const snapshot = state();
    for (const action of ['room_budget', 'room_log', 'tool_result_status']) {
      const result = server.execute(snapshot, { source,
        command: { action, room: 'room-one' } });
      assert.equal(result.changed, false);
      assert.equal(result.result.code, 'DEX_ROOM_STALE_BINDING', action);
    }
    const received = [];
    direct.route({ source, command: { action: 'send', room: 'room-one',
      relay: true, text: 'Never send' }, requestId: 'control-stale-1', ws: {} }, {
      getState: () => snapshot, saveState() { throw Error('No storage mutation allowed.'); },
      broadcastState() { throw Error('Never broadcast'); }, getScheduler: () => null,
      now: () => 1000, findOrigin: () => null,
      commitOriginReceipt: () => null, sendResult: (_, value) => received.push(value)
    });
    assert.equal(received.length, 1);
    assert.equal(received[0].code, 'DEX_ROOM_STALE_BINDING');
    assert.equal(snapshot.rooms[0].messages.length, 0);
    assert.equal(snapshot.rooms[0].deferredRelays, undefined);
  }
});
test('an unrelated provider cannot enumerate another room through mismatch diagnostics', () => {
  assert.equal(identity.staleRoomCount(state().rooms, unrelated), 0);
  assert.equal(controller(state()).handle({ source: unrelated,
    command: { action: 'status', room: 'room-one' } }).code, 'DEX_CONTROL_NOT_BOUND');
  assert.equal(server.execute(state(), { source: unrelated,
    command: { action: 'room_budget', room: 'room-one' } }).result.code, 'DEX_ROOM_NOT_BOUND');
});
test('duplicate exact member ownership fails closed rather than selecting the first match', () => {
  const snapshot = state();
  snapshot.rooms[0].members.push({ id: 'shadow', name: 'Shadow', binding: { ...eve } });
  assert.equal(mailbox.matchingMember(snapshot.rooms[0], eve), null);
  assert.equal(mailbox.eligibleRoom(snapshot, eve, 'room-one'), null);
});
test('origin receipts cannot authorize by only old tab ID or matching URL', () => {
  const snapshot = state();
  snapshot.rooms[0].pendingProviderControlReceipt = {
    commandKey: origin.commandKey({ action: 'status' }),
    executorMemberId: 'eve', action: 'status', agentMessageId: 'msg-one' };
  assert.equal(origin.findIntent(snapshot, staleTab, { action: 'status' }), null);
  assert.equal(origin.findIntent(snapshot, staleChat, { action: 'status' }), null);
  assert.equal(origin.findIntent(snapshot, eve, { action: 'status' }).roomId, 'room-one');
});
