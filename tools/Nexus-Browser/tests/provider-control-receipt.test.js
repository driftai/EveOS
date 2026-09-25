const test = require('node:test');
const assert = require('node:assert/strict');
const receipt = require('../dex/provider-control-receipt');
const { createProviderControlRouting } = require('../dex/provider-control-routing');
const bridge = require('../extension/dex-provider-control-bridge');

function snapshot() {
  return {
    version: 1,
    activeRoomId: 'coord',
    rooms: [{
      id: 'coord',
      name: 'Coordination',
      members: [
        {
          id: 'origin',
          name: 'Eve Engineering 3',
          binding: {
            targetClassId: 'online-origin',
            targetId: 10,
            providerId: 'chatgpt',
            providerName: 'ChatGPT',
            url: 'https://chatgpt.com/c/origin'
          }
        },
        {
          id: 'executor',
          name: 'Eve Stress',
          binding: {
            targetClassId: 'online-origin',
            targetId: 20,
            providerId: 'chatgpt',
            providerName: 'ChatGPT',
            url: 'https://chatgpt.com/c/stress'
          }
        }
      ],
      messages: [
        { id: 'm-origin', senderKind: 'agent', senderId: 'origin', senderName: 'Eve Engineering 3', text: 'Please add Engineering 3.' },
        { id: 'm-executor', senderKind: 'agent', senderId: 'executor', senderName: 'Eve Stress', text: 'Doing one admin action.' }
      ],
      relay: { active: false, remaining: 0, waitingFor: null, lastStopReason: 'Eve Stress requested Dex provider control' }
    }]
  };
}

function remember(value, command) {
  const room = value.rooms[0];
  return receipt.rememberIntent(room, {
    executorMember: room.members[1],
    sourceMessage: room.messages[0],
    command,
    agentMessage: room.messages[1],
    turnRequestId: 'dex-turn-1',
    at: '2026-09-20T03:00:00.000Z'
  });
}

test('receipt correlation binds the exact executor command back to the originating agent target', () => {
  const value = snapshot();
  const command = { action: 'add_agent', room: 'stress-room', targetClassId: 'online-origin', targetId: 99, name: 'Eve Engineering 3' };
  remember(value, command);

  const origin = receipt.findIntent(value, {
    targetClassId: 'online-origin',
    targetId: 20,
    providerId: 'chatgpt',
    url: 'https://chatgpt.com/c/stress'
  }, command);

  assert.ok(origin);
  assert.equal(origin.roomId, 'coord');
  assert.equal(origin.executorName, 'Eve Stress');
  assert.equal(origin.originTarget.targetId, 10);
  assert.equal(receipt.findIntent(value, {
    targetClassId: 'online-origin', targetId: 21, providerId: 'chatgpt', url: 'https://chatgpt.com/c/other'
  }, command), null);
  assert.equal(receipt.findIntent(value, {
    targetClassId: 'online-origin', targetId: 20, providerId: 'chatgpt', url: 'https://chatgpt.com/c/stress'
  }, { ...command, targetId: 100 }), null);
});

test('applying a result writes a transport-only system receipt and clears pending correlation', () => {
  const value = snapshot();
  const command = { action: 'add_agent', room: 'stress-room', targetClassId: 'online-origin', targetId: 99, name: 'Eve Engineering 3' };
  const origin = remember(value, command);
  const matched = { roomId: value.rooms[0].id, roomName: value.rooms[0].name, ...origin };
  const applied = receipt.applyResult(value, matched, {
    ok: true,
    action: 'add_agent',
    message: 'Added Eve Engineering 3.',
    data: { addedMemberId: 'agent-3' }
  }, 'control-1', '2026-09-20T03:00:01.000Z');

  assert.equal(receipt.pendingCount(applied.snapshot), 0);
  const last = applied.snapshot.rooms[0].messages.at(-1);
  assert.equal(last.senderKind, 'system');
  assert.match(last.text, /DEX CONTROL RECEIPT/);
  assert.match(last.text, /Added Eve Engineering 3/);
  assert.equal(last.controlReceipt.requestId, 'control-1');
  assert.equal(applied.receipt.originTarget.targetId, 10);
});

test('provider-control routing returns one correlated receipt to the executor bridge and persists it in the origin room', async () => {
  let value = snapshot();
  const command = { action: 'add_agent', room: 'stress-room', targetClassId: 'online-origin', targetId: 99, name: 'Eve Engineering 3' };
  remember(value, command);
  const dex = { role: 'ui', clientKind: 'dex', sent: [] };
  const executor = { role: 'provider-control-extension', clientKind: null, sent: [] };
  const broadcasts = [];
  const routing = createProviderControlRouting({
    uiSockets: new Set([dex]),
    safeSend(ws, payload) { ws.sent.push(payload); return true; },
    validateSource: async () => true,
    getState: () => value,
    saveState(next) { value = next; return value; },
    broadcastState(next) { broadcasts.push(next); }
  });
  const source = {
    targetClassId: 'online-origin',
    targetId: 20,
    providerId: 'chatgpt',
    providerName: 'ChatGPT',
    url: 'https://chatgpt.com/c/stress'
  };

  await routing.handle(executor, { type: 'provider_control_request', requestId: 'control-route-1', source, command });
  assert.equal(dex.sent.length, 1);
  await routing.handle(dex, {
    type: 'provider_control_result',
    requestId: 'control-route-1',
    source,
    result: { ok: true, action: 'add_agent', message: 'Added Eve Engineering 3.', data: { addedMemberId: 'agent-3' } }
  });

  assert.equal(executor.sent.filter((entry) => entry.type === 'provider_control_received').length, 1);
  assert.equal(executor.sent.filter((entry) => entry.type === 'provider_control_result').length, 1);
  assert.equal(executor.sent.find((entry) => entry.type === 'provider_control_result').originReceipt.originTarget.targetId, 10);
  assert.equal(broadcasts.length, 1);
  assert.equal(receipt.pendingCount(value), 0);
  assert.equal(value.rooms[0].messages.at(-1).senderKind, 'system');
});

test('origin receipt delivery distinguishes executor and original sender targets', () => {
  assert.equal(bridge.sameTarget(
    { targetClassId: 'online-origin', targetId: 20, providerId: 'chatgpt' },
    { targetClassId: 'online-origin', targetId: 20, providerId: 'chatgpt' }
  ), true);
  assert.equal(bridge.sameTarget(
    { targetClassId: 'online-origin', targetId: 10, providerId: 'chatgpt' },
    { targetClassId: 'online-origin', targetId: 20, providerId: 'chatgpt' }
  ), false);
});
