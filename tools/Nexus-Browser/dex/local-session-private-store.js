'use strict';
// Server-only private persistence for owner-enrolled local sessions.
// NOT an authorization endpoint. No browser snapshots, public API, or auto-rebind.
const fs = require('node:fs'), path = require('node:path');
const { dataDir } = require('../runtime-config');
const { writeJournal } = require('./post-idle-maintenance');
const { hasInFlight, MAX_ATTEST_AGE_MS } = require('./local-session-rebind-policy');
const FILE = path.join(dataDir(), 'local-session-enrollments.private.json');
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/, HASH = /^[0-9a-f]{64}$/i;
const MAX_RECORDS = 64;
const fail = (code) => ({ ok: false, code });
const valid = (v) => typeof v === 'string' && ID.test(v);
const digest = (v) => typeof v === 'string' && HASH.test(v);
function publicView(record) {
  if (!record) return null;
  const { roomId, memberId, targetId, pid, deviceId, enrolledAt } = record;
  return { roomId, memberId, targetId, pid, deviceId, enrolledAt,
    status: 'enrolled-unverified-current' };
}
function readPrivate(file, io) {
  if (!io.existsSync(file)) return { version: 1, enrollments: [] };
  const data = JSON.parse(io.readFileSync(file, 'utf8'));
  if (data?.version !== 1 || !Array.isArray(data.enrollments)
    || data.enrollments.length > MAX_RECORDS
    || data.enrollments.some(r => !r || !valid(r.roomId) || !valid(r.memberId)
      || !valid(r.targetId) || !valid(r.grantId) || !valid(r.deviceId)
      || !valid(r.processEpoch) || !digest(r.sessionKeyDigest)
      || !digest(r.executableDigest) || !Number.isSafeInteger(r.pid) || r.pid <= 0))
    throw new Error('LOCAL_ENROLLMENT_PRIVATE_JOURNAL_INVALID');
  return data;
}
function openPrivateEnrollmentStore({
  filePath = FILE, io = fs, now = Date.now, getSnapshot = () => null,
  exclusiveLeaseHeld = () => false, privateStorageReady = () => false,
  reverifyOwnerAndNative = () => false
} = {}) {
  // A Windows implementation must separately establish a restrictive ACL
  // before this store becomes writable; Unix file modes are not an ACL proof.
  let ledger = readPrivate(filePath, io);
  function commitVerified(proposal) {
    if (exclusiveLeaseHeld() !== true) return fail('ENROLLMENT_EXCLUSIVE_LEASE_REQUIRED');
    if (privateStorageReady() !== true) return fail('ENROLLMENT_PRIVATE_STORAGE_REQUIRED');
    const stamp = now();
    if (!Number.isFinite(stamp)) return fail('ENROLLMENT_BAD_CLOCK');
    const snapshot = getSnapshot();
    const rooms = (snapshot?.rooms || []).filter(r => r?.id === proposal?.roomId);
    const room = rooms.length === 1 ? rooms[0] : null;
    const members = (room?.members || []).filter(m => m?.id === proposal?.memberId);
    const member = members.length === 1 ? members[0] : null;
    if (!room || !member || hasInFlight(room) || !room.updatedAt
      || room.updatedAt !== proposal.expectedRoomRevision
      || member.binding?.targetClassId !== 'local-origin'
      || member.binding?.targetId !== proposal.targetId
      || member.binding?.providerId !== 'local-antigravity-existing')
      return fail('ENROLLMENT_SNAPSHOT_CHANGED');
    if (![proposal.roomId, proposal.memberId, proposal.targetId, proposal.grantId,
      proposal.deviceId, proposal.processEpoch].every(valid)
      || !Number.isSafeInteger(proposal.pid) || proposal.pid <= 0
      || proposal.targetId !== 'local:antigravity-existing:' + proposal.pid
      || !digest(proposal.sessionKeyDigest) || !digest(proposal.executableDigest)
      || !Number.isFinite(proposal.proofObservedAtMs)
      || proposal.proofObservedAtMs > stamp + 1000
      || stamp - proposal.proofObservedAtMs > MAX_ATTEST_AGE_MS)
      return fail('ENROLLMENT_INVALID_PROPOSAL');
    // The owner grant AND fresh native lock/process proof must be checked
    // again under the same caller-held exclusive state/dispatch lease.
    try {
      if (reverifyOwnerAndNative(proposal) !== true)
        return fail('ENROLLMENT_REATTEST_FAILED');
    } catch { return fail('ENROLLMENT_REATTEST_FAILED'); }
    const sameKey = (r) => r.roomId === proposal.roomId && r.memberId === proposal.memberId;
    const existing = ledger.enrollments.find(sameKey);
    if (existing) {
      const fields = ['targetId', 'pid', 'grantId', 'deviceId', 'processEpoch',
        'sessionKeyDigest', 'executableDigest'];
      return fields.every(key => existing[key] === proposal[key])
        ? { ok: true, deduplicated: true, record: publicView(existing) }
        : fail('ENROLLMENT_CONFLICT_EXPLICIT_REVOKE_REQUIRED');
    }
    if (ledger.enrollments.length >= MAX_RECORDS)
      return fail('ENROLLMENT_CAPACITY_REACHED');
    if (ledger.enrollments.some(r => r.targetId === proposal.targetId
      || (r.deviceId === proposal.deviceId && r.sessionKeyDigest === proposal.sessionKeyDigest)))
      return fail('ENROLLMENT_SESSION_ALREADY_OWNED');
    const record = {
      roomId: proposal.roomId, memberId: proposal.memberId,
      targetId: proposal.targetId, pid: proposal.pid, grantId: proposal.grantId,
      deviceId: proposal.deviceId, processEpoch: proposal.processEpoch,
      sessionKeyDigest: proposal.sessionKeyDigest, executableDigest: proposal.executableDigest,
      enrolledAt: new Date(stamp).toISOString()
    };
    // Only fixed fields are written. Never persist raw conversation IDs,
    // credential tokens, full executable paths, presence paths or caller extras.
    const updated = { version: 1, enrollments: [...ledger.enrollments, record] };
    writeJournal(filePath, updated, io); // Atomic temp + fsync + rename.
    ledger = updated;
    return { ok: true, deduplicated: false, record: publicView(record) };
  }
  const publicStatus = () => ledger.enrollments.map(publicView);
  // Internal only: this record alone is never proof of CURRENT session identity.
  const privateForPolicy = (roomId, memberId) => {
    const r = ledger.enrollments.find(x => x.roomId === roomId && x.memberId === memberId);
    return r ? { ...r } : null;
  };
  return { commitVerified, publicStatus, privateForPolicy };
}
module.exports = { FILE, MAX_RECORDS, publicView, readPrivate, openPrivateEnrollmentStore };
