'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const api = require('../dex/local-tool-result-sweep');
const binding = { targetClassId: 'local-origin',
  targetId: 'local:antigravity-existing:25032', providerId: 'local-antigravity-existing' };
function state() {
  return { rooms: [{ id: 'room-one', relay: { active: false },
    members: [{ id: 'astro', binding }], localToolResults: [
      { requestId: 'ctl-one', memberId: 'astro', targetId: binding.targetId,
        providerId: binding.providerId, state: 'queued' },
      { requestId: 'ctl-two', memberId: 'astro', targetId: binding.targetId,
        providerId: binding.providerId, state: 'queued' }
    ] }] };
}
test('default-off scheduler never starts native delivery without a trusted enable gate', async () => {
  let sent = 0;
  const worker = api.createLocalResultSweep({ load: state, deliverOne: async () => { sent++; } });
  assert.equal((await worker.once()).code, 'DEX_LOCAL_RESULT_SWEEP_DISABLED');
  assert.equal(sent, 0);
});
test('one-shot sweep selects only exact-owner, idle queued receipts and enforces per-tick cap', async () => {
  const snapshot = state(), seen = [];
  const worker = api.createLocalResultSweep({ load: () => snapshot, canWork: () => true,
    deliverOne: async ({ roomId, requestId }) => {
      seen.push([roomId, requestId]);
      snapshot.rooms[0].localToolResults.find(e => e.requestId === requestId).state = 'submitted-not-read';
      return { ok: true, state: 'submitted-not-read' };
    }, maxPerSweep: 1, now: () => 1000 });
  assert.equal((await worker.once()).submitted, 1);
  assert.equal((await worker.once()).submitted, 1);
  assert.deepEqual(seen, [['room-one', 'ctl-one'], ['room-one', 'ctl-two']]);
  assert.equal((await worker.once()).attempts, 0);
});
test('no notification while room is busy, recovering or has another pending receipt', async () => {
  const snapshot = state(), attempts = [];
  const worker = api.createLocalResultSweep({ load: () => snapshot, canWork: () => true,
    deliverOne: async value => { attempts.push(value); return { ok: true }; } });
  for (const field of ['recovery', 'pendingTurn', 'pendingProviderControlReceipt']) {
    snapshot.rooms[0][field] = { requestId: 'busy' };
    assert.equal((await worker.once()).attempts, 0);
    delete snapshot.rooms[0][field];
  }
  snapshot.rooms[0].relay.active = true;
  assert.equal((await worker.once()).attempts, 0);
  snapshot.rooms[0].relay.active = false;
  assert.equal(attempts.length, 0);
});
test('identity ambiguity and corrupted receipts never trigger a native delivery', async () => {
  const snapshot = state(); snapshot.rooms[0].members.push({ id: 'astro', binding });
  const worker = api.createLocalResultSweep({ load: () => snapshot, canWork: () => true,
    deliverOne: async () => { throw Error('must not happen'); } });
  assert.equal((await worker.once()).attempts, 0);
  snapshot.rooms[0].members.pop();
  snapshot.rooms[0].localToolResults[0].targetId = 'local:antigravity-existing:25033';
  snapshot.rooms[0].localToolResults[1].requestId = '../../bad';
  assert.equal((await worker.once()).attempts, 0);
});
test('held in-flight sweep prevents concurrent duplicate scan and throttles transient failures', async () => {
  const snapshot = state(), observed = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const worker = api.createLocalResultSweep({ load: () => snapshot, canWork: () => true,
    now: () => 1000, maxPerSweep: 1,
    deliverOne: async ({ requestId }) => { observed.push(requestId); await blocked;
      return { ok: false, code: 'DEX_LOCAL_RESULT_IDLE_UNVERIFIED' }; } });
  const pending = worker.once();
  assert.equal((await worker.once()).code, 'DEX_LOCAL_RESULT_SWEEP_IN_FLIGHT');
  release();
  assert.equal((await pending).attempts, 1);
  assert.equal((await worker.once()).attempts, 0);
  assert.deepEqual(observed, ['ctl-one']);
});
test('lost global lease stops scheduling further receipt attempts', async () => {
  let permit = true; const delivered = [];
  const worker = api.createLocalResultSweep({ load: state, canWork: () => permit,
    deliverOne: async ({ requestId }) => {
      delivered.push(requestId); permit = false;
      return { ok: false, state: 'outcome-unknown' };
    } });
  const result = await worker.once();
  assert.equal(result.code, 'DEX_LOCAL_RESULT_SWEEP_LEASE_LOST');
  assert.deepEqual(delivered, ['ctl-one']);
});
test('invalid resource bounds are rejected before scheduler construction', () => {
  assert.throws(() => api.createLocalResultSweep({ load: state, deliverOne() {},
    maxPerSweep: 10 }), /bounded/);
  assert.throws(() => api.createLocalResultSweep({ load: state, deliverOne() {},
    cooldownMs: 0 }), /bounded/);
});
