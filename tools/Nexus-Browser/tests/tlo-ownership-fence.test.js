'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTloOwnershipFence } = require('../dex/tlo-ownership-fence');
const DIGEST = 'a'.repeat(64);
const SECRET = 'handoff-secret' + '-unit-test-0001';

function fixture() {
  const records = new Map();
  const store = {
    read(scope) { return records.get(scope) ? structuredClone(records.get(scope)) : null; },
    compareAndSwap(scope, revision, state) {
      const old = records.get(scope);
      if ((old?.revision ?? null) !== revision) return false;
      records.set(scope, { revision: (old?.revision ?? 0) + 1, state: structuredClone(state) });
      return true;
    }
  };
  const fence = createTloOwnershipFence({ ...store, uid: () => 'unit-test-handoff', now: () => 12345 });
  const browser = { kind: 'browser', id: 'search-monitor-test-1', generation: 1 };
  const backend = { kind: 'backend', id: 'local-backend-host-1', generation: 2 };
  return { fence, store, browser, backend };
}
function claim(f) { return f.fence.claimInitialBrowser({ workspaceId: f.browser.id }); }
function expectCode(fn, code) { assert.throws(fn, e => e.code === code); }
function prepare(f) {
  return f.fence.prepareHandoff({ from: f.browser, to: f.backend,
    conversationDigest: DIGEST, sourceWorkspaceId: f.browser.id,
    acknowledgementSecret: SECRET });
}
function handoff(f) {
  const a = prepare(f);
  const id = a.handoff.id;
  f.fence.acknowledgeHandoff({ handoffId: id, to: f.backend,
    acknowledgementSecret: SECRET });
  return f.fence.completeHandoff({ handoffId: id, from: f.browser });
}

