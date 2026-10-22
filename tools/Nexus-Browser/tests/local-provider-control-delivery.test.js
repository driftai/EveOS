'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderControlRouting } = require('../dex/provider-control-routing');
const receipt = require('../dex/provider-control-receipt');

function intentFixture() {
  const source = { targetClassId: 'local-origin', targetId: 'local:tlo-chat:default', providerId: 'tlo-chat' };
  const command = { action: 'job_prepare', room: 'room-local', space: 'space-one', terminal: 'terminal-one', command: 'Write-Output safe' };
  const state = { rooms: [{ id: 'room-local', name: 'Local Engineering',
    members: [{ id: 'tlo', name: 'TLO', binding: { ...source } }],
    messages: [{ id: 'source-local', senderKind: 'user', senderId: 'user', text: 'Prepare it.' },
      { id: 'reply-local', senderKind: 'agent', senderId: 'tlo', text: 'Preparing.' }] }] };
  receipt.rememberIntent(state.rooms[0], { executorMember: state.rooms[0].members[0],
    sourceMessage: state.rooms[0].messages[0], command, agentMessage: state.rooms[0].messages[1],
    turnRequestId: 'turn-local-one', at: '2026-10-19T20:00:00.000Z' });
  return { source, command, state };
}

test('durable local provider intent enters the existing router once without a browser extension', async () => {
  const { source, command, state } = intentFixture();
  let routes = 0;
  const routing = createProviderControlRouting({ uiSockets: new Set(), safeSend: () => false,
    validateSource: async (candidate) => candidate.targetId === source.targetId,
    getState: () => structuredClone(state), saveState: (next) => Object.assign(state, structuredClone(next)),
    machineCommandRouter: { owns: (action) => action === 'job_prepare', route(input, helpers) {
      routes += 1; assert.equal(input.origin.roomId, 'room-local'); assert.deepEqual(input.command, command);
      helpers.commitOriginReceipt(input.origin, { ok: true, action: 'job_prepare', message: 'Prepared safely.' }, input.requestId);
      return true;
    } } });
  assert.deepEqual(await routing.flushLocalIntents(), { dispatched: 1, waiting: 0, candidates: 1 });
  assert.equal(routes, 1); assert.equal(state.rooms[0].pendingProviderControlReceipt, undefined);
  assert.match(state.rooms[0].messages.at(-1).text, /Prepared safely/);
  assert.deepEqual(await routing.flushLocalIntents(), { dispatched: 0, waiting: 0, candidates: 0 });
});

test('dispatcher skips online origins and coalesces concurrent local flushes', async () => {
  const { command, state } = intentFixture();
  state.rooms.push({ id: 'online', pendingProviderControlReceipt: { action: 'job_prepare', command,
    commandKey: receipt.commandKey(command), agentMessageId: 'online-reply',
    executorTarget: { targetClassId: 'online-origin', targetId: 4, providerId: 'chatgpt' } } });
  let release, validations = 0;
  const routing = createProviderControlRouting({ uiSockets: new Set(), safeSend: () => false,
    validateSource: async () => { validations += 1; await new Promise((resolve) => { release = resolve; }); return false; },
    getState: () => structuredClone(state) });
  const first = routing.flushLocalIntents(); await new Promise((resolve) => setImmediate(resolve));
  const second = await routing.flushLocalIntents();
  assert.equal(second.waiting, 1); assert.equal(validations, 1); release(); await first;
});

function roomWithIntent(id, source, command, turn) {
  const room = { id, name: id, members: [{ id: `tlo-${id}`, name: 'TLO', binding: { ...source } }],
    messages: [{ id: `source-${id}`, senderKind: 'user', senderId: 'user', text: 'Continue.' },
      { id: `reply-${id}`, senderKind: 'agent', senderId: `tlo-${id}`, text: 'Working.' }] };
  receipt.rememberIntent(room, { executorMember: room.members[0], sourceMessage: room.messages[0],
    command, agentMessage: room.messages[1], turnRequestId: turn, at: '2026-10-22T12:00:00.000Z' });
  return room;
}

function routedHarness(state, source) {
  const dex = { clientKind: 'dex' }, outbound = [];
  const routing = createProviderControlRouting({ uiSockets: new Set([dex]), getDexClient: () => dex,
    safeSend(ws, payload) { if (ws === dex) outbound.push(payload); return true; },
    validateSource: async (candidate) => candidate.targetId === source.targetId,
    getState: () => structuredClone(state), saveState: (next) => Object.assign(state, structuredClone(next)),
    broadcastState() {} });
  return { dex, outbound, routing };
}

