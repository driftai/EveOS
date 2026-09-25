const test = require('node:test');
const assert = require('node:assert/strict');
const receipt = require('../dex/provider-control-receipt');
const { createProviderControlRouting } = require('../dex/provider-control-routing');

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
