'use strict';
// NOT WIRED TO A LIVE WORKER. Native result notification must be claimed
// durably before the first terminal write. Failure/unknown ACK never replays.
const journal = require('./local-tool-result-journal');
const MAX_EVIDENCE_MS = 10000;
const fail = (code) => ({ ok: false, code });
const same = (left, right) => String(left ?? '') === String(right ?? '');
function proofMatches(record, proof, request, stamp) {
  if (!record || !proof || proof.verified !== true || !Number.isFinite(stamp)
    || !Number.isFinite(proof.observedAtMs)
    || proof.observedAtMs > stamp + 1000
    || stamp - proof.observedAtMs > MAX_EVIDENCE_MS
    || proof.uniqueLockOwnerCount !== 1
    || proof.lockOwnerPid !== record.pid
    || !Number.isSafeInteger(record.pid) || record.pid < 1
    || !same(record.targetId, request.targetId)
    || !same(record.deviceId, proof.deviceId)
    || !same(record.processEpoch, proof.processEpoch)
    || !same(record.sessionKeyDigest, proof.sessionKeyDigest)
    || !same(record.executableDigest, proof.executableDigest)) return false;
  return request.targetId === 'local:antigravity-existing:' + record.pid
    && record.roomId === request.roomId && record.memberId === request.memberId;
}
function targetBusyElsewhere(snapshot, roomId, targetId) {
  return (snapshot?.rooms || []).some(room => room?.id !== roomId
    && (room.members || []).some(member => member?.binding?.targetClassId === 'local-origin'
      && String(member?.binding?.targetId || '') === targetId)
    && (room.recovery || room.pendingTurn || room.relay?.active || room.relay?.waitingFor));
}
function createDeliveryService({
  load, save, privateEnrollment, attestNative, inspectNativeIdle,
  sendNative, exclusiveLeaseHeld, globallyQuiescent, noActiveSignedJobs,
  now = Date.now, onStatus = () => {}
} = {}) {
  if ([load, save, privateEnrollment, attestNative, inspectNativeIdle, sendNative,
    exclusiveLeaseHeld, globallyQuiescent, noActiveSignedJobs].some(fn => typeof fn !== 'function'))
    throw new TypeError('All delivery callbacks must be provided by the trusted localhost service.');
  async function deliverOne({ roomId, requestId } = {}) {
    if (exclusiveLeaseHeld() !== true || globallyQuiescent() !== true
      || noActiveSignedJobs() !== true) return fail('DEX_LOCAL_RESULT_LEASE_BUSY');
    const snapshot = load();
    const matches = (snapshot?.rooms || []).filter(room => room?.id === roomId);
    if (matches.length !== 1) return fail('DEX_LOCAL_RESULT_BAD_ROOM');
    const room = matches[0], events = (room.localToolResults || []).filter(e => e?.requestId === requestId);
    if (events.length !== 1) return fail('DEX_LOCAL_RESULT_NOT_UNIQUE');
    const entry = events[0];
    if (entry.state !== 'queued') return fail('DEX_LOCAL_RESULT_ALREADY_CLAIMED');
    if (targetBusyElsewhere(snapshot, roomId, entry.targetId))
      return fail('DEX_LOCAL_RESULT_TARGET_BUSY_ELSEWHERE');
    const request = { roomId, memberId: entry.memberId, targetId: entry.targetId,
      providerId: entry.providerId, requestId, turnRequestId: entry.turnRequestId };
    const enrolled = privateEnrollment(roomId, entry.memberId);
    if (!enrolled || enrolled.targetId !== entry.targetId)
      return fail('DEX_LOCAL_RESULT_NOT_ENROLLED');
    let proof;
    try { proof = await attestNative(request, enrolled); }
    catch { return fail('DEX_LOCAL_RESULT_ATTEST_FAILED'); }
    if (!proofMatches(enrolled, proof, request, now()))
      return fail('DEX_LOCAL_RESULT_SESSION_MISMATCH');
    let ready;
    try { ready = await inspectNativeIdle(request, proof); }
    catch { return fail('DEX_LOCAL_RESULT_IDLE_UNVERIFIED'); }
    if (ready !== true || exclusiveLeaseHeld() !== true || globallyQuiescent() !== true
      || noActiveSignedJobs() !== true)
      return fail('DEX_LOCAL_RESULT_IDLE_UNVERIFIED');
    // Re-read the durable room state under the held dispatch lease. The native
    // caller must separately enforce this SAME lease in the scheduler.
    const latest = load(), current = (latest?.rooms || []).find(r => r?.id === roomId);
    if (!current || targetBusyElsewhere(latest, roomId, entry.targetId))
      return fail('DEX_LOCAL_RESULT_STATE_CHANGED');
    const claimed = journal.claim(current, requestId, {
      memberId: entry.memberId, targetId: entry.targetId,
      providerId: entry.providerId, verifiedSession: true, nativeIdle: true
    });
    if (!claimed.ok) return claimed;
    // Crash-safe boundary: if saving the claim fails, DO NOT touch native I/O.
    try { save(latest); }
    catch { return fail('DEX_LOCAL_RESULT_CLAIM_NOT_DURABLE'); }
    let ack;
    try {
      if (exclusiveLeaseHeld() !== true || globallyQuiescent() !== true
        || noActiveSignedJobs() !== true)
        throw new Error('Lost native dispatch lease after durable claim.');
      ack = await sendNative({ ...request, attemptId: claimed.entry.deliveryAttemptId,
        text: claimed.entry.text, pid: enrolled.pid, processEpoch: enrolled.processEpoch,
        notificationKind: 'dex-tool-result' });
    } catch { ack = null; }
    const accepted = ack?.ok === true && ack?.accepted === true
      && ack?.pid === enrolled.pid && ack?.processEpoch === enrolled.processEpoch;
    const latestAck = load(), roomAck = (latestAck?.rooms || []).find(r => r?.id === roomId);
    const settled = journal.acknowledge(roomAck, requestId, {
      attemptId: claimed.entry.deliveryAttemptId, exactNativeAck: accepted
    });
    if (!settled.ok) return fail('DEX_LOCAL_RESULT_ACK_STATE_MISMATCH');
    try { save(latestAck); }
    catch { return fail('DEX_LOCAL_RESULT_ACK_NOT_DURABLE'); }
    try { onStatus({ roomId, requestId, state: settled.state }); } catch {}
    return { ok: accepted, code: accepted ? 'DEX_LOCAL_RESULT_SUBMITTED_NOT_READ'
      : 'DEX_LOCAL_RESULT_OUTCOME_UNKNOWN', state: settled.state, requestId };
  }
  return { deliverOne };
}
module.exports = { MAX_EVIDENCE_MS, proofMatches, targetBusyElsewhere, createDeliveryService };
