'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderControlRouting, MAX_ORIGIN_WAIT_MS, ORIGIN_POLL_MS } = require('../dex/provider-control-routing');
const receipt = require('../dex/provider-control-receipt');

const SOURCE = { targetClassId: 'online-origin', providerId: 'chatgpt',
  targetId: 42, url: 'https://chatgpt.com/c/eve' };
const COMMAND = { action: 'send', room: 'room-eve', text: 'Astro: inspect final result.' };
function room(id = 'room-eve') {
  return { id, name: 'Eve Astro', members: [{ id: 'eve', name: 'Eve', binding: SOURCE }],
    relay: { active: true, waitingFor: 'eve' },
    recovery: { requestId: 'dex-turn-current', memberId: 'eve' } };
}
function runner(snapshot, { at = Infinity, mismatched = false } = {}) {
  let time = 0, reads = 0;
  const getState = () => {
    reads += 1;
    if (time >= at && snapshot.rooms.length === 1) {
      const target = snapshot.rooms[0];
      if (!mismatched) target.pendingProviderControlReceipt = {
        commandKey: receipt.commandKey(COMMAND), executorMemberId: 'eve',
        agentMessageId: 'msg-final', turnRequestId: 'dex-turn-current'
      };
      delete target.recovery;
      target.relay.active = false;
      target.relay.waitingFor = null;
    }
    return snapshot;
  };
  const routing = createProviderControlRouting({
    getState, now: () => time, sleep: async (ms) => { time += ms; },
    getExtension: () => null
  });
  return { routing, state: () => ({ time, reads }) };
}

test('early browser CMD waits beyond old eight-second deadline for exact finalized relay intent', async () => {
  const h = runner({ rooms: [room()] }, { at: 15000 });
  const result = await h.routing.settleOrigin(SOURCE, COMMAND, 'control-early');
  assert.equal(result.origin?.agentMessageId, 'msg-final');
  assert.ok(h.state().time >= 15000);
  assert.equal(h.state().time, 15000);
  assert.ok(h.state().reads > 3);
});

test('completed relay without matching trailing CMD is rejected, never executed', async () => {
  const h = runner({ rooms: [room()] }, { at: 12500, mismatched: true });
  const result = await h.routing.settleOrigin(SOURCE, COMMAND, 'control-mismatch');
  assert.equal(result.error?.code, 'DEX_CONTROL_ORIGIN_UNCORRELATED');
  assert.equal(h.state().time, 12500);
});

test('ambiguous simultaneous source turns are rejected without waiting', async () => {
  const h = runner({ rooms: [room(), room('room-second')] });
  const result = await h.routing.settleOrigin(SOURCE, COMMAND, 'control-ambiguous');
  assert.equal(result.error?.code, 'DEX_CONTROL_ORIGIN_AMBIGUOUS');
  assert.equal(h.state().time, 0);
});

test('no active bound relay preserves ordinary direct control semantics', async () => {
  const h = runner({ rooms: [] });
  const result = await h.routing.settleOrigin(SOURCE, COMMAND, 'control-outside');
  assert.equal(result.origin, null);
  assert.equal(h.state().time, 0);
});

test('unfinished relay times out once within bounded four-minute window', async () => {
  const h = runner({ rooms: [room()] });
  const result = await h.routing.settleOrigin(SOURCE, COMMAND, 'control-timeout');
  assert.equal(result.error?.code, 'DEX_CONTROL_ORIGIN_TIMEOUT');
  assert.match(result.error.message, /dex-turn-current/);
  assert.equal(MAX_ORIGIN_WAIT_MS, 240000);
  assert.ok(h.state().time >= MAX_ORIGIN_WAIT_MS);
  assert.ok(h.state().time <= MAX_ORIGIN_WAIT_MS + ORIGIN_POLL_MS);
});
