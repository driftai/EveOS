'use strict';
// INTERNAL proposal only. Native owner consent and exclusive-lock evidence are
// supplied by independent trusted broker callbacks; no room state is mutated.
const { hasInFlight, SESSION, MAX_ATTEST_AGE_MS } = require('./local-session-rebind-policy');
const DIGEST = /^[a-f0-9]{64}$/i, ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const TARGET = /^local:antigravity-existing:([1-9]\d*)$/;
const fail = (code) => ({ ok: false, code });
function proposeEnrollment({
  snapshot, roomId, memberId, verifyOwnerGrant, attest, target,
  dispatchQuiescent, hasActiveJobs, nowMs = Date.now()
} = {}) {
  if (typeof verifyOwnerGrant !== 'function' || typeof attest !== 'function')
    return fail('ENROLLMENT_TRUSTED_BROKER_REQUIRED');
  if (dispatchQuiescent !== true || hasActiveJobs !== false || !Number.isFinite(nowMs))
    return fail('ENROLLMENT_NOT_QUIESCENT');
  const matchingRooms = (snapshot?.rooms || []).filter(r => r.id === roomId);
  if (matchingRooms.length !== 1 || hasInFlight(matchingRooms[0]))
    return fail('ENROLLMENT_ROOM_BUSY_OR_AMBIGUOUS');
  const room = matchingRooms[0], members = (room.members || []).filter(m => m.id === memberId);
  if (members.length !== 1) return fail('ENROLLMENT_MEMBER_AMBIGUOUS');
  const binding = members[0].binding || {}, match = TARGET.exec(String(binding.targetId || ''));
  const pid = match ? Number(match[1]) : null;
  if (binding.targetClassId !== 'local-origin' || binding.providerId !== SESSION
    || !Number.isSafeInteger(pid) || pid < 1
    || target?.id !== binding.targetId || target?.providerId !== SESSION
    || target?.targetClassId !== 'local-origin' || target?.pid !== pid)
    return fail('ENROLLMENT_TARGET_MISMATCH');
  // Existing shared local targets need explicit owner coordination. Never
  // silently enroll an identity shared by another room or member.
  const otherOwner = (snapshot.rooms || []).some(r => (r.members || []).some(m =>
    (r.id !== roomId || m.id !== memberId)
      && m.binding?.targetClassId === 'local-origin'
      && m.binding?.targetId === binding.targetId));
  if (otherOwner) return fail('ENROLLMENT_SHARED_TARGET');
  let grant;
  try { grant = verifyOwnerGrant({ roomId, memberId, targetId: target.id,
    operation: 'enroll-local-session', pid }); }
  catch { return fail('ENROLLMENT_OWNER_DENIED'); }
  if (grant?.approved !== true || !ID.test(String(grant.grantId || ''))
    || grant.roomId !== roomId || grant.memberId !== memberId
    || grant.targetId !== target.id || grant.operation !== 'enroll-local-session')
    return fail('ENROLLMENT_OWNER_DENIED');
  let proof;
  try { proof = attest({ target, grantId: grant.grantId }); }
  catch { return fail('ENROLLMENT_ATTESTATION_FAILED'); }
  if (proof?.verified !== true || proof.providerId !== SESSION
    || proof.targetId !== target.id || proof.lockOwnerPid !== pid
    || proof.uniqueLockOwnerCount !== 1 || !ID.test(String(proof.deviceId || ''))
    || !ID.test(String(proof.processEpoch || ''))
    || !DIGEST.test(String(proof.sessionKeyDigest || ''))
    || !DIGEST.test(String(proof.executableDigest || ''))
    || !Number.isFinite(proof.observedAtMs)
    || proof.observedAtMs > nowMs + 1000
    || nowMs - proof.observedAtMs > MAX_ATTEST_AGE_MS)
    return fail('ENROLLMENT_IDENTITY_UNPROVEN');
  // The attestor computes a device-secret-keyed digest. Never store the raw
  // conversation ID, lock path, user profile path, or private broker secret.
  return { ok: true, proposal: Object.freeze({
    roomId, memberId, targetId: target.id, pid, grantId: grant.grantId,
    deviceId: proof.deviceId, processEpoch: proof.processEpoch,
    sessionKeyDigest: proof.sessionKeyDigest, executableDigest: proof.executableDigest,
    proofObservedAtMs: proof.observedAtMs,
    expectedRoomRevision: room.updatedAt || null
  }) };
}
module.exports = { proposeEnrollment };
