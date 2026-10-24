'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTloConversationStore, historyDigest, MAX_MESSAGES } = require('../dex/tlo-conversation-store');

const REQUEST = 'dex-turn-history-0001';
const CORRELATION = { roomId: 'room-history-0001', sourceMessageId: 'msg-source-history-0001',
  dispatchId: 'tlo-dispatch-history-0001' };
function turn(message, requestId = REQUEST) { return { generation: 1, requestId, message, ...CORRELATION }; }
function settle(store, requestId = REQUEST) {
  const pending = store.snapshot().pending;
  return store.settleDelivered({ generation: 1, requestId, roomId: pending.roomId,
    sourceMessageId: pending.sourceMessageId, dispatchId: pending.dispatchId,
    responseDigest: pending.responseDigest, deliveryReceipt: { source: 'dex-durable-ledger',
      confirmed: true, requestId, roomId: pending.roomId, sourceMessageId: pending.sourceMessageId } });
}

function fixture(t) {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'eve3d-history-'));
  t.after(() => fs.rmSync(dirPath, { recursive: true, force: true }));
  return { dirPath, store: createTloConversationStore({ dirPath }) };
}

function initialize(store, history = [], generation = 1, scopeId = 'default') {
  return store.initialize({ scopeId, generation, history,
    expectedDigest: historyDigest({ scopeId, generation, history }) });
}

test('import and empty snapshot have no runtime side effects', t => {
  const { dirPath, store } = fixture(t);
  assert.equal(store.snapshot(), null);
  assert.deepEqual(fs.readdirSync(dirPath), []);
});

test('verified browser history initializes once and produces generation-bound proof', t => {
  const { dirPath, store } = fixture(t);
  const history = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];
  initialize(store, history);
  assert.deepEqual(store.snapshot().history, history);
  assert.deepEqual(store.proof('default', 1), {
    ready: true, durable: true, scopeId: 'default', ownerGeneration: 1,
    digest: historyDigest({ scopeId: 'default', generation: 1, history })
  });
  assert.equal(fs.existsSync(path.join(dirPath, 'default.lock')), false);
  assert.throws(() => initialize(store, history), { code: 'TLO_HISTORY_ALREADY_INITIALIZED' });
});

test('mismatched handoff digest creates no conversation record', t => {
  const { dirPath, store } = fixture(t);
  assert.throws(() => store.initialize({ scopeId: 'default', generation: 1, history: [],
    expectedDigest: '0'.repeat(64) }), { code: 'TLO_HISTORY_DIGEST_MISMATCH' });
  assert.equal(store.snapshot(), null);
  assert.deepEqual(fs.readdirSync(dirPath), []);
});

test('prepared and dispatched turn completes into one bounded canonical history', t => {
  const { store } = fixture(t);
  initialize(store);
  const begun = store.beginTurn(turn('question'));
  assert.deepEqual(begun.history, []);
  assert.equal(begun.pending.phase, 'prepared');
  assert.equal(store.proof('default', 1), null);
  store.markDispatched({ generation: 1, requestId: REQUEST });
  const inferred = store.markInferred({ generation: 1, requestId: REQUEST, response: 'answer' });
  assert.equal(inferred.pending.phase, 'inferred');
  const completed = settle(store);
  assert.equal(completed.pending, null);
  assert.deepEqual(completed.history, [
    { role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' }
  ]);
  assert.equal(store.proof('default', 1).ready, true);
});

test('history remains bounded to the same forty-message browser contract', t => {
  const { store } = fixture(t);
  const history = Array.from({ length: MAX_MESSAGES }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: `message ${index}`
  }));
  initialize(store, history);
  store.beginTurn(turn('new user'));
  store.markDispatched({ generation: 1, requestId: REQUEST });
  store.markInferred({ generation: 1, requestId: REQUEST, response: 'new assistant' });
  const completed = settle(store);
  assert.equal(completed.history.length, MAX_MESSAGES);
  assert.deepEqual(completed.history.slice(-2), [
    { role: 'user', content: 'new user' }, { role: 'assistant', content: 'new assistant' }
  ]);
});

test('duplicate or concurrent turns fail without replacing the pending request', t => {
  const { store } = fixture(t);
  initialize(store);
  store.beginTurn(turn('first'));
  assert.throws(() => store.beginTurn(turn('second', 'dex-turn-history-0002')),
  { code: 'TLO_HISTORY_BUSY' });
  assert.equal(store.snapshot().pending.requestId, REQUEST);
});

test('transport uncertainty is durable and blocks completion or new work', t => {
  const { dirPath, store } = fixture(t);
  initialize(store);
  store.beginTurn(turn('question'));
  store.markDispatched({ generation: 1, requestId: REQUEST });
  store.markUnknown({ generation: 1, requestId: REQUEST });
  const reopened = createTloConversationStore({ dirPath });
  assert.equal(reopened.snapshot().pending.phase, 'unknown');
  assert.equal(reopened.proof('default', 1), null);
  assert.throws(() => reopened.markInferred({ generation: 1, requestId: REQUEST, response: 'guess' }),
  { code: 'TLO_HISTORY_TURN_STALE' });
  assert.throws(() => reopened.beginTurn(turn('retry', 'dex-turn-history-0003')),
  { code: 'TLO_HISTORY_BUSY' });
});

