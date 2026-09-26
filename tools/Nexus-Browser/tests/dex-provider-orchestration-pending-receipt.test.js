'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../dex/provider-orchestration-policy');
const receipt = require('../dex/provider-control-receipt');

const eve = { targetClassId: 'online-origin', providerId: 'chatgpt',
  targetId: 42, url: 'https://chatgpt.com/c/eve' };
const astro = { targetClassId: 'online-origin', providerId: 'muse',
  targetId: 43, url: 'https://muse.ai/c/astro' };
const command = { action: 'spawn_agent', room: 'room-1', providerId: 'muse' };
function state() {
  return { rooms: [{ id: 'room-1', name: 'Room',
    relay: { active: false, waitingFor: null },
    members: [{ id: 'eve', name: 'Eve', binding: eve },
      { id: 'astro', name: 'Astro', binding: astro }],
    pendingProviderControlReceipt: {
      executorMemberId: 'eve', commandKey: receipt.commandKey(command)
    }
  }] };
}

test('exact settled caller receipt permits only its correlated spawn', () => {
  const snapshot = state();
  assert.equal(policy.authorizeSpawn(snapshot, eve, command).ok, true);
  assert.equal(policy.authorizeSpawn(snapshot, astro, command).code, 'DEX_CONTROL_ROOM_BUSY');
  assert.equal(policy.authorizeSpawn(snapshot, eve, { ...command, providerId: 'deepseek' }).code,
    'DEX_CONTROL_ROOM_BUSY');
});

test('matching caller receipt cannot bypass active turn, recovery, or queued inbox', () => {
  for (const blocked of [
    { relay: { active: true, waitingFor: 'eve' } },
    { recovery: { memberId: 'eve', requestId: 'unfinished' } },
    { deferredRelays: [{ requestId: 'queued-report' }] }
  ]) {
    const snapshot = state();
    Object.assign(snapshot.rooms[0], blocked);
    assert.equal(policy.authorizeSpawn(snapshot, eve, command).code, 'DEX_CONTROL_ROOM_BUSY');
  }
});
