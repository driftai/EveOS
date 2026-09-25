'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderControlRouting } = require('../dex/provider-control-routing');

function socket(role, clientKind) {
  return { role, clientKind, sent: [] };
}
function resultFor(ws, requestId = null) {
  const results = ws.sent.filter((entry) => entry.type === 'provider_control_result');
  return requestId ? results.find((entry) => entry.requestId === requestId) : results.at(-1);
}
async function waitUntil(predicate, attempts = 25) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
}

test('late fresh-target completion after control timeout is closed instead of orphaned', async () => {
  const dex = socket('ui', 'dex');
  const caller = socket('provider-control-extension', null);
  const uiSockets = new Set([dex]);
  const safeSend = (ws, payload) => { ws.sent.push(payload); return true; };
  const source = {
    targetClassId: 'online-origin', targetId: 4, providerId: 'chatgpt',
    url: 'https://chatgpt.com/c/parent'
  };
  const state = {
    rooms: [{
      id: 'room-1', name: 'Worker Room', relay: { active: false, waitingFor: null },
      members: [{ id: 'parent', binding: { ...source } }]
    }]
  };
  const timers = [];
  let resolveSpawn;
  const spawned = new Promise((resolve) => { resolveSpawn = resolve; });
  const closed = [];
  const routing = createProviderControlRouting({
    uiSockets, safeSend, validateSource: async () => true, getState: () => state,
    spawnTarget: () => spawned,
    closeTarget: async (input) => { closed.push(input); return { ok: true }; },
    setTimer(fn) { timers.push(fn); return timers.length; },
    clearTimer() {}
  });

  const run = routing.handle(caller, {
    type: 'provider_control_request', requestId: 'spawn-late', source,
    command: { action: 'spawn_agent', room: 'room-1', providerId: 'muse' }
  });
  assert.equal(await waitUntil(() => timers.length > 0), true);
  timers[0]();
  resolveSpawn({ id: 77, providerId: 'muse', providerName: 'Muse', url: 'https://muse.ai/thread/new' });
  await run;

  assert.equal(resultFor(caller).result.code, 'DEX_CONTROL_OUTCOME_UNKNOWN');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].targetId, 77);
  assert.match(closed[0].requestId, /late-cleanup/);
  assert.equal(dex.sent.length, 0);
});

test('timed-out mutating provider-control reports unknown commit state instead of retryable failure', async () => {
  const dex = socket('ui', 'dex');
  const sourceSocket = socket('provider-control-extension', null);
  const uiSockets = new Set([dex]);
  const timers = [];
  const safeSend = (ws, payload) => { ws.sent.push(payload); return true; };
  const routing = createProviderControlRouting({
    uiSockets,
    safeSend,
    validateSource: async () => true,
    setTimer(fn) { timers.push(fn); return timers.length; },
    clearTimer() {}
  });

  await routing.handle(sourceSocket, {
    type: 'provider_control_request',
    requestId: 'mut-timeout',
    source: {
      targetClassId: 'online-origin',
      targetId: 4,
      providerId: 'chatgpt',
      url: 'https://chatgpt.com/c/stress'
    },
    command: { action: 'handoff_room', room: 'Stress Room', text: 'Maybe committed.' }
  });

  assert.equal(dex.sent.length, 1);
  timers[0]();
  const result = resultFor(sourceSocket).result;
  assert.equal(result.code, 'DEX_CONTROL_OUTCOME_UNKNOWN');
  assert.deepEqual(result.data, { commitState: 'unknown', commitId: null });
  assert.match(result.message, /inspect room status before retrying/i);
});