test('no host is implicitly created on a read', () => {
  const f = fixture();
  assert.equal(f.fence.snapshot().state.owner, null);
  assert.equal(f.fence.snapshot().state.generation, 0);
});
test('initial browser claim is one-shot', () => {
  const f = fixture(); claim(f);
  assert.equal(f.fence.snapshot().state.generation, 1);
  expectCode(() => claim(f), 'TLO_OWNER_ALREADY_CLAIMED');
});
test('idle acknowledged handoff increments generation and fences stale browser', () => {
  const f = fixture(); claim(f);
  const s = handoff(f);
  assert.deepEqual(s.owner, { kind: 'backend', id: f.backend.id });
  assert.equal(s.generation, 2);
  expectCode(() => f.fence.reserveTurn({ owner: f.browser, requestId: 'dex-turn-123456' }), 'TLO_OWNER_STALE');
});
test('cannot hand off while a turn is admitted', () => {
  const f = fixture(); claim(f);
  f.fence.reserveTurn({ owner: f.browser, requestId: 'dex-turn-123456' });
  expectCode(() => prepare(f), 'TLO_OWNER_BUSY');
});
test('preparing a handoff blocks new inference and requires explicit acknowledgement', () => {
  const f = fixture(); claim(f);
  const s = prepare(f);
  expectCode(() => f.fence.reserveTurn({ owner: f.browser, requestId: 'dex-turn-123456' }), 'TLO_OWNER_BUSY');
  expectCode(() => f.fence.completeHandoff({ handoffId: s.handoff.id, from: f.browser }), 'TLO_HANDOFF_STALE');
});
test('only prepared, not acknowledged, handoffs can be cancelled', () => {
  const f = fixture(); claim(f);
  let s = prepare(f);
  f.fence.cancelPreparedHandoff({ handoffId: s.handoff.id, from: f.browser });
  assert.equal(f.fence.snapshot().state.handoff, null);
  s = prepare(f);
  f.fence.acknowledgeHandoff({ handoffId: s.handoff.id, to: f.backend,
    acknowledgementSecret: SECRET });
  expectCode(() => f.fence.cancelPreparedHandoff({ handoffId: s.handoff.id, from: f.browser }), 'TLO_HANDOFF_STALE');
});
test('a turn is recorded before upstream inference and cannot be dispatched twice', () => {
  const f = fixture(); claim(f);
  f.fence.reserveTurn({ owner: f.browser, requestId: 'dex-turn-123456' });
  const s = f.fence.markDispatched({ owner: f.browser, requestId: 'dex-turn-123456' });
  assert.equal(s.turn.phase, 'dispatched');
  expectCode(() => f.fence.markDispatched({ owner: f.browser, requestId: 'dex-turn-123456' }), 'TLO_TURN_STALE');
});
test('only correlated durable final receipts can clear a dispatched turn', () => {
  const f = fixture(); claim(f);
  f.fence.reserveTurn({ owner: f.browser, requestId: 'dex-turn-123456' });
  f.fence.markDispatched({ owner: f.browser, requestId: 'dex-turn-123456' });
  expectCode(() => f.fence.settleWithReceipt({ owner: f.browser, requestId: 'dex-turn-123456', finalReceipt: { confirmed: true, requestId: 'wrong', source: 'dex-durable-ledger' } }), 'TLO_RECEIPT_REQUIRED');
  const s = f.fence.settleWithReceipt({ owner: f.browser, requestId: 'dex-turn-123456', finalReceipt: { confirmed: true, requestId: 'dex-turn-123456', source: 'dex-durable-ledger' } });
  assert.equal(s.turn, null);
});
test('transport uncertainty prevents any further dispatch or handoff', () => {
  const f = fixture(); claim(f);
  f.fence.reserveTurn({ owner: f.browser, requestId: 'dex-turn-123456' });
  f.fence.markDispatched({ owner: f.browser, requestId: 'dex-turn-123456' });
  f.fence.markUncertain({ requestId: 'dex-turn-123456' });
  expectCode(() => f.fence.reserveTurn({ owner: f.browser, requestId: 'dex-turn-abcdef' }), 'TLO_OWNER_BUSY');
  expectCode(() => prepare(f), 'TLO_OWNER_BUSY');
});
test('handoff binds transcript, source, generations and one-time target acknowledgement', () => {
  const f = fixture(); claim(f);
  const prepared = prepare(f);
  assert.equal(prepared.handoff.conversationDigest, DIGEST);
  assert.equal(prepared.handoff.sourceWorkspaceId, f.browser.id);
  assert.equal(prepared.handoff.toGeneration, 2);
  assert.notEqual(prepared.handoff.tokenHash, SECRET);
  expectCode(() => f.fence.acknowledgeHandoff({ handoffId: prepared.handoff.id,
    to: f.backend, acknowledgementSecret: 'wrong-handof' + 'f-secret-0001' }), 'TLO_HANDOFF_AUTH_INVALID');
  const acknowledged = f.fence.acknowledgeHandoff({ handoffId: prepared.handoff.id,
    to: f.backend, acknowledgementSecret: SECRET });
  assert.equal(acknowledged.handoff.tokenHash, null);
  assert.deepEqual(acknowledged.handoff.acknowledgedBy, { kind: 'backend', id: f.backend.id });
  expectCode(() => f.fence.acknowledgeHandoff({ handoffId: prepared.handoff.id,
    to: f.backend, acknowledgementSecret: SECRET }), 'TLO_HANDOFF_STALE');
});
test('restart conservatively marks unfinished turns unknown and does not replay', () => {
  const f = fixture(); claim(f);
  f.fence.reserveTurn({ owner: f.browser, requestId: 'dex-turn-123456' });
  const s = f.fence.fenceRestart({});
  assert.equal(s.turn.phase, 'unknown');
  assert.equal(s.turn.requestId, 'dex-turn-123456');
  assert.equal(f.fence.fenceRestart().turn.phase, 'unknown');
});
test('atomic CAS conflict is a safe stop, not an automatic retry', () => {
  const f = fixture();
  const reject = createTloOwnershipFence({ read: f.store.read, compareAndSwap: () => false });
  expectCode(() => reject.claimInitialBrowser({ workspaceId: f.browser.id }), 'TLO_OWNER_RACE');
  assert.equal(f.fence.snapshot().state.owner, null);
});
test('reject invalid/corrupt persisted state instead of repairing it', () => {
  const invalid = createTloOwnershipFence({ read: () => ({ revision: 1, state: { schema: 'corrupt' } }), compareAndSwap: () => true });
  expectCode(() => invalid.snapshot(), 'TLO_OWNER_STATE_CORRUPT');
});
