'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTloDexLedgerGate } = require('../dex/tlo-dex-ledger-gate');
const { createTloOwnershipFence } = require('../dex/tlo-ownership-fence');
const { createDurableTloOwnershipStore } = require('../dex/tlo-ownership-durable-store');
const { createServerDurability } = require('../dex/server-durability');
const { createTurnLedger } = require('../dex/turn-ledger');
const OWNER = { kind: 'browser', id: 'search-monitor-test-owner', generation: 1 };
const ARGS = { scopeId: 'default', owner: OWNER, requestId: 'dex-turn-test-001',
  roomId: 'room-12345678', sourceMessageId: 'msg-12345678' };
const META = { targetClassId: 'local-origin', targetId: 'local:tlo-chat:default', providerId: 'tlo-chat' };
const RECEIPT = { confirmed: true, requestId: ARGS.requestId, roomId: ARGS.roomId,
  sourceMessageId: ARGS.sourceMessageId, finalRequestId: 'dex-final-12345678', responseMessageId: 'msg-final-12345678' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve3d-b2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ownership = createDurableTloOwnershipStore({ dirPath: path.join(dir, 'owners') });
  const ownerFence = createTloOwnershipFence(ownership);
  ownerFence.claimInitialBrowser({ scopeId: 'default', workspaceId: OWNER.id });
  const turnLedger = createTurnLedger({ filePath: path.join(dir, 'turns.jsonl') });
  const durability = createServerDurability({ ledger: turnLedger,
    incidents: { record() {}, stats() { return {}; } } });
  let authenticated = true;
  let receipt = { ...RECEIPT };
  const gate = createTloDexLedgerGate({ ownerFence, queryDexLedger: id => durability.query(id),
    validateDexSource: args => authenticated && args.roomId === ARGS.roomId && args.sourceMessageId === ARGS.sourceMessageId,
    verifyDexFinalReceipt: () => receipt });
  return { dir, ownerFence, gate, durability, turnLedger,
    setAuthenticated: v => { authenticated = v; }, setReceipt: v => { receipt = v; } };
}
async function admit(f, id = ARGS.requestId, meta = META) {
  return f.durability.beforeDispatch({ type: 'send_prompt', requestId: id }, meta);
}
async function dispatch(f) {
  assert.equal((await admit(f)).ok, true);
  f.gate.reserveAdmitted(ARGS);
  f.gate.markBeforeTransport(ARGS);
}
test('importing gate is source-only and requires trusted callbacks', () => {
  assert.throws(() => createTloDexLedgerGate({}), TypeError);
  assert.equal(typeof createTloDexLedgerGate, 'function');
});
test('cannot reserve TLO before authoritative Dex admission', t => {
  const f=fixture(t);
  assert.throws(() => f.gate.reserveAdmitted(ARGS), { code: 'TLO_LEDGER_NOT_PROVEN' });
  assert.equal(f.ownerFence.snapshot().state.turn, null);
});
test('unreliable dispatch ledger prevents reservation', t => {
  const f=fixture(t);
  const gate=createTloDexLedgerGate({ownerFence:f.ownerFence,queryDexLedger:()=>({reliable:false}),validateDexSource:()=>true,verifyDexFinalReceipt:()=>RECEIPT});
  assert.throws(() => gate.reserveAdmitted(ARGS), {code:'TLO_LEDGER_UNRELIABLE'});
});
test('untrusted Dex source message cannot reserve a turn', async t => {
  const f=fixture(t); await admit(f); f.setAuthenticated(false);
  assert.throws(() => f.gate.reserveAdmitted(ARGS), {code:'TLO_LEDGER_SOURCE_UNVERIFIED'});
  assert.equal(f.ownerFence.snapshot().state.turn, null);
});
test('wrong provider binding is never accepted as TLO', async t => {
  const f=fixture(t); await admit(f, ARGS.requestId, {...META,providerId:'other-agent'});
  assert.throws(() => f.gate.reserveAdmitted(ARGS), {code:'TLO_LEDGER_NOT_PROVEN'});
});
test('existing completed dispatch cannot be used to reserve again', async t => {
  const f=fixture(t); await admit(f); await f.durability.observe({ type:'response_final',requestId:ARGS.requestId },META);
  assert.throws(() => f.gate.reserveAdmitted(ARGS), {code:'TLO_LEDGER_BAD_STATE'});
});
test('real Dex durability admission gates one owner-fenced transport boundary', async t => {
  const f=fixture(t); await dispatch(f);
  assert.equal(f.ownerFence.snapshot().state.turn.phase, 'dispatched');
  assert.equal(f.turnLedger.entry(ARGS.requestId).dispatchAttempts, 1);
  assert.equal((await admit(f)).ok, false);
  assert.throws(() => f.gate.markBeforeTransport(ARGS), {code:'TLO_TURN_STALE'});
});
test('wrong owner generation cannot reserve or dispatch', async t => {
  const f=fixture(t); await admit(f);
  assert.throws(() => f.gate.reserveAdmitted({...ARGS,owner:{...OWNER,generation:2}}),{code:'TLO_OWNER_STALE'});
  f.gate.reserveAdmitted(ARGS);
  assert.throws(() => f.gate.markBeforeTransport({...ARGS,owner:{...OWNER,generation:2}}),{code:'TLO_OWNER_STALE'});
});
test('ledger state changing before transport stops the operation', async t => {
  const f=fixture(t); await admit(f); f.gate.reserveAdmitted(ARGS);
  await f.durability.observe({type:'response_final',requestId:ARGS.requestId},META);
  assert.throws(() => f.gate.markBeforeTransport(ARGS),{code:'TLO_LEDGER_BAD_STATE'});
  assert.equal(f.ownerFence.snapshot().state.turn.phase, 'admitted');
});
test('final receipt requires ledger completion and exact source proof', async t => {
  const f=fixture(t); await dispatch(f);
  assert.throws(() => f.gate.settleAuthoritative(ARGS),{code:'TLO_LEDGER_BAD_STATE'});
  await f.durability.observe({type:'response_final',requestId:ARGS.requestId},META);
  f.setReceipt({...RECEIPT,sourceMessageId:'msg-other-12345678'});
  assert.throws(() => f.gate.settleAuthoritative(ARGS),{code:'TLO_LEDGER_RECEIPT_UNVERIFIED'});
  assert.equal(f.ownerFence.snapshot().state.turn.phase,'dispatched');
});
test('a verified Dex journal final settles a dispatched turn', async t => {
  const f=fixture(t); await dispatch(f);
  await f.durability.observe({type:'response_final',requestId:ARGS.requestId},META);
  f.gate.settleAuthoritative(ARGS);
  assert.equal(f.ownerFence.snapshot().state.turn,null);
  assert.throws(() => f.gate.settleAuthoritative(ARGS),{code:'TLO_TURN_STALE'});
});
test('transport uncertainty seals the turn against further dispatch', async t => {
  const f=fixture(t); await dispatch(f); f.gate.markUncertain(ARGS);
  assert.equal(f.ownerFence.snapshot().state.turn.phase,'unknown');
  assert.throws(() => f.gate.reserveAdmitted(ARGS),{code:'TLO_OWNER_BUSY'});
});
test('owner fence and Dex ledger survive separate store instances without replay', async t => {
  const f=fixture(t); await dispatch(f);
  const reopened=createTloOwnershipFence(createDurableTloOwnershipStore({dirPath:path.join(f.dir,'owners')}));
  reopened.fenceRestart();
  assert.equal(reopened.snapshot().state.turn.phase,'unknown');
  assert.equal(f.turnLedger.entry(ARGS.requestId).dispatchAttempts,1);
  assert.equal((await admit(f)).ok,false);
});

test('unauthorized actor cannot mark an admitted transport uncertain', async t => {
  const f=fixture(t); await dispatch(f); f.setAuthenticated(false);
  assert.throws(() => f.gate.markUncertain(ARGS),{code:'TLO_LEDGER_SOURCE_UNVERIFIED'});
  assert.equal(f.ownerFence.snapshot().state.turn.phase,'dispatched');
});
