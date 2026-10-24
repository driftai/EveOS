'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServerLocalRelay } = require('../dex/server-local-relay');
const { createTloBackendOwnershipSeam, BACKEND_TRANSPORT } = require('../dex/tlo-backend-ownership-seam');
const { createTloDexLedgerGate, TLO_TARGET, TLO_PROVIDER } = require('../dex/tlo-dex-ledger-gate');
const { createTloOwnershipFence } = require('../dex/tlo-ownership-fence');
const { createDurableTloOwnershipStore } = require('../dex/tlo-ownership-durable-store');
const { createServerDurability } = require('../dex/server-durability');
const { createTurnLedger } = require('../dex/turn-ledger');
const { createTloDispatchCapabilityBroker } = require('../dex/tlo-dispatch-capability');

const OWNER = { kind: 'backend', id: 'tlo-backend-owner-test', generation: 2 };
const TARGET = { id: TLO_TARGET, providerId: TLO_PROVIDER, transport: BACKEND_TRANSPORT };
const META = { targetClassId: 'local-origin', targetId: TLO_TARGET, providerId: TLO_PROVIDER };
const HASH = 'a'.repeat(64);
let sequence = 0;

function ids(label = 'main') {
  sequence += 1;
  const suffix = `${label}-${String(sequence).padStart(4, '0')}`;
  const requestId = `dex-turn-${suffix}`;
  return {
    requestId,
    correlation: {
      roomId: `room-${suffix}`,
      turnId: requestId,
      requestId,
      sourceMessageId: `msg-source-${suffix}`
    }
  };
}

