'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createOutbox, KEY, MIN_RETRY_MS } = require('../extension/dex-final-receipt');
const { finalDisposition } = require('../dex/final-receipt-disposition');
const state = require('../dex/server-scheduler-state');
const { createTracker } = require('../public/dex-relay-timing');

function storage() {
  let data = {};
  return { async get() { return structuredClone(data); },
    async set(next) { data = structuredClone({ ...data, ...next }); }, dump: () => structuredClone(data) };
}
const ID = 'dex-turn-0b6f2f8a-7f43-4d36-9d6c-3f1d2e9a0c11';
const final = { type: 'response_final', requestId: ID, text: 'Done.', observedAt: 1000, providerName: 'Hark' };
const opts = { tabId: 7, providerId: 'hark' };
const find = state.findFinalReceipt;

test('server answers a committed Dex final with a committed receipt', () => {
  const snapshot = { rooms: [{ id: 'r1', finalReceipts: [{ requestId: ID, messageId: 'm1', committedAt: 'x' }] }] };
  const receipt = finalDisposition(snapshot, ID, { findFinalReceipt: find });
  assert.equal(receipt.state, 'committed');
  assert.equal(receipt.messageId, 'm1');
});

test('server answers a final with no pending turn as superseded', () => {
  const receipt = finalDisposition({ rooms: [{ id: 'r1' }] }, ID, { findFinalReceipt: find });
  assert.equal(receipt.state, 'superseded');
  assert.equal(receipt.reason, 'no-pending-turn');
});

test('server keeps retries alive while the turn is current, in recovery, or watched for a late final', () => {
  assert.equal(finalDisposition({ rooms: [] }, ID, { currentRequestId: ID, findFinalReceipt: find }), null);
  assert.equal(finalDisposition({ rooms: [{ id: 'r', recovery: { requestId: ID } }] }, ID, { findFinalReceipt: find }), null);
  assert.equal(finalDisposition({ rooms: [{ id: 'r', lateFinalWatches: [{ requestId: ID }] }] }, ID, { findFinalReceipt: find }), null);
  assert.equal(finalDisposition({ rooms: [] }, 'base-123', { findFinalReceipt: find }), null, 'non-Dex ids are not receipted');
});

for (const terminal of ['superseded', 'rejected']) {
  test(`outbox drops a final on a ${terminal} receipt and stops heartbeat replay`, async () => {
    let now = 0; const sent = []; const disk = storage();
    const outbox = createOutbox({ storage: disk, now: () => now });
    await outbox.queue(final, { ...opts, send: (m) => { sent.push(m); return true; } });
    assert.equal(sent.length, 1);
    assert.equal(await outbox.acknowledge({ type: 'dex_turn_receipt', requestId: ID, state: terminal }), true);
    assert.equal(disk.dump()[KEY].length, 0);
    for (let beat = 0; beat < 5; beat += 1) {
      now += MIN_RETRY_MS * 2;
      outbox.flush({ send: (m) => { sent.push(m); return true; } });
    }
    assert.equal(sent.length, 1, 'no 20s heartbeat replays after a terminal receipt');
  });
}

test('outbox still retries when the server says the turn is pending (no receipt)', async () => {
  let now = 0; const sent = [];
  const outbox = createOutbox({ storage: storage(), now: () => now });
  await outbox.queue(final, { ...opts, send: (m) => { sent.push(m); return true; } });
  assert.equal(await outbox.acknowledge({ type: 'dex_turn_receipt', requestId: ID, state: 'pending' }), false);
  now += MIN_RETRY_MS + 1;
  assert.equal(outbox.flush({ send: (m) => { sent.push(m); return true; } }).sent, 1);
});

test('replayed final is logged once and never restarts the handoff clock', () => {
  let now = 1000;
  const timing = createTracker({ now: () => now });
  assert.match(timing.onFinal(final), /Relay timing: Hark final/);
  now = 6000;
  assert.match(timing.onAccepted({ requestId: 'dex-turn-next-0001', providerName: 'ChatGPT', observedAt: now }), /accepted in 5000 ms/);
  for (let beat = 1; beat <= 6; beat += 1) {
    now += 20000;
    assert.equal(timing.onFinal(final), null, 'heartbeat replay must not log');
  }
  assert.equal(timing.onAccepted({ requestId: 'dex-turn-next-0002', providerName: 'ChatGPT', observedAt: now }), null,
    'a replayed final must not arm a handoff measured from its stale observedAt');
});

test('handoff is per request and capped, never growing across turns', () => {
  let now = 0;
  const timing = createTracker({ now: () => now });
  const lines = [];
  for (let turn = 0; turn < 4; turn += 1) {
    now += 60000;
    timing.onFinal({ requestId: `dex-turn-final-000${turn}`, providerName: 'Hark', observedAt: now });
    now += 3000;
    lines.push(timing.onAccepted({ requestId: `dex-turn-acc-000${turn}`, providerName: 'ChatGPT', observedAt: now }));
  }
  assert.deepEqual(lines.map((l) => Number(/in (\d+) ms/.exec(l)[1])), [3000, 3000, 3000, 3000]);
  timing.onFinal({ requestId: 'dex-turn-stale-0001', providerName: 'Hark', observedAt: 0 });
  assert.equal(timing.onAccepted({ requestId: 'dex-turn-acc-late', observedAt: 60 * 60 * 1000 }), null, 'absurd gaps dropped');
});

test('server.js sends the terminal disposition and Dex Mode loads the timing tracker first', () => {
  const root = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /finalReceiptDisposition\.finalDisposition\(/);
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.ok(html.indexOf('/dex-relay-timing.js') > 0 && html.indexOf('/dex-relay-timing.js') < html.indexOf('/dex-mode.js'));
});