test('restart fences prepared and dispatched work without replay', t => {
  const a = fixture(t);
  initialize(a.store);
  a.store.beginTurn(turn('prepared'));
  const reopened = createTloConversationStore({ dirPath: a.dirPath });
  assert.equal(reopened.fenceRestart().pending.phase, 'unknown');

  const b = fixture(t);
  initialize(b.store);
  b.store.beginTurn(turn('dispatched'));
  b.store.markDispatched({ generation: 1, requestId: REQUEST });
  assert.equal(createTloConversationStore({ dirPath: b.dirPath }).fenceRestart().pending.phase, 'unknown');
});

test('idle handoff advances exactly one generation with the expected prior digest', t => {
  const { store } = fixture(t);
  const history = [{ role: 'user', content: 'kept' }];
  initialize(store, history);
  const digest = historyDigest({ scopeId: 'default', generation: 1, history });
  const handoffProof = { status: 'acknowledged', from: { kind: 'browser', id: 'search-monitor-history-0001', generation: 1 },
    to: { kind: 'backend', id: 'tlo-backend-history-0001' }, toGeneration: 2,
    sourceWorkspaceId: 'search-monitor-history-0001', conversationDigest: digest,
    acknowledgedBy: { kind: 'backend', id: 'tlo-backend-history-0001' } };
  store.advanceGeneration({ handoffProof });
  assert.equal(store.proof('default', 1), null);
  assert.equal(store.proof('default', 2).ready, true);
  assert.throws(() => store.advanceGeneration({ handoffProof: { ...handoffProof,
    from: { ...handoffProof.from, generation: 2 }, toGeneration: 4 } }),
  { code: 'TLO_HISTORY_GENERATION_STALE' });
});

test('generation advance rejects self-consistent but unauthenticated migration proof', t => {
  const { store } = fixture(t);
  initialize(store);
  const digest = store.proof('default', 1).digest;
  assert.throws(() => store.advanceGeneration({ handoffProof: { status: 'prepared',
    from: { kind: 'browser', id: 'search-monitor-history-0001', generation: 1 },
    to: { kind: 'backend', id: 'tlo-backend-history-0001' }, toGeneration: 2,
    sourceWorkspaceId: 'search-monitor-history-0001', conversationDigest: digest } }),
  { code: 'TLO_HISTORY_HANDOFF_UNPROVEN' });
  assert.equal(store.snapshot().generation, 1);
});

test('restart preserves inferred response correlation until exact delivery settlement', t => {
  const { dirPath, store } = fixture(t);
  initialize(store);
  store.beginTurn(turn('question'));
  store.markDispatched({ generation: 1, requestId: REQUEST });
  store.markInferred({ generation: 1, requestId: REQUEST, response: 'durable answer' });
  const reopened = createTloConversationStore({ dirPath });
  const pending = reopened.fenceRestart().pending;
  assert.equal(pending.phase, 'inferred');
  assert.equal(pending.requestId, REQUEST);
  assert.equal(pending.dispatchId, CORRELATION.dispatchId);
  assert.throws(() => reopened.beginTurn(turn('replay', 'dex-turn-history-0004')),
    { code: 'TLO_HISTORY_BUSY' });
  settle(reopened);
  assert.equal(reopened.snapshot().pending, null);
  assert.equal(reopened.snapshot().history.at(-1).content, 'durable answer');
});

test('stale generation cannot read proof or mutate conversation', t => {
  const { store } = fixture(t);
  initialize(store, [], 2);
  assert.equal(store.proof('default', 1), null);
  assert.throws(() => store.beginTurn({ ...turn('stale'), generation: 1 }),
  { code: 'TLO_HISTORY_GENERATION_STALE' });
  assert.equal(store.snapshot().pending, null);
});

test('distinct scopes remain isolated', t => {
  const { store } = fixture(t);
  initialize(store, [{ role: 'user', content: 'alpha' }], 1, 'default');
  initialize(store, [{ role: 'user', content: 'beta' }], 1, 'other');
  assert.equal(store.snapshot('default').history[0].content, 'alpha');
  assert.equal(store.snapshot('other').history[0].content, 'beta');
});

test('held lock and corrupt or symlinked records fail closed', t => {
  const a = fixture(t);
  fs.mkdirSync(path.join(a.dirPath, 'default.lock'));
  assert.throws(() => initialize(a.store), { code: 'TLO_HISTORY_LOCKED' });
  assert.throws(() => a.store.proof('default', 1), { code: 'TLO_HISTORY_LOCKED' });
  assert.equal(fs.existsSync(path.join(a.dirPath, 'default.lock')), true);

  const b = fixture(t);
  fs.writeFileSync(path.join(b.dirPath, 'default.json'), '{bad-json');
  assert.throws(() => b.store.snapshot(), { code: 'TLO_HISTORY_CORRUPT' });

  const c = fixture(t);
  const outside = path.join(c.dirPath, 'outside.json');
  fs.writeFileSync(outside, '{}');
  try { fs.symlinkSync(outside, path.join(c.dirPath, 'default.json')); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return; throw error; }
  assert.throws(() => c.store.snapshot(), { code: 'TLO_HISTORY_CORRUPT' });
});