function fixture(t, { active = true, scopeId = 'default', owner = OWNER, history = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve3d-b3-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createDurableTloOwnershipStore({ dirPath: path.join(dir, 'owners') });
  const ownerFence = createTloOwnershipFence(store);
  ownerFence.claimInitialBrowser({ scopeId: 'default', workspaceId: 'search-monitor-owner-test' });
  const handoffSecret = 'backend-seam-handoff-secret-0001';
  const prepared = ownerFence.prepareHandoff({ scopeId: 'default',
    from: { kind: 'browser', id: 'search-monitor-owner-test', generation: 1 },
    to: { kind: 'backend', id: OWNER.id }, conversationDigest: HASH,
    sourceWorkspaceId: 'search-monitor-owner-test', acknowledgementSecret: handoffSecret });
  const handoffId = prepared.handoff.id;
  ownerFence.acknowledgeHandoff({ scopeId: 'default', handoffId,
    to: { kind: 'backend', id: OWNER.id }, acknowledgementSecret: handoffSecret });
  ownerFence.completeHandoff({ scopeId: 'default', handoffId,
    from: { kind: 'browser', id: 'search-monitor-owner-test', generation: 1 } });

  const turnLedger = createTurnLedger({ filePath: path.join(dir, 'turns.jsonl') });
  const durability = createServerDurability({ ledger: turnLedger,
    incidents: { record() {}, stats() { return {}; } } });
  const sources = new Map();
  const receipts = new Map();
  const gate = createTloDexLedgerGate({
    ownerFence,
    queryDexLedger: (requestId) => durability.query(requestId),
    validateDexSource(args) {
      const source = sources.get(args.requestId);
      return !!source && source.roomId === args.roomId && source.sourceMessageId === args.sourceMessageId;
    },
    verifyDexFinalReceipt: (args) => receipts.get(args.requestId) || null
  });
  const seam = createTloBackendOwnershipSeam({
    active,
    ledgerGate: gate,
    dispatchCapabilities: createTloDispatchCapabilityBroker(),
    owner,
    scopeId,
    conversationProof: ({ scopeId: proofScope }) => history ? {
      ready: true,
      durable: true,
      scopeId: proofScope,
      ownerGeneration: owner.generation,
      digest: HASH
    } : null,
    settleConversation() {}
  });

  async function admit(identity) {
    sources.set(identity.requestId, {
      roomId: identity.correlation.roomId,
      sourceMessageId: identity.correlation.sourceMessageId
    });
    return durability.beforeDispatch({ type: 'send_prompt', requestId: identity.requestId }, META);
  }

  async function observe(identity, payload) {
    await durability.observe(payload, META);
    if (payload.type === 'response_final') {
      receipts.set(identity.requestId, {
        confirmed: true,
        requestId: identity.requestId,
        roomId: identity.correlation.roomId,
        sourceMessageId: identity.correlation.sourceMessageId,
        finalRequestId: `dex-final-${identity.requestId}`,
        responseMessageId: `msg-final-${identity.requestId}`
      });
    }
  }

  return { dir, store, ownerFence, gate, seam, durability, turnLedger, sources, receipts, admit, observe };
}

function relayFor(f, sendLocalPrompt, target = TARGET) {
  return createServerLocalRelay({
    tloBackendOwnership: f.seam,
    localTargets: {
      async getLocalTarget() { return target; },
      sendLocalPrompt
    }
  });
}

async function runFinal(f, identity, sendLocalPrompt) {
  assert.equal((await f.admit(identity)).ok, true);
  const relay = relayFor(f, sendLocalPrompt || (async ({ emit }) => {
    emit({ type: 'prompt_accepted', requestId: identity.requestId });
    emit({ type: 'response_final', requestId: identity.requestId, text: 'done' });
  }));
  await relay.sendLocalPrompt({ targetId: TLO_TARGET, requestId: identity.requestId,
    text: 'hello', correlation: identity.correlation,
    emit: (payload) => f.observe(identity, payload) });
}

test('default-inert seam leaves the existing browser TLO path untouched', async () => {
  const calls = [];
  const gate = Object.fromEntries(['reserveAdmitted', 'markBeforeTransport', 'markUncertain',
    'settleAuthoritative', 'readOnlyStatus'].map((key) => [key, () => { throw new Error(`unexpected ${key}`); }]));
  const seam = createTloBackendOwnershipSeam({ active: false, ledgerGate: gate,
    dispatchCapabilities: createTloDispatchCapabilityBroker(), owner: OWNER,
    conversationProof: () => { throw new Error('unexpected proof'); }, settleConversation() {} });
  const relay = createServerLocalRelay({ tloBackendOwnership: seam, localTargets: {
    async getLocalTarget() { return { ...TARGET, transport: 'search-monitor-workspace' }; },
    async sendLocalPrompt({ requestId, emit }) {
      calls.push(requestId);
      emit({ type: 'response_final', requestId, text: 'browser result' });
    }
  } });
  await relay.sendLocalPrompt({ targetId: TLO_TARGET, requestId: 'dex-turn-inert-0001', text: 'x', emit() {} });
  assert.deepEqual(calls, ['dex-turn-inert-0001']);
});

test('admitted backend turn settles only after Dex journal and final receipt commit', async t => {
  const f = fixture(t);
  const identity = ids('settle');
  await runFinal(f, identity);
  assert.equal(f.turnLedger.entry(identity.requestId).state, 'completed');
  assert.equal(f.ownerFence.snapshot().state.turn, null);
});

test('a completed request cannot be dispatched again through the backend seam', async t => {
  const f = fixture(t);
  const identity = ids('duplicate');
  await runFinal(f, identity);
  let sends = 0;
  const relay = relayFor(f, async () => { sends += 1; });
  await assert.rejects(relay.sendLocalPrompt({ targetId: TLO_TARGET, requestId: identity.requestId,
    text: 'duplicate', correlation: identity.correlation, emit() {} }),
  { code: 'TLO_LEDGER_BAD_STATE' });
  assert.equal(sends, 0);
  assert.equal(f.turnLedger.entry(identity.requestId).dispatchAttempts, 1);
});

test('current browser transport cannot be redirected through an active backend owner', async t => {
  const f = fixture(t);
  const identity = ids('browser');
  await f.admit(identity);
  let sends = 0;
  const relay = relayFor(f, async () => { sends += 1; }, { ...TARGET, transport: 'search-monitor-workspace' });
  await assert.rejects(relay.sendLocalPrompt({ targetId: TLO_TARGET, requestId: identity.requestId,
    text: 'x', correlation: identity.correlation, emit() {} }), { code: 'TLO_BACKEND_TRANSPORT_REQUIRED' });
  assert.equal(sends, 0);
  assert.equal(f.ownerFence.snapshot().state.turn, null);
});

test('exact TLO target with a different provider cannot bypass the active seam', async t => {
  const f = fixture(t);
  const identity = ids('provider');
  await f.admit(identity);
  let sends = 0;
  const relay = relayFor(f, async () => { sends += 1; }, { ...TARGET, providerId: 'other-provider' });
  await assert.rejects(relay.sendLocalPrompt({ targetId: TLO_TARGET, requestId: identity.requestId,
    text: 'x', correlation: identity.correlation, emit() {} }), { code: 'TLO_BACKEND_PROVIDER_MISMATCH' });
  assert.equal(sends, 0);
  assert.equal(f.ownerFence.snapshot().state.turn, null);
});

test('durable conversation proof is mandatory before reservation', async t => {
  const f = fixture(t, { history: false });
  const identity = ids('history');
  await f.admit(identity);
  let sends = 0;
  const relay = relayFor(f, async () => { sends += 1; });
  await assert.rejects(relay.sendLocalPrompt({ targetId: TLO_TARGET, requestId: identity.requestId,
    text: 'x', correlation: identity.correlation, emit() {} }), { code: 'TLO_BACKEND_HISTORY_UNPROVEN' });
  assert.equal(sends, 0);
  assert.equal(f.ownerFence.snapshot().state.turn, null);
});

test('stale backend generation is rejected before transport', async t => {
  const f = fixture(t, { owner: { ...OWNER, generation: 3 } });
  const identity = ids('stale');
  await f.admit(identity);
  await assert.rejects(relayFor(f, async () => {}).sendLocalPrompt({ targetId: TLO_TARGET,
    requestId: identity.requestId, text: 'x', correlation: identity.correlation, emit() {} }),
  { code: 'TLO_BACKEND_OWNER_STALE' });
  assert.equal(f.ownerFence.snapshot().state.turn, null);
});

test('concurrent backend dispatches in one scope send only the admitted owner turn', async t => {
  const f = fixture(t);
  const first = ids('parallel-a'), second = ids('parallel-b');
  await f.admit(first); await f.admit(second);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let sends = 0;
  const relay = relayFor(f, async ({ requestId, emit }) => {
    sends += 1; started(); await blocked;
    emit({ type: 'response_final', requestId, text: 'done' });
  });
  const firstRun = relay.sendLocalPrompt({ targetId: TLO_TARGET, requestId: first.requestId,
    text: 'first', correlation: first.correlation, emit: (payload) => f.observe(first, payload) });
  await entered;
  await assert.rejects(relay.sendLocalPrompt({ targetId: TLO_TARGET, requestId: second.requestId,
    text: 'second', correlation: second.correlation, emit: (payload) => f.observe(second, payload) }),
  { code: 'TLO_OWNER_BUSY' });
  assert.equal(sends, 1);
  release(); await firstRun;
  assert.equal(f.ownerFence.snapshot().state.turn, null);
});

test('transport failure becomes outcome-unknown and is never retried', async t => {
  const f = fixture(t);
  const identity = ids('failure');
  await f.admit(identity);
  let sends = 0;
  const relay = relayFor(f, async () => { sends += 1; throw Object.assign(new Error('lost'), { code: 'LINK_LOST' }); });
  await assert.rejects(relay.sendLocalPrompt({ targetId: TLO_TARGET, requestId: identity.requestId,
    text: 'x', correlation: identity.correlation, emit() {} }), { code: 'LINK_LOST' });
  assert.equal(sends, 1);
  assert.equal(f.ownerFence.snapshot().state.turn.phase, 'unknown');
  await assert.rejects(relay.sendLocalPrompt({ targetId: TLO_TARGET, requestId: identity.requestId,
    text: 'x', correlation: identity.correlation, emit() {} }), { code: 'TLO_OWNER_BUSY' });
  assert.equal(sends, 1);
});

test('transport return without final receipt becomes outcome-unknown', async t => {
  const f = fixture(t);
  const identity = ids('nofinal');
  await f.admit(identity);
  const relay = relayFor(f, async ({ emit }) => {
    emit({ type: 'prompt_accepted', requestId: identity.requestId });
  });
  await assert.rejects(relay.sendLocalPrompt({ targetId: TLO_TARGET, requestId: identity.requestId,
    text: 'x', correlation: identity.correlation, emit: (payload) => f.observe(identity, payload) }),
  { code: 'TLO_BACKEND_FINAL_MISSING' });
  assert.equal(f.ownerFence.snapshot().state.turn.phase, 'unknown');
});

test('mismatched transport event cannot settle another request', async t => {
  const f = fixture(t);
  const identity = ids('mismatch');
  await f.admit(identity);
  const relay = relayFor(f, async ({ emit }) => {
    emit({ type: 'response_final', requestId: 'dex-turn-wrong-9999', text: 'wrong' });
  });
  await assert.rejects(relay.sendLocalPrompt({ targetId: TLO_TARGET, requestId: identity.requestId,
    text: 'x', correlation: identity.correlation, emit() {} }), { code: 'TLO_BACKEND_EVENT_MISMATCH' });
  assert.equal(f.ownerFence.snapshot().state.turn.phase, 'unknown');
});

test('cross-scope owner state cannot authorize the default backend', async t => {
  const f = fixture(t, { scopeId: 'alternate' });
  const identity = ids('scope');
  await f.admit(identity);
  await assert.rejects(relayFor(f, async () => {}).sendLocalPrompt({ targetId: TLO_TARGET,
    requestId: identity.requestId, text: 'x', correlation: identity.correlation, emit() {} }),
  { code: 'TLO_BACKEND_OWNER_STALE' });
  assert.equal(f.ownerFence.snapshot('alternate').state.turn, null);
});

test('restart preserves an unknown turn and blocks a new request', async t => {
  const f = fixture(t);
  const first = ids('restart-a');
  await f.admit(first);
  await assert.rejects(relayFor(f, async () => { throw new Error('process lost'); }).sendLocalPrompt({
    targetId: TLO_TARGET, requestId: first.requestId, text: 'x', correlation: first.correlation, emit() {}
  }));
  const reopenedFence = createTloOwnershipFence(createDurableTloOwnershipStore({
    dirPath: path.join(f.dir, 'owners')
  }));
  assert.equal(reopenedFence.fenceRestart().turn.phase, 'unknown');
  const second = ids('restart-b');
  await f.admit(second);
  const reopenedGate = createTloDexLedgerGate({ ownerFence: reopenedFence,
    queryDexLedger: (requestId) => f.durability.query(requestId),
    validateDexSource: (args) => f.sources.get(args.requestId)?.roomId === args.roomId,
    verifyDexFinalReceipt: (args) => f.receipts.get(args.requestId) || null });
  const seam = createTloBackendOwnershipSeam({ active: true, ledgerGate: reopenedGate, owner: OWNER,
    dispatchCapabilities: createTloDispatchCapabilityBroker(),
    conversationProof: () => ({ ready: true, durable: true, scopeId: 'default',
      ownerGeneration: 2, digest: HASH }), settleConversation() {} });
  const relay = createServerLocalRelay({ tloBackendOwnership: seam, localTargets: {
    async getLocalTarget() { return TARGET; }, async sendLocalPrompt() { throw new Error('must not send'); }
  } });
  await assert.rejects(relay.sendLocalPrompt({ targetId: TLO_TARGET, requestId: second.requestId,
    text: 'x', correlation: second.correlation, emit() {} }), { code: 'TLO_OWNER_BUSY' });
});

test('exact Dex room and source correlation is mandatory', async t => {
  const f = fixture(t);
  const identity = ids('source');
  await f.admit(identity);
  const wrong = { ...identity.correlation, sourceMessageId: 'msg-source-other-9999' };
  await assert.rejects(relayFor(f, async () => {}).sendLocalPrompt({ targetId: TLO_TARGET,
    requestId: identity.requestId, text: 'x', correlation: wrong, emit() {} }),
  { code: 'TLO_LEDGER_SOURCE_UNVERIFIED' });
  assert.equal(f.ownerFence.snapshot().state.turn, null);
});
