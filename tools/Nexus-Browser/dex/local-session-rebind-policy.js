'use strict';
// INTERNAL planning gate only: the native broker must attest live lock ownership.
// This module does not probe OS processes, mutate rooms, or grant source authority.
const HEX = /^[0-9a-f]{64}$/i;
const SESSION = 'local-antigravity-existing';
const MAX_ATTEST_AGE_MS = 10000;
function fail(code, detail) { return { ok: false, code, detail }; }
function one(items, predicate) {
  const matches = (Array.isArray(items) ? items : []).filter(predicate);
  return matches.length === 1 ? matches[0] : null;
}
function hasInFlight(room) {
  return !!(room?.relay?.active || room?.relay?.waitingFor || room?.pendingTurn
    || room?.recovery || room?.pendingProviderControlReceipt || room?.deferredRelays?.length);
}
function proposeRebind({
  snapshot, roomId, memberId, enrollment, candidate,
  attest, dispatchQuiescent, hasActiveJobs, nowMs = Date.now()
} = {}) {
  // All arguments except immutable references must originate in trusted server
  // state/native discovery. Do not expose this helper directly to content scripts.
  if (!dispatchQuiescent || hasActiveJobs !== false)
    return fail('REBOUND_NOT_QUIESCENT', 'Active/unknown dispatch or signed jobs forbid rebind.');
  if (typeof attest !== 'function') return fail('REBOUND_ATTESTOR_REQUIRED', 'Trusted native attestor absent.');
  if (!Number.isFinite(nowMs)) return fail('REBOUND_BAD_CLOCK', 'Trusted time unavailable.');
  const room = one(snapshot?.rooms, (r) => r?.id === roomId);
  const member = one(room?.members, (m) => m?.id === memberId);
  if (!room || !member || hasInFlight(room))
    return fail('REBOUND_ROOM_BUSY_OR_AMBIGUOUS', 'Room/member missing, ambiguous or busy.');
  const binding = member.binding || {};
  if (binding.targetClassId !== 'local-origin' || binding.providerId !== SESSION
    || !/^local:antigravity-existing:[1-9]\d*$/.test(String(binding.targetId || '')))
    return fail('REBOUND_BAD_BINDING', 'Original process is not an enrolled existing Antigravity target.');
  const oldPid = Number(String(binding.targetId).split(':').at(-1));
  if (!Number.isSafeInteger(oldPid)) return fail('REBOUND_BAD_BINDING', 'Original PID is invalid.');
  if (!enrollment || enrollment.roomId !== roomId || enrollment.memberId !== memberId
    || enrollment.targetId !== binding.targetId || enrollment.pid !== oldPid
    || !HEX.test(String(enrollment.sessionKeyDigest || ''))
    || !HEX.test(String(enrollment.executableDigest || ''))
    || !enrollment.deviceId || !enrollment.processEpoch)
    return fail('REBOUND_NO_ENROLLMENT', 'Original owner-approved native enrollment missing or mismatched.');
  if (!candidate || candidate.providerId !== SESSION || candidate.targetClassId !== 'local-origin'
    || !Number.isSafeInteger(candidate.pid) || candidate.pid <= 0
    || candidate.pid === oldPid
    || candidate.id !== 'local:antigravity-existing:' + candidate.pid)
    return fail('REBOUND_BAD_CANDIDATE', 'Candidate must be a distinct exact native target.');
  const rooms = snapshot.rooms || [];
  for (const otherRoom of rooms) {
    for (const other of otherRoom.members || []) {
      if (otherRoom.id === roomId && other.id === memberId) continue;
      if (other.binding?.targetClassId === 'local-origin'
        && other.binding?.providerId === SESSION
        && (other.binding?.targetId === binding.targetId || other.binding?.targetId === candidate.id))
        return fail('REBOUND_SHARED_BINDING', 'Another room member owns or shares the existing/candidate session.');
    }
  }
  let proof;
  try { proof = attest({ candidate, oldBinding: binding, enrollment }); }
  catch { return fail('REBOUND_ATTESTATION_FAILED', 'Native attestation could not complete.'); }
  if (!proof || proof.verified !== true || proof.deviceId !== enrollment.deviceId
    || proof.sessionKeyDigest !== enrollment.sessionKeyDigest
    || proof.executableDigest !== enrollment.executableDigest
    || proof.providerId !== SESSION || proof.targetId !== candidate.id
    || proof.lockOwnerPid !== candidate.pid || proof.uniqueLockOwnerCount !== 1
    || proof.oldPidAlive !== false
    || !proof.processEpoch || proof.processEpoch === enrollment.processEpoch
    || !Number.isFinite(proof.observedAtMs)
    || proof.observedAtMs > nowMs + 1000
    || nowMs - proof.observedAtMs > MAX_ATTEST_AGE_MS)
    return fail('REBOUND_IDENTITY_UNPROVEN', 'Exclusive lock, unique process or fresh identity not proven.');
  // This plan is NOT an authorization token. Caller must acquire the durable
  // state lock, reattest, check current target/revision/jobs, and commit atomically.
  return { ok: true, plan: Object.freeze({
    roomId, memberId, oldTargetId: binding.targetId, newTargetId: candidate.id,
    oldPid, newPid: candidate.pid, oldProcessEpoch: enrollment.processEpoch,
    newProcessEpoch: proof.processEpoch, expectedRoomRevision: room.updatedAt || null,
    deviceId: enrollment.deviceId, proofObservedAtMs: proof.observedAtMs
  }) };
}
module.exports = { SESSION, MAX_ATTEST_AGE_MS, hasInFlight, proposeRebind };
