const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderControlRouting, MUTATING_ACTIONS: SERVER_MUTATING_ACTIONS } = require('../dex/provider-control-routing');
const browserControl = require('../public/dex-provider-control.js');
const controlReceipt = require('../dex/provider-control-receipt');
function socket(role, clientKind) {
  return { role, clientKind, sent: [] };
}
function resultFor(ws, requestId = null) {
  const results = ws.sent.filter((entry) => entry.type === 'provider_control_result');
  return requestId ? results.find((entry) => entry.requestId === requestId) : results.at(-1);
}
function admissionFor(ws, requestId = null) {
  const receipts = ws.sent.filter((entry) => entry.type === 'provider_control_received');
  return requestId ? receipts.find((entry) => entry.requestId === requestId) : receipts.at(-1);
}
function harness(validateSource = async () => true, overrides = {}) {
  const dex = socket('ui', 'dex');
  const uiSockets = new Set([dex]);
  const safeSend = (ws, payload) => { ws.sent.push(payload); return true; };
  const routing = createProviderControlRouting({ uiSockets, safeSend, validateSource, ...overrides });
  return { dex, uiSockets, safeSend, routing };
}
async function waitUntil(predicate, attempts = 25) {
  for (let index = 0; index < attempts; index += 1) { if (predicate()) return true; await new Promise((resolve) => setImmediate(resolve)); }
  return false;
}
test('browser and localhost agree on which provider-control actions mutate durable Dex state', () => {
  assert.deepEqual([...browserControl.MUTATING_ACTIONS].sort(), [...SERVER_MUTATING_ACTIONS].sort());
});
test('provider-control extension request routes to Dex UI and result returns only to origin', async () => {
  const { dex, routing } = harness();
  const extension = socket('provider-control-extension', null);
  const request = {
    type: 'provider_control_request',
    requestId: 'ctl-1',
    source: { targetClassId: 'online-origin', targetId: 4, providerId: 'chatgpt' },
    command: { action: 'rooms' }
  };
  assert.equal(await routing.handle(extension, request), true);
  assert.equal(admissionFor(extension, 'ctl-1')?.requestId, 'ctl-1');
  assert.equal(dex.sent.length, 1);
  assert.equal(dex.sent[0].requestId, 'ctl-1');

  const result = { type: 'provider_control_result', requestId: 'ctl-1', source: request.source, result: { ok: true } };
  assert.equal(await routing.handle(dex, result), true);
  assert.equal(extension.sent.length, 2);
  assert.deepEqual(resultFor(extension, 'ctl-1').result, { ok: true });
});

test('provider-control local client is rejected when source validation fails', async () => {
  const { routing } = harness(async () => false);
  const local = socket('ui', 'provider-control');
  const handled = await routing.handle(local, {
    type: 'provider_control_request',
    requestId: 'ctl-bad',
    source: { targetClassId: 'local-origin', targetId: 'fake', providerId: 'local-antigravity-existing' },
    command: { action: 'rooms' }
  });
  assert.equal(handled, true);
  assert.equal(resultFor(local).result.code, 'DEX_CONTROL_BAD_SOURCE');
});

test('provider-control request reports Dex UI offline instead of disappearing', async () => {
  const uiSockets = new Set();
  const local = socket('ui', 'provider-control');
  const safeSend = (ws, payload) => { ws.sent.push(payload); return true; };
  const routing = createProviderControlRouting({ uiSockets, safeSend, validateSource: async () => true });
  assert.equal(await routing.handle(local, {
    type: 'provider_control_request',
    requestId: 'ctl-offline',
    source: { targetClassId: 'local-origin', targetId: 'local:antigravity-existing:86660', providerId: 'local-antigravity-existing' },
    command: { action: 'status' }
  }), true);
  assert.equal(resultFor(local).result.code, 'DEX_UI_OFFLINE');
});


