const test = require('node:test');
const assert = require('node:assert/strict');
const control = require('../public/dex-provider-control.js');

const eveSource = {
  targetClassId: 'online-origin', targetId: 10, providerId: 'chatgpt',
  providerName: 'ChatGPT', url: 'https://chatgpt.com/c/room-one'
};
const unboundSource = {
  targetClassId: 'online-origin', targetId: 99, providerId: 'muse',
  providerName: 'Muse', url: 'https://muse.ai/not-bound'
};

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value)
  };
}

function fixture() {
  return {
    turn: null, queue: [],
    rooms: [{
      id: 'room-1', name: 'Core Room', userName: 'Drift',
      settings: { autoRelay: true, maxTurns: 8, contextMessages: 8 },
      relay: { active: false, waitingFor: null }, messages: [],
      members: [
        {
          id: 'eve', name: 'Eve', relayEnabled: true,
          binding: {
            targetClassId: 'online-origin', targetId: 10, providerId: 'chatgpt',
            providerName: 'ChatGPT', url: 'https://chatgpt.com/c/room-one'
          }
        },
        {
          id: 'astro', name: 'Astro', relayEnabled: true,
          binding: {
            targetClassId: 'local-origin', targetId: 'local:antigravity-existing:86660',
            providerId: 'local-antigravity-existing', providerName: 'Antigravity CLI'
          }
        }
      ]
    }]
  };
}

function controller(state, calls = []) {
  return control.createController({
    state, storage: memoryStorage(), roomMessage() {},
    startRelay(room, source, budget) { calls.push(['start', room.id, source.id, budget]); },
    stopRoom(room, reason) {
      calls.push(['stop', room.id, reason]);
      room.relay.active = false; room.relay.waitingFor = null;
    },
    persist() { calls.push(['persist']); },
    renderAll() { calls.push(['render']); }
  });
}

test('bound online agent can rename and configure its room', () => {
  const state = fixture();
  const ctl = controller(state);
  assert.equal(ctl.handle({
    source: eveSource, command: { action: 'rename_room', room: 'Core Room', name: 'Research Room' }
  }).ok, true);
  assert.equal(ctl.handle({
    source: eveSource,
    command: { action: 'configure_room', room: 'Research Room', maxTurns: 20, contextMessages: 10, autoRelay: false }
  }).ok, true);
  assert.equal(state.rooms[0].name, 'Research Room');
  assert.deepEqual(state.rooms[0].settings, { autoRelay: false, maxTurns: 20, contextMessages: 10, contextDefaultMessages: 10, budgetRevision: 1 });
});

test('bound online agent can rename, observe, and remove another participant', () => {
  const state = fixture();
  const ctl = controller(state);
  assert.equal(ctl.handle({
    source: eveSource, command: { action: 'set_agent_relay', member: 'astro', enabled: false }
  }).ok, true);
  assert.equal(state.rooms[0].members[1].relayEnabled, false);
  assert.equal(ctl.handle({
    source: eveSource, command: { action: 'rename_agent', member: 'astro', name: 'Local Observer' }
  }).ok, true);
  assert.equal(ctl.handle({
    source: eveSource, command: { action: 'remove_agent', member: 'astro' }
  }).ok, true);
  assert.deepEqual(state.rooms[0].members.map((member) => member.id), ['eve']);
});

test('status exposes stable member ids for room administration', () => {
  const state = fixture();
  const result = controller(state).handle({ source: eveSource, command: { action: 'status' } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.memberDetails.map((entry) => entry.memberId), ['eve', 'astro']);
});

test('unbound provider cannot administer another room', () => {
  const state = fixture();
  const result = controller(state).handle({
    source: unboundSource,
    command: { action: 'rename_room', room: 'Core Room', name: 'Hijacked' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DEX_CONTROL_NOT_BOUND');
  assert.equal(state.rooms[0].name, 'Core Room');
});

test('bound agent can stop and continue its relay', () => {
  const state = fixture();
  const calls = [];
  const ctl = controller(state, calls);
  state.rooms[0].messages = [{ id: 'm1', senderKind: 'agent', senderId: 'astro', senderName: 'Astro', text: 'continue' }];
  state.rooms[0].relay.active = true;
  assert.equal(ctl.handle({ source: eveSource, command: { action: 'stop_relay' } }).ok, true);
  assert.equal(ctl.handle({ source: eveSource, command: { action: 'continue_relay', turns: 999 } }).ok, true);
  assert.deepEqual(calls[0].slice(0, 2), ['stop', 'room-1']);
  assert.deepEqual(calls.at(-1), ['start', 'room-1', 'm1', 500]);
});


test('onboarding tells agents to delete disposable proof rooms after managed cleanup', () => {
  const state = fixture();
  const result = controller(state).handle({ source: eveSource, command: { action: 'onboard' } });
  assert.equal(result.ok, true);
  assert.ok(result.data.rules.some((rule) => /Disposable proof\/test rooms are temporary resources/.test(rule)));
  assert.ok(result.data.rules.some((rule) => /delete the room with delete_room/.test(rule)));
});