test('multi-room TLO onboarding is scoped to the durable origin and receipts never leak', async () => {
  const source = { targetClassId: 'local-origin', targetId: 'local:tlo-chat:shared', providerId: 'tlo-chat' };
  const command = { action: 'onboard' };
  const state = { rooms: [roomWithIntent('room-a', source, command, 'turn-a'),
    { id: 'room-b', name: 'room-b', members: [{ id: 'tlo-room-b', name: 'TLO', binding: { ...source } }], messages: [] }] };
  const h = routedHarness(state, source);
  await h.routing.flushLocalIntents();
  const request = h.outbound.find((item) => item.type === 'provider_control_request');
  assert.equal(request.command.room, 'room-a');
  await h.routing.handle(h.dex, { type: 'provider_control_result', requestId: request.requestId,
    result: { ok: true, action: 'onboard', message: 'Room A onboarded.' } });
  assert.match(state.rooms[0].messages.at(-1).text, /Room A onboarded/);
  assert.equal(state.rooms[1].messages.length, 0);
  assert.equal(state.rooms[0].localToolResults.at(-1).requestId, request.requestId,
    'the committed result remains inspectable after the controller transport closes');
  h.routing.dropSocket(h.dex);
  assert.equal(state.rooms[0].localToolResults.at(-1).state, 'queued');
});

test('forged cross-room command is rejected against its durable origin', async () => {
  const source = { targetClassId: 'local-origin', targetId: 'local:tlo-chat:shared', providerId: 'tlo-chat' };
  const command = { action: 'onboard', room: 'room-b' };
  const state = { rooms: [roomWithIntent('room-a', source, command, 'turn-a'),
    { id: 'room-b', name: 'room-b', members: [{ id: 'tlo-room-b', name: 'TLO', binding: { ...source } }], messages: [] }] };
  const h = routedHarness(state, source);
  await h.routing.flushLocalIntents();
  assert.equal(h.outbound.some((item) => item.type === 'provider_control_request'), false);
  assert.match(state.rooms[0].messages.at(-1).text, /DEX_CONTROL_ORIGIN_UNCORRELATED/);
  assert.equal(state.rooms[1].messages.length, 0);
});

test('stale local binding cannot use retained room provenance', async () => {
  const current = { targetClassId: 'local-origin', targetId: 'local:tlo-chat:current', providerId: 'tlo-chat' };
  const stale = { ...current, targetId: 'local:tlo-chat:stale' };
  const command = { action: 'onboard' };
  const state = { rooms: [roomWithIntent('room-a', current, command, 'turn-a')] };
  state.rooms[0].pendingProviderControlReceipt.executorTarget = stale;
  const h = routedHarness(state, stale);
  await h.routing.flushLocalIntents();
  assert.equal(h.outbound.some((item) => item.type === 'provider_control_request'), false);
  assert.ok(state.rooms[0].pendingProviderControlReceipt,
    'uncorrelated stale provenance remains unresolved rather than being falsely acknowledged');
});

test('authenticated local provenance scopes room-tool mutations to their origin', async () => {
  const source = { targetClassId: 'local-origin', targetId: 'local:tlo-chat:shared', providerId: 'tlo-chat' };
  const command = { action: 'set_room_budget', turns: 7 };
  const state = { rooms: [roomWithIntent('room-a', source, command, 'turn-a'),
    { id: 'room-b', name: 'room-b', members: [{ id: 'tlo-room-b', name: 'TLO', binding: { ...source } }], messages: [] }] };
  const h = routedHarness(state, source);
  await h.routing.flushLocalIntents();
  assert.equal(state.rooms[0].settings.maxTurns, 7);
  assert.equal(state.rooms[1].settings, undefined);
  assert.match(state.rooms[0].messages.at(-1).text, /Updated default budget/);
  assert.equal(state.rooms[1].messages.length, 0);
});

test('identical local mutations in different rooms keep separate flights and receipts', async () => {
  const source = { targetClassId: 'local-origin', targetId: 'local:tlo-chat:shared', providerId: 'tlo-chat' };
  const command = { action: 'checkpoint', note: 'same command' };
  const state = { rooms: [roomWithIntent('room-a', source, command, 'turn-a'),
    roomWithIntent('room-b', source, command, 'turn-b')] };
  const h = routedHarness(state, source);
  await h.routing.flushLocalIntents();
  const requests = h.outbound.filter((item) => item.type === 'provider_control_request');
  assert.deepEqual(requests.map((item) => item.command.room).sort(), ['room-a', 'room-b']);
  assert.equal(h.routing.pendingMutations.size, 2);
  for (const request of requests) await h.routing.handle(h.dex, { type: 'provider_control_result',
    requestId: request.requestId, result: { ok: true, action: 'checkpoint', message: `Saved ${request.command.room}.` } });
  assert.match(state.rooms[0].messages.at(-1).text, /Saved room-a/);
  assert.match(state.rooms[1].messages.at(-1).text, /Saved room-b/);
});