test('provider-control wakes a headed Dex client before declaring the UI offline', async () => {
  const uiSockets = new Set();
  const local = socket('ui', 'provider-control');
  const safeSend = (ws, payload) => { ws.sent.push(payload); return true; };
  let ensureCalls = 0;
  const routing = createProviderControlRouting({
    uiSockets,
    safeSend,
    validateSource: async () => true,
    ensureDexClient: async () => {
      ensureCalls += 1;
      uiSockets.add(socket('ui', 'dex'));
    }
  });
  assert.equal(await routing.handle(local, {
    type: 'provider_control_request',
    requestId: 'ctl-wake',
    source: { targetClassId: 'local-origin', targetId: 'local:antigravity-existing:86660', providerId: 'local-antigravity-existing' },
    command: { action: 'status' }
  }), true);
  assert.equal(ensureCalls, 1);
  const dex = [...uiSockets].find((entry) => entry.clientKind === 'dex');
  assert.equal(dex.sent[0].requestId, 'ctl-wake');
  await routing.handle(dex, { type: 'provider_control_result', requestId: 'ctl-wake', source: dex.sent[0].source, result: { ok: true, action: 'status' } });
  assert.equal(resultFor(local).result.ok, true);
});

test('duplicate mutating provider-control requests coalesce and replay the committed result', async () => {
  const { dex, routing } = harness();
  const first = socket('provider-control-extension', null);
  const second = socket('provider-control-extension', null);
  const source = {
    targetClassId: 'online-origin',
    targetId: 4,
    providerId: 'chatgpt',
    url: 'https://chatgpt.com/c/stress'
  };
  const command = { action: 'handoff_room', room: 'Stress Room', text: 'Run Test D.', turns: 8 };

  assert.equal(await routing.handle(first, {
    type: 'provider_control_request', requestId: 'mut-1', source, command
  }), true);
  assert.equal(await routing.handle(second, {
    type: 'provider_control_request', requestId: 'mut-2', source, command
  }), true);
  assert.equal(dex.sent.length, 1);

  const result = {
    type: 'provider_control_result',
    requestId: 'mut-1',
    source,
    result: { ok: true, silent: true, action: 'handoff_room', data: { roomId: 'room-2', commitState: 'committed', commitId: 'msg-commit-1' } }
  };
  assert.equal(await routing.handle(dex, result), true);
  assert.equal(resultFor(first).result.ok, true);
  assert.equal(resultFor(second).result.ok, true);
  assert.equal(resultFor(second).result.data.commitState, 'committed');
  assert.equal(resultFor(second).result.data.commitId, 'msg-commit-1');

  const third = socket('provider-control-extension', null);
  assert.equal(await routing.handle(third, {
    type: 'provider_control_request', requestId: 'mut-3', source, command
  }), true);
  assert.equal(dex.sent.length, 1);
  assert.equal(resultFor(third).result.ok, true);
  assert.equal(resultFor(third).result.data.commitId, 'msg-commit-1');
});

test('spawn_agent creates one verified fresh target and routes only that target to Dex', async () => {
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
  let spawnCalls = 0;
  const { dex, routing } = harness(async () => true, {
    getState: () => state,
    async spawnTarget(input) {
      spawnCalls += 1;
      assert.equal(input.providerId, 'muse');
      return { id: 77, providerId: 'muse', providerName: 'Muse', url: 'https://muse.ai/thread/new' };
    }
  });
  const caller = socket('provider-control-extension', null);
  await routing.handle(caller, {
    type: 'provider_control_request',
    requestId: 'spawn-1',
    source,
    command: { action: 'spawn_agent', room: 'room-1', providerId: 'muse', name: 'Researcher' }
  });
  assert.equal(spawnCalls, 1);
  assert.equal(dex.sent.length, 1);
  assert.equal(dex.sent[0].command.room, 'room-1');
  assert.equal(dex.sent[0].command.targetId, 77);
  assert.equal(dex.sent[0].command.spawnedTarget.providerId, 'muse');

  await routing.handle(dex, {
    type: 'provider_control_result', requestId: 'spawn-1', source,
    result: { ok: true, action: 'spawn_agent', data: { addedMemberId: 'worker-1' } }
  });
  assert.equal(resultFor(caller).result.ok, true);
});

