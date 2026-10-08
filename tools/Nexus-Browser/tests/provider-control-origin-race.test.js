const test = require('node:test');
const assert = require('node:assert/strict');
const receipt = require('../dex/provider-control-receipt');
const { MUTATING_ACTIONS, createProviderControlRouting } = require('../dex/provider-control-routing');

function state() {
  return {
    rooms: [{
      id: 'coord',
      name: 'Coordination',
      members: [
        { id: 'origin', name: 'Origin', binding: { targetClassId: 'online-origin', targetId: 10, providerId: 'chatgpt', url: 'https://chatgpt.com/c/origin' } },
        { id: 'executor', name: 'Executor', binding: { targetClassId: 'online-origin', targetId: 20, providerId: 'chatgpt', url: 'https://chatgpt.com/c/executor' } }
      ],
      messages: [
        { id: 'm-origin', senderKind: 'agent', senderId: 'origin', senderName: 'Origin', text: 'Run status.' },
        { id: 'm-executor', senderKind: 'agent', senderId: 'executor', senderName: 'Executor', text: 'Running status.' }
      ],
      relay: { active: true, remaining: 1, waitingFor: 'executor', lastStopReason: 'Running' },
      recovery: { memberId: 'executor', requestId: 'dex-turn-race', dispatched: true }
    }]
  };
}

const source = {
  targetClassId: 'online-origin',
  targetId: 20,
  providerId: 'chatgpt',
  url: 'https://chatgpt.com/c/executor'
};

function remember(value, command) {
  const room = value.rooms[0];
  return receipt.rememberIntent(room, {
    executorMember: room.members[1],
    sourceMessage: room.messages[0],
    command,
    agentMessage: room.messages[1],
    turnRequestId: 'dex-turn-race',
    at: '2026-09-20T04:30:00.000Z'
  });
}

test('active source turn matches exact provider binding', () => {
  const active = receipt.activeSourceTurn(state(), source);
  assert.equal(active.roomId, 'coord');
  assert.equal(active.requestId, 'dex-turn-race');
});

test('control waits for relay correlation before routing', async () => {
  let value = state();
  const room = value.rooms[0];
  const command = { action: 'status', room: 'coord' };
  const dex = { role: 'ui', clientKind: 'dex', sent: [] };
  const caller = { role: 'provider-control-extension', sent: [] };
  const routing = createProviderControlRouting({
    uiSockets: new Set([dex]),
    safeSend(ws, payload) { ws.sent.push(payload); return true; },
    validateSource: async () => true,
    getState: () => value,
    saveState(next) { value = next; return value; },
    async sleep() {
      room.relay.active = false;
      room.relay.waitingFor = null;
      delete room.recovery;
      remember(value, command);
    }
  });
  await routing.handle(caller, { type: 'provider_control_request', requestId: 'race-ok', source, command });
  assert.equal(dex.sent.length, 1);
  await routing.handle(dex, { type: 'provider_control_result', requestId: 'race-ok', source, result: { ok: true, action: 'status', message: 'ok' } });
  assert.equal(caller.sent.find((entry) => entry.type === 'provider_control_result').originReceipt.roomId, 'coord');
});

test('control fails closed if relay settles without correlation', async () => {
  const value = state();
  const room = value.rooms[0];
  const dex = { role: 'ui', clientKind: 'dex', sent: [] };
  const caller = { role: 'provider-control-extension', sent: [] };
  const routing = createProviderControlRouting({
    uiSockets: new Set([dex]),
    safeSend(ws, payload) { ws.sent.push(payload); return true; },
    validateSource: async () => true,
    getState: () => value,
    async sleep() {
      room.relay.active = false;
      room.relay.waitingFor = null;
      delete room.recovery;
    }
  });
  await routing.handle(caller, { type: 'provider_control_request', requestId: 'race-fail', source, command: { action: 'status', room: 'coord' } });
  assert.equal(dex.sent.length, 0);
  assert.equal(caller.sent.find((entry) => entry.type === 'provider_control_result').result.code, 'DEX_CONTROL_ORIGIN_UNCORRELATED');
});

test('late quorum presence waits for exact durable intent before machine routing', async () => {
  let value = state();
  const room = value.rooms[0];
  room.relay.active = false;
  room.relay.waitingFor = null;
  delete room.recovery;
  const command = { action: 'quorum_presence' };
  const caller = { role: 'provider-control-extension', sent: [] };
  let sleeps = 0;
  let routedOrigin = null;
  const machineCommandRouter = {
    owns(action) { return action === 'quorum_presence'; },
    route(context, { sendResult, commitOriginReceipt }) {
      routedOrigin = context.origin;
      const result = { ok: true, action: 'quorum_presence', message: 'Presence recorded.' };
      const originReceipt = commitOriginReceipt(context.origin, result, context.requestId);
      sendResult({ sourceSocket: context.ws, requestId: context.requestId, source: context.source }, result, originReceipt);
      return true;
    }
  };
  const routing = createProviderControlRouting({
    uiSockets: new Set(),
    safeSend(ws, payload) { ws.sent.push(payload); return true; },
    validateSource: async () => true,
    getState: () => value,
    saveState(next) { value = next; return value; },
    machineCommandRouter,
    async sleep() {
      sleeps += 1;
      if (sleeps === 1) remember(value, command);
    }
  });

  assert.equal(MUTATING_ACTIONS.has('quorum_presence'), true);
  assert.equal(MUTATING_ACTIONS.has('quorum_vote'), true);
  await routing.handle(caller, { type: 'provider_control_request', requestId: 'late-quorum-ok', source, command });

  assert.equal(sleeps, 1);
  assert.equal(routedOrigin.roomId, 'coord');
  assert.equal(routedOrigin.executorMemberId, 'executor');
  const result = caller.sent.find((entry) => entry.type === 'provider_control_result');
  assert.equal(result.result.ok, true);
  assert.equal(result.originReceipt.roomId, 'coord');
  assert.equal(value.rooms[0].pendingProviderControlReceipt, undefined);
});

test('late quorum mutation still fails closed when no matching durable intent appears', async () => {
  const value = state();
  const room = value.rooms[0];
  room.relay.active = false;
  room.relay.waitingFor = null;
  delete room.recovery;
  const caller = { role: 'provider-control-extension', sent: [] };
  let clock = 0;
  const machineCommandRouter = {
    owns(action) { return action === 'quorum_presence'; },
    route() { throw new Error('quorum mutation must not route without exact origin'); }
  };
  const routing = createProviderControlRouting({
    uiSockets: new Set(),
    safeSend(ws, payload) { ws.sent.push(payload); return true; },
    validateSource: async () => true,
    getState: () => value,
    machineCommandRouter,
    now: () => clock,
    async sleep(ms) { clock += ms; }
  });

  await routing.handle(caller, {
    type: 'provider_control_request',
    requestId: 'late-quorum-fail',
    source,
    command: { action: 'quorum_presence' }
  });
  const result = caller.sent.find((entry) => entry.type === 'provider_control_result');
  assert.equal(result.result.code, 'DEX_CONTROL_ORIGIN_REQUIRED');
});
