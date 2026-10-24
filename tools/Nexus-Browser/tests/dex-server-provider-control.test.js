'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderControlRouting } = require('../dex/provider-control-routing');
const { socket, resultFor, entryFixture, rememberOrigin } = require('./helpers/dex-provider-control-fixture');

test('production state owner handles room controls without waking a Dex viewer', async () => {
  const source = { targetClassId: 'local-origin', targetId: 'local:antigravity-existing:86660',
    providerId: 'local-antigravity-existing' };
  let state = entryFixture(), saves = 0, wakes = 0;
  const caller = socket('ui', 'provider-control');
  const routing = createProviderControlRouting({
    uiSockets: new Set(),
    safeSend(ws, payload) { ws.sent.push(payload); return true; },
    validateSource: async () => true,
    getState: () => structuredClone(state),
    saveState(next) { state = structuredClone(next); saves += 1; return structuredClone(state); },
    broadcastState() {},
    ensureDexClient: async () => { wakes += 1; }
  });
  await routing.handle(caller, { type: 'provider_control_request', requestId: 'server-status',
    source, command: { action: 'status', room: 'room-1' } });
  assert.equal(resultFor(caller, 'server-status').result.ok, true);
  await routing.handle(caller, { type: 'provider_control_request', requestId: 'server-rename',
    source, command: { action: 'rename_room', room: 'room-1', name: 'Server Owned' } });
  assert.equal(resultFor(caller, 'server-rename').result.ok, true);
  assert.equal(state.rooms[0].name, 'Server Owned');
  assert.ok(saves >= 1);
  assert.equal(wakes, 0);
});

test('server-owned managed worker creation commits without a Dex viewer', async () => {
  const source = { targetClassId: 'online-origin', targetId: 4, providerId: 'chatgpt',
    url: 'https://chatgpt.com/c/stress' };
  const command = { action: 'spawn_agent', room: 'room-1', providerId: 'muse', name: 'Worker' };
  let state = entryFixture(), spawns = 0;
  rememberOrigin(state, source, command);
  const caller = socket('provider-control-extension', null);
  const routing = createProviderControlRouting({
    uiSockets: new Set(),
    safeSend(ws, payload) { ws.sent.push(payload); return true; },
    validateSource: async () => true,
    getState: () => structuredClone(state),
    saveState(next) { state = structuredClone(next); return structuredClone(state); },
    broadcastState() {},
    async spawnTarget() { spawns += 1; return { id: 88, providerId: 'muse', providerName: 'Muse',
      url: 'https://muse.ai/thread/worker' }; }
  });
  await routing.handle(caller, { type: 'provider_control_request', requestId: 'server-spawn', source, command });
  assert.equal(resultFor(caller, 'server-spawn').result.ok, true);
  assert.equal(spawns, 1);
  assert.equal(state.rooms[0].members.some((member) => member.binding?.targetId === 88
    && member.binding?.managedByDex === true), true);
});