test('spawn_agent waits only for the exact caller current turn to settle idle', async () => {
  const source = {
    targetClassId: 'online-origin', targetId: 4, providerId: 'chatgpt',
    url: 'https://chatgpt.com/c/parent'
  };
  const state = {
    rooms: [{
      id: 'room-1', name: 'Worker Room',
      relay: { active: true, waitingFor: 'parent' },
      recovery: { memberId: 'parent', requestId: 'dex-turn-current' },
      members: [{ id: 'parent', name: 'Parent', binding: { ...source } }],
      messages: [{ id: 'source-msg', senderKind: 'user', senderId: 'user', senderName: 'Drift', text: 'Spawn a worker.' }, { id: 'parent-msg', senderKind: 'agent', senderId: 'parent', senderName: 'Parent', text: 'Spawning worker.' }]
    }]
  };
  let sleepCalls = 0;
  let spawnCalls = 0;
  const { dex, routing } = harness(async () => true, {
    getState: () => state,
    async sleep() {
      sleepCalls += 1;
      const room = state.rooms[0];
      room.relay.active = false;
      room.relay.waitingFor = null;
      delete room.recovery;
      controlReceipt.rememberIntent(room, { executorMember: room.members[0], sourceMessage: room.messages[0],
        command: { action: 'spawn_agent', room: 'room-1', providerId: 'muse' }, agentMessage: room.messages[1],
        turnRequestId: 'dex-turn-current', at: '2026-09-20T04:36:00.000Z' });
    },
    async spawnTarget() {
      spawnCalls += 1;
      return { id: 77, providerId: 'muse', providerName: 'Muse', url: 'https://muse.ai/thread/new' };
    }
  });
  const caller = socket('provider-control-extension', null);
  await routing.handle(caller, {
    type: 'provider_control_request', requestId: 'spawn-settle', source,
    command: { action: 'spawn_agent', room: 'room-1', providerId: 'muse' }
  });
  assert.equal(sleepCalls, 1);
  assert.equal(spawnCalls, 1);
  assert.equal(dex.sent[0].command.targetId, 77);
  await routing.handle(dex, {
    type: 'provider_control_result', requestId: 'spawn-settle', source,
    result: { ok: true, action: 'spawn_agent', data: { addedMemberId: 'worker-settle' } }
  });
  assert.equal(resultFor(caller).result.ok, true);
});

test('spawn_agent does not wait for a different participant busy turn', async () => {
  const source = {
    targetClassId: 'online-origin', targetId: 4, providerId: 'chatgpt',
    url: 'https://chatgpt.com/c/parent'
  };
  const state = {
    rooms: [{
      id: 'room-1', name: 'Worker Room',
      relay: { active: true, waitingFor: 'other' },
      recovery: { memberId: 'other', requestId: 'dex-turn-other' },
      members: [{ id: 'parent', binding: { ...source } }, { id: 'other', binding: { targetClassId: 'online-origin', targetId: 5, providerId: 'muse' } }]
    }]
  };
  let spawnCalls = 0;
  const { routing } = harness(async () => true, {
    getState: () => state,
    spawnTarget() { spawnCalls += 1; throw new Error('must not spawn'); }
  });
  const caller = socket('provider-control-extension', null);
  await routing.handle(caller, {
    type: 'provider_control_request', requestId: 'spawn-other-busy', source,
    command: { action: 'spawn_agent', room: 'room-1', providerId: 'muse' }
  });
  assert.equal(spawnCalls, 0);
  assert.equal(resultFor(caller).result.code, 'DEX_CONTROL_ROOM_BUSY');
});

