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
