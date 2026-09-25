'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAgentExtensionReload } = require('../dex/agent-extension-reload');
const watcher = require('../extension/content/dex-provider-control.js');
const revision = require('../extension/content/provider-adapter-revision.js');
const { MUTATING_ACTIONS: SERVER_ACTIONS } = require('../dex/provider-control-routing');
const { MUTATING_ACTIONS: BROWSER_ACTIONS, ACTIONS } = require('../public/dex-provider-control');
const BOUND = { targetClassId: 'online-origin', providerId: 'chatgpt', targetId: 42, url: 'https://chatgpt.com/c/eve' };
function harness(options = {}) {
  const main = { name: 'old-main' }, next = { name: 'new-main' }, bridge = { name: 'new-control' };
  const room = { id: 'room-eve-astro', relay: { active: false }, members: [{ id: 'eve', binding: { ...BOUND } }] };
  const other = { id: 'room-other', relay: { active: false }, members: [] };
  const state = { rooms: [room, other] };
  let extension = { socket: main, epoch: 4, ready: true, sessionCount: 1, targets: [{ id: 42, providerId: 'chatgpt', url: BOUND.url }] };
  const sent = [], incidents = []; let step = 0, reload;
  const api = createAgentExtensionReload({
    getState: () => state, getExtension: () => extension,
    hasPending: () => !!options.pending,
    safeSend: (socket, message) => { sent.push({ socket, message }); return options.sendFails !== true; },
    recordIncident: (event) => incidents.push(event),
    now: () => step * 100,
    sleep: async () => {
      step += 1;
      if (options.noReconnect) return;
      if (step === 1 && !options.noAck) reload.observeExtension({ type: 'reloading_extension', requestId: 'ctl-1' }, main);
      if (step === 2) extension = { ...extension, ready: false };
      if (step === 3) {
        extension = { socket: next, epoch: 5, ready: true, sessionCount: 1, targets: extension.targets };
        reload.providerControlConnected(bridge);
      }
    }, timeoutMs: 600
  });
  reload = api;
  return { api, main, next, bridge, state, room, other, sent, incidents, getExtension: () => extension,
    request: { source: BOUND, command: { action: 'reload_extension', room: room.id }, requestId: 'ctl-1', transportRole: 'provider-control-extension' } };
}
test('reload_extension matches the server/browser action registry', () => {
  assert.equal(ACTIONS.has('reload_extension'), true);
  assert.deepEqual([...SERVER_ACTIONS].sort(), [...BROWSER_ACTIONS].sort());
});
test('exact bound chat gets confirmed result only after ACK, fresh epoch and new control bridge', async () => {
  const h = harness();
  const outcome = await h.api.run(h.request);
  assert.equal(outcome.result.ok, true);
  assert.equal(outcome.result.data.connectionEpoch, 5);
  assert.equal(outcome.socket, h.bridge);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.requestId, 'ctl-1');
  assert.equal(h.api.diagnostics().last.ok, true);
});
test('local CLI, unbound tabs and missing room are denied before reload dispatch', async () => {
  const h = harness();
  const local = await h.api.run({ ...h.request, source: { ...BOUND, targetClassId: 'local-origin' }, transportRole: 'provider-control' });
  assert.equal(local.result.code, 'DEX_RELOAD_ONLINE_REQUIRED');
  const unbound = await h.api.run({ ...h.request, source: { ...BOUND, targetId: 777 } });
  assert.equal(unbound.result.code, 'DEX_RELOAD_NOT_BOUND');
  const otherRoom = await h.api.run({ ...h.request, command: { action: 'reload_extension', room: 'room-other' } });
  assert.equal(otherRoom.result.code, 'DEX_RELOAD_NOT_BOUND');
  const missing = await h.api.run({ ...h.request, command: { action: 'reload_extension' } });
  assert.equal(missing.result.code, 'DEX_RELOAD_ROOM_REQUIRED');
  assert.equal(h.sent.length, 0);
});
test('busy rooms and concurrent control operations fail closed, even outside requested room', async () => {
  const h = harness();
  h.other.relay.active = true;
  assert.equal((await h.api.run(h.request)).result.code, 'DEX_RELOAD_BUSY');
  const h2 = harness({ pending: true });
  assert.equal((await h2.api.run(h2.request)).result.code, 'DEX_RELOAD_BUSY');
});
test('unadvertised browser targets cannot reload', async () => {
  const h = harness();
  const result = await h.api.run({ ...h.request, source: { ...BOUND, url: 'https://chatgpt.com/c/other' } });
  assert.equal(result.result.code, 'DEX_RELOAD_NOT_BOUND');
  assert.equal(h.sent.length, 0);
});
test('missing ACK never creates false success even if the extension reconnects', async () => {
  const h = harness({ noAck: true });
  const outcome = await h.api.run(h.request);
  assert.equal(outcome.result.code, 'DEX_RELOAD_OUTCOME_UNKNOWN');
  assert.equal(outcome.result.data.observedEpoch, 5);
  assert.equal(h.incidents.length, 1);
});
test('duplicate retry after successful reload is suppressed', async () => {
  const h = harness();
  assert.equal((await h.api.run(h.request)).result.ok, true);
  const second = await h.api.run({ ...h.request, requestId: 'ctl-2' });
  assert.equal(second.result.data.deduplicated, true);
  assert.equal(h.sent.length, 1);
});
test('server wiring routes reload ACK and uses new control socket for verified completion', () => {
  const root = path.resolve(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const worker = fs.readFileSync(path.join(root, 'extension/service-worker.js'), 'utf8');
  assert.match(server, /providerControlRouting\.providerControlConnected\(ws\)/);
  assert.match(server, /providerControlRouting\.observeExtension\(msg, ws\)/);
  assert.match(server, /getExtension: \(\) =>/);
  assert.match(worker, /reloading_extension', requestId: msg\.requestId/);
});

test('headed content watcher recognizes the new trailing reload marker at revision 34', () => {
  const parsed = watcher.parseTrailingCommand('Ready.\n[[DEX:CMD {"action":"reload_extension","room":"room-eve-astro"}]]');
  assert.equal(parsed?.command?.action, 'reload_extension');
  assert.equal(parsed.command.room, 'room-eve-astro');
  assert.equal(watcher.parseTrailingCommand('[[DEX:CMD {"action":"reload_extension","room":"room-eve-astro"}]]\nmore prose'), null);
  assert.equal(revision.ADAPTER_REVISION, 34);
});