test('duplicate spawn_agent requests coalesce before browser tab creation', async () => {
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
  let resolveSpawn;
  let spawnCalls = 0;
  const spawned = new Promise((resolve) => { resolveSpawn = resolve; });
  const { dex, routing } = harness(async () => true, {
    getState: () => state,
    spawnTarget() { spawnCalls += 1; return spawned; }
  });
  const first = socket('provider-control-extension', null);
  const second = socket('provider-control-extension', null);
  const command = { action: 'spawn_agent', room: 'room-1', providerId: 'muse', name: 'Researcher' };

  const firstRun = routing.handle(first, { type: 'provider_control_request', requestId: 'spawn-a', source, command });
  await Promise.resolve();
  await routing.handle(second, { type: 'provider_control_request', requestId: 'spawn-b', source, command });
  assert.equal(spawnCalls, 1);
  assert.equal(dex.sent.length, 0);

  resolveSpawn({ id: 77, providerId: 'muse', providerName: 'Muse', url: 'https://muse.ai/thread/new' });
  await firstRun;
  assert.equal(dex.sent.length, 1);
  await routing.handle(dex, {
    type: 'provider_control_result', requestId: 'spawn-a', source,
    result: { ok: true, action: 'spawn_agent', data: { addedMemberId: 'worker-1' } }
  });
  assert.equal(resultFor(first).result.ok, true);
  assert.equal(resultFor(second).result.ok, true);
});

test('managed browser spawning is rejected for Local-Origin callers', async () => {
  const state = { rooms: [] };
  const { routing } = harness(async () => true, { getState: () => state, spawnTarget() { throw new Error('must not spawn'); } });
  const local = socket('ui', 'provider-control');
  await routing.handle(local, {
    type: 'provider_control_request',
    requestId: 'spawn-local',
    source: { targetClassId: 'local-origin', targetId: 'local:x', providerId: 'local-antigravity-cli' },
    command: { action: 'spawn_agent', room: 'room-1', providerId: 'muse' }
  });
  assert.equal(resultFor(local).result.code, 'DEX_CONTROL_ONLINE_REQUIRED');
});

test('despawn_agent closes the exact managed browser target only after Dex removes it', async () => {
  const source = {
    targetClassId: 'online-origin', targetId: 4, providerId: 'chatgpt',
    url: 'https://chatgpt.com/c/parent'
  };
  const state = {
    rooms: [{
      id: 'room-1', name: 'Worker Room', relay: { active: false, waitingFor: null },
      members: [
        { id: 'parent', binding: { ...source } },
        { id: 'worker', name: 'Muse Worker', binding: { targetClassId: 'online-origin', targetId: 77, providerId: 'muse', url: 'https://muse.ai/thread/worker', managedByDex: true } }
      ]
    }]
  };
  const closed = [];
  const { dex, routing } = harness(async () => true, {
    getState: () => state,
    async closeTarget(input) { closed.push(input); return { ok: true, alreadyClosed: false }; }
  });
  const caller = socket('provider-control-extension', null);
  await routing.handle(caller, {
    type: 'provider_control_request', requestId: 'despawn-1', source,
    command: { action: 'despawn_agent', room: 'room-1', member: 'worker' }
  });
  assert.equal(closed.length, 0);
  assert.equal(dex.sent[0].command.member, 'worker');

  await routing.handle(dex, {
    type: 'provider_control_result', requestId: 'despawn-1', source,
    result: { ok: true, action: 'despawn_agent', data: { removedMemberId: 'worker' } }
  });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].targetId, 77);
  assert.equal(resultFor(caller).result.data.targetClosed, true);
});

test('mutating provider-control request survives origin socket loss for exact-once reconciliation', async () => {
  const { dex, routing } = harness();
  const first = socket('provider-control-extension', null);
  const source = {
    targetClassId: 'online-origin',
    targetId: 4,
    providerId: 'chatgpt',
    url: 'https://chatgpt.com/c/stress'
  };
  const command = { action: 'send', text: 'exact-once payload', relay: true };

  await routing.handle(first, {
    type: 'provider_control_request', requestId: 'mut-drop-1', source, command
  });
  routing.dropSocket(first);
  assert.equal(routing.pending.has('mut-drop-1'), true);

  await routing.handle(dex, {
    type: 'provider_control_result',
    requestId: 'mut-drop-1',
    source,
    result: { ok: true, silent: true, action: 'send' }
  });

  const retry = socket('provider-control-extension', null);
  await routing.handle(retry, {
    type: 'provider_control_request', requestId: 'mut-drop-2', source, command
  });
  assert.equal(dex.sent.length, 1);
  assert.equal(resultFor(retry).result.ok, true);
});

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

