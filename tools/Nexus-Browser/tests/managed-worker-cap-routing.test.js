const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderControlRouting } = require('../dex/provider-control-routing.js');
const controlReceipt = require('../dex/provider-control-receipt');

function socket(role, clientKind) {
  return { role, clientKind, sent: [] };
}

async function waitUntil(predicate, attempts = 25) {
  for (let index = 0; index < attempts; index += 1) { if (predicate()) return true; await new Promise((resolve) => setImmediate(resolve)); }
  return false;
}

function managed(index) {
  return {
    id: `managed-${index}`,
    name: `Worker ${index}`,
    binding: {
      targetClassId: 'online-origin',
      targetId: 100 + index,
      providerId: 'muse',
      managedByDex: true
    }
  };
}

test('in-flight spawns consume the managed worker cap before another tab is created', async () => {
  const dex = socket('ui', 'dex');
  const caller = socket('provider-control-extension', null);
  const uiSockets = new Set([dex]);
  const source = {
    targetClassId: 'online-origin',
    targetId: 4,
    providerId: 'chatgpt',
    url: 'https://chatgpt.com/c/parent'
  };
  const otherSource = { ...source, targetId: 5, url: 'https://chatgpt.com/c/other-parent' };
  const state = {
    rooms: [{
      id: 'room-1',
      name: 'Worker Room',
      relay: { active: false, waitingFor: null },
      members: [{ id: 'parent', binding: { ...source } }, managed(1), managed(2), managed(3)],
      messages: [{ id: 'source-fourth', senderKind: 'user', text: 'Spawn the fourth worker.' },
        { id: 'agent-fourth', senderKind: 'agent', senderId: 'parent', text: 'Spawning the fourth worker.' }]
    }, {
      id: 'room-2', name: 'Other Worker Room', relay: { active: false, waitingFor: null },
      members: [{ id: 'other-parent', binding: { ...otherSource } }],
      messages: [{ id: 'source-fifth', senderKind: 'user', text: 'Spawn another worker.' },
        { id: 'agent-fifth', senderKind: 'agent', senderId: 'other-parent', text: 'Spawning another worker.' }]
    }]
  };
  const firstCommand = { action: 'spawn_agent', room: 'room-1', providerId: 'muse', name: 'Fourth Worker' };
  const secondCommand = { action: 'spawn_agent', room: 'room-2', providerId: 'muse', name: 'Fifth Worker' };
  // Independent exact origins exercise the global cap without replacing an in-flight room receipt.
  state.rooms.forEach((room, index) => controlReceipt.rememberIntent(room, {
    executorMember: room.members[0], sourceMessage: room.messages[0],
    command: index ? secondCommand : firstCommand, agentMessage: room.messages[1],
    turnRequestId: `turn-spawn-cap-${index}`
  }));
  const safeSend = (ws, payload) => { ws.sent.push(payload); return true; };
  let resolveFirst;
  const firstSpawn = new Promise((resolve) => { resolveFirst = resolve; });
  let spawnCalls = 0;
  const routing = createProviderControlRouting({
    uiSockets,
    safeSend,
    validateSource: async () => true,
    getState: () => state,
    spawnTarget() {
      spawnCalls += 1;
      if (spawnCalls === 1) return firstSpawn;
      throw new Error('second spawn must be rejected before tab creation');
    }
  });

  const first = routing.handle(caller, {
    type: 'provider_control_request',
    requestId: 'spawn-cap-a',
    source,
    command: firstCommand
  });
  assert.equal(await waitUntil(() => spawnCalls === 1), true);
  assert.equal(spawnCalls, 1);

  await routing.handle(caller, {
    type: 'provider_control_request',
    requestId: 'spawn-cap-b',
    source: otherSource,
    command: secondCommand
  });
  assert.equal(spawnCalls, 1);
  const rejected = caller.sent.find((entry) => entry.type === 'provider_control_result' && entry.requestId === 'spawn-cap-b');
  assert.equal(rejected.result.code, 'DEX_CONTROL_SPAWN_LIMIT');
  assert.match(rejected.result.message, /3 managed browser worker\(s\) and 1 spawn\(s\) in flight/);

  resolveFirst({ id: 200, providerId: 'muse', providerName: 'Muse', url: 'https://muse.ai/thread/new' });
  await first;
  assert.equal(dex.sent.length, 1);
  await routing.handle(dex, {
    type: 'provider_control_result',
    requestId: 'spawn-cap-a',
    source,
    result: { ok: true, action: 'spawn_agent' }
  });
});
