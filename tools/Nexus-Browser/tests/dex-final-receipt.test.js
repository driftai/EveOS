'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutbox, KEY, TTL_MS, MIN_RETRY_MS } = require('../extension/dex-final-receipt');
const state = require('../dex/server-scheduler-state');
const { mergeIdleRoom } = require('../dex/server-state-merge');

function storage(initial = {}) {
  let data = structuredClone(initial);
  return {
    async get() { return structuredClone(data); },
    async set(next) { data = structuredClone({ ...data, ...next }); },
    dump: () => structuredClone(data)
  };
}
const ID = 'dex-turn-a5c1d6f6-47b9-423a-9fe0-d6452e923f28';
const final = { type: 'response_final', requestId: ID, text: 'Completed.\n[[DEX:RETURN:' + ID + ']]' };
const options = { tabId: 42, providerId: 'chatgpt' };

test('the Dex final outbox durably queues response text before sending and replays only the result', async () => {
  let now = 10000, sent = [];
  const disk = storage();
  const first = createOutbox({ storage: disk, now: () => now });
  assert.equal((await first.queue(final, { ...options, send(msg) {
    assert.equal(disk.dump()[KEY].length, 1, 'save precedes socket send');
    sent.push(msg); return true;
  } })).ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'response_final');
  assert.equal(first.flush({ send: (msg) => { sent.push(msg); return true; } }).sent, 0);
  now += MIN_RETRY_MS + 1;
  const second = createOutbox({ storage: disk, now: () => now });
  await second.restore();
  const flushed = second.flush({ send: (msg) => { sent.push(msg); return true; } });
  assert.equal(flushed.sent, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].requestId, sent[0].requestId, 'never replay the prompt');
  assert.equal(await second.acknowledge({ type: 'dex_turn_receipt', requestId: ID, state: 'unknown' }), false);
  assert.equal(await second.acknowledge({ type: 'dex_turn_receipt', requestId: ID, state: 'committed' }), true);
  assert.equal(disk.dump()[KEY].length, 0);
  assert.equal(second.diagnostics().acknowledged, 1);
});

test('a queued Dex final can replay after the selected provider target changes', async () => {
  let now = 10000, sent = 0;
  const outbox = createOutbox({ storage: storage(), now: () => now });
  await outbox.queue(final, { ...options, send: () => { sent += 1; return true; } });
  assert.equal(sent, 1);
  now += MIN_RETRY_MS + 1;
  const replay = outbox.flush({ tabId: 777, providerId: 'claude', send: () => { sent += 1; return true; } });
  assert.equal(replay.sent, 1, 'current target selection must not own an already-queued result');
  assert.equal(sent, 2);
  now += TTL_MS + 1;
  assert.equal(outbox.flush({ send: () => { sent += 1; return true; } }).sent, 0);
  assert.equal(outbox.diagnostics().expiredUnconfirmed, 1);
});

test('Base finals cannot enter Dex durable storage and legacy Base entries are discarded on restore', async () => {
  const base = { type: 'response_final', requestId: 'base-turn-1', text: 'base reply' };
  const disk = storage({ [KEY]: [{ requestId: base.requestId, tabId: 42, providerId: 'chatgpt', payload: base, createdAt: 10000, lastSentAt: 0 }] });
  const restored = createOutbox({ storage: disk, now: () => 10001 });
  await restored.restore();
  assert.equal(restored.diagnostics().pending, 0);
  assert.equal(restored.diagnostics().discardedLegacy, 1);
  assert.deepEqual(disk.dump()[KEY], []);
  await assert.rejects(restored.queue(base, { ...options, send: () => true }), /reserved for Dex request IDs/);
});

test('a persisted localhost receipt is idempotent and survives stale idle UI snapshots', () => {
  const room = { id: 'eve-astro', messages: [{ id: 'reply-1', text: final.text }] };
  assert.equal(state.rememberFinalReceipt(room, ID, 'reply-1'), true);
  assert.equal(state.rememberFinalReceipt(room, ID, 'reply-1'), false);
  assert.equal(room.finalReceipts.length, 1);
  assert.equal(state.findFinalReceipt({ rooms: [room] }, ID).messageId, 'reply-1');
  const merged = mergeIdleRoom(room, { id: 'eve-astro', messages: [] });
  assert.equal(state.findFinalReceipt({ rooms: [merged] }, ID).messageId, 'reply-1');
  assert.equal(state.findFinalReceipt({ rooms: [merged] }, 'dex-turn-unrelated12345678'), null);
});
