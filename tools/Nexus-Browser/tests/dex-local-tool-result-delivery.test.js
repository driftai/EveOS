'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createDeliveryService } = require('../dex/local-tool-result-delivery');
const journal = require('../dex/local-tool-result-journal');
const binding = { targetClassId: 'local-origin',
  targetId: 'local:antigravity-existing:25032', providerId: 'local-antigravity-existing' };
function fixture() {
  const room = { id: 'room-one', relay: { active: false },
    members: [{ id: 'astro', binding }], messages: [{
      id: 'agent-one', senderKind: 'agent', senderId: 'astro' }] };
  const intent = { roomId: room.id, executorMemberId: 'astro',
    executorTarget: binding, agentMessageId: 'agent-one', turnRequestId: 'dex-turn-one' };
  journal.queue(room, intent, { ok: true, message: 'Accepted.',
    data: { commitState: 'committed', deliveryState: 'queued' } }, 'ctrl-one');
  let current = { rooms: [room] }, writes = 0, sends = 0, held = true, idle = true;
  const record = { roomId: room.id, memberId: 'astro', targetId: binding.targetId,
    pid: 25032, deviceId: 'device-one', processEpoch: 'epoch-one',
    sessionKeyDigest: 'a'.repeat(64), executableDigest: 'b'.repeat(64) };
  const proof = { verified: true, uniqueLockOwnerCount: 1, lockOwnerPid: record.pid,
    deviceId: record.deviceId, processEpoch: record.processEpoch,
    sessionKeyDigest: record.sessionKeyDigest, executableDigest: record.executableDigest,
    observedAtMs: 1000 };
  const callbacks = { load: () => structuredClone(current),
    save: s => { current = structuredClone(s); writes++; },
    privateEnrollment: () => record, attestNative: async () => proof,
    inspectNativeIdle: async () => idle,
    sendNative: async () => { sends++; return { ok: true, accepted: true,
      pid: record.pid, processEpoch: record.processEpoch }; },
    exclusiveLeaseHeld: () => held, globallyQuiescent: () => true,
    noActiveSignedJobs: () => true, now: () => 1000 };
  return { callbacks, room, record, proof,
    get state() { return current; }, get writes() { return writes; },
    get sends() { return sends; }, setHeld: v => { held = v; },
    setIdle: v => { idle = v; } };
}
const call = s => createDeliveryService(s.callbacks)
  .deliverOne({ roomId: 'room-one', requestId: 'ctrl-one' });
test('one native notification has one durable pre-send claim and explicit submitted-not-read ACK', async () => {
  const s = fixture(), result = await call(s);
  assert.equal(result.state, 'submitted-not-read');
  assert.equal(s.writes, 2);
  assert.equal(s.sends, 1);
  assert.equal(s.state.rooms[0].localToolResults[0].state, 'submitted-not-read');
  assert.equal((await call(s)).code, 'DEX_LOCAL_RESULT_ALREADY_CLAIMED');
  assert.equal(s.sends, 1);
});
test('no owner enrollment, fresh attestation or verified native idle means zero terminal writes', async () => {
  const s = fixture();
  s.callbacks.privateEnrollment = () => null;
  assert.equal((await call(s)).code, 'DEX_LOCAL_RESULT_NOT_ENROLLED');
  s.callbacks.privateEnrollment = () => s.record;
  s.callbacks.attestNative = async () => ({ ...s.proof, processEpoch: 'wrong' });
  assert.equal((await call(s)).code, 'DEX_LOCAL_RESULT_SESSION_MISMATCH');
  s.callbacks.attestNative = async () => s.proof;
  s.setIdle(false);
  assert.equal((await call(s)).code, 'DEX_LOCAL_RESULT_IDLE_UNVERIFIED');
  assert.equal(s.writes, 0); assert.equal(s.sends, 0);
});
test('unverified lease, active recovery, stale PID and active other room all fail closed', async () => {
  const s = fixture();
  s.setHeld(false);
  assert.equal((await call(s)).code, 'DEX_LOCAL_RESULT_LEASE_BUSY');
  s.setHeld(true);
  s.callbacks.attestNative = async () => ({ ...s.proof, lockOwnerPid: 25033 });
  assert.equal((await call(s)).code, 'DEX_LOCAL_RESULT_SESSION_MISMATCH');
  s.callbacks.attestNative = async () => s.proof;
  const oldSave = s.callbacks.save;
  s.callbacks.save = state => { state.rooms[0].recovery = { requestId: 'live' };
    oldSave(state); };
  assert.equal((await call(s)).state, 'outcome-unknown');
  assert.equal(s.sends, 0);
  assert.equal((await call(s)).code, 'DEX_LOCAL_RESULT_ALREADY_CLAIMED');
});
test('stale session and occupied terminal arising after the durable claim suppress native send', async () => {
  const s = fixture();
  let probes = 0;
  s.callbacks.attestNative = async () => ++probes === 1
    ? s.proof : { ...s.proof, processEpoch: 'another-process' };
  assert.equal((await call(s)).state, 'outcome-unknown');
  assert.equal(s.sends, 0);
  assert.equal(s.writes, 2);
  const separate = fixture();
  let inspections = 0;
  separate.callbacks.inspectNativeIdle = async () => ++inspections === 1;
  assert.equal((await call(separate)).state, 'outcome-unknown');
  assert.equal(separate.sends, 0);
});
test('unknown native submission is marked durably and never retried automatically', async () => {
  const s = fixture();
  s.callbacks.sendNative = async () => { throw Error('lost terminal ACK'); };
  const r = await call(s);
  assert.equal(r.state, 'outcome-unknown');
  assert.equal(s.writes, 2);
  assert.equal((await call(s)).code, 'DEX_LOCAL_RESULT_ALREADY_CLAIMED');
});
test('failed claim persistence forbids any native I/O', async () => {
  const s = fixture();
  s.callbacks.save = () => { throw Error('disk unavailable'); };
  assert.equal((await call(s)).code, 'DEX_LOCAL_RESULT_CLAIM_NOT_DURABLE');
  assert.equal(s.sends, 0);
});
test('exact callback ACK must include the enrolled PID and process epoch', async () => {
  const s = fixture();
  s.callbacks.sendNative = async () => { return { ok: true, accepted: true,
    pid: 25033, processEpoch: 'epoch-one' }; };
  assert.equal((await call(s)).state, 'outcome-unknown');
});
test('another busy room bound to the same target blocks notification', async () => {
  const s = fixture();
  const originalLoad = s.callbacks.load;
  s.callbacks.load = () => { const v = originalLoad();
    v.rooms.push({ id: 'another', members: [{ binding }], recovery: { requestId: 'active' } });
    return v; };
  assert.equal((await call(s)).code, 'DEX_LOCAL_RESULT_TARGET_BUSY_ELSEWHERE');
  assert.equal(s.sends, 0);
});
