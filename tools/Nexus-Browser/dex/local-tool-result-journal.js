'use strict';
// Durable one-shot LOCAL-ORIGIN tool-result handoff. This module never sends a
// native prompt: the caller must persist each claim BEFORE an attested delivery.
const { createHash, randomUUID } = require('node:crypto');
const { formatResult } = require('../extension/dex-tool-result');
const MAX_RESULTS = 32, ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const fail = (code) => ({ ok: false, code });
function matchingLocal(room, intent) {
  const binding = intent?.executorTarget || {};
  if (binding.targetClassId !== 'local-origin' || !ID.test(String(binding.targetId || ''))
    || !ID.test(String(binding.providerId || ''))) return null;
  const members = (room?.members || []).filter(m => m.id === intent.executorMemberId
    && m.binding?.targetClassId === 'local-origin'
    && m.binding?.providerId === binding.providerId
    && String(m.binding?.targetId) === String(binding.targetId));
  return members.length === 1 ? members[0] : null;
}
function queue(room, intent, result, requestId, stamp = new Date().toISOString()) {
  if (intent?.executorTarget?.targetClassId !== 'local-origin') return { ok: true, skipped: true };
  if (!room || room.id !== intent.roomId || !ID.test(String(requestId || ''))
    || !ID.test(String(intent?.turnRequestId || ''))
    || !ID.test(String(intent?.agentMessageId || ''))
    || !matchingLocal(room, intent)
    || !(room.messages || []).some(m => m.id === intent.agentMessageId
      && m.senderId === intent.executorMemberId))
    return fail('DEX_LOCAL_RECEIPT_UNBOUND');
  const text = formatResult(result, requestId);
  const resultDigest = createHash('sha256').update(text).digest('hex');
  const events = room.localToolResults = Array.isArray(room.localToolResults) ? room.localToolResults : [];
  const previous = events.find(e => e.requestId === requestId);
  if (previous) return previous.resultDigest === resultDigest
    ? { ok: true, deduplicated: true, record: previous }
    : fail('DEX_LOCAL_RECEIPT_ID_CONFLICT');
  if (events.length >= MAX_RESULTS) return fail('DEX_LOCAL_RECEIPT_BACKPRESSURE');
  const b = intent.executorTarget;
  const entry = { requestId, roomId: room.id, memberId: intent.executorMemberId,
    agentMessageId: intent.agentMessageId, turnRequestId: intent.turnRequestId,
    targetId: String(b.targetId), providerId: b.providerId, resultDigest,
    text, state: 'queued', at: stamp, claimedAt: null, deliveryAttemptId: null };
  events.push(entry);
  return { ok: true, changed: true, record: entry };
}
function claim(room, requestId, {
  memberId, targetId, providerId, verifiedSession, nativeIdle,
  attemptId = randomUUID(), stamp = new Date().toISOString()
} = {}) {
  if (!room || !ID.test(String(requestId || ''))) return fail('DEX_LOCAL_RECEIPT_BAD_ID');
  const entry = (room.localToolResults || []).find(e => e.requestId === requestId);
  if (!entry) return fail('DEX_LOCAL_RECEIPT_NOT_FOUND');
  if (entry.state !== 'queued') return fail('DEX_LOCAL_RECEIPT_ALREADY_CLAIMED');
  if (room.recovery || room.pendingTurn || room.relay?.active || room.relay?.waitingFor
    || nativeIdle !== true || verifiedSession !== true)
    return fail('DEX_LOCAL_RECEIPT_TARGET_NOT_SAFE');
  if (entry.roomId !== room.id || entry.memberId !== memberId
    || entry.targetId !== targetId || entry.providerId !== providerId
    || !ID.test(String(attemptId || ''))
    || !matchingLocal(room, { executorMemberId: memberId,
      executorTarget: { targetClassId: 'local-origin', targetId, providerId } }))
    return fail('DEX_LOCAL_RECEIPT_IDENTITY_MISMATCH');
  entry.state = 'claimed';
  entry.claimedAt = stamp;
  entry.deliveryAttemptId = attemptId;
  return { ok: true, entry };
}
function acknowledge(room, requestId, { attemptId, exactNativeAck, stamp = new Date().toISOString() } = {}) {
  const entry = (room?.localToolResults || []).find(e => e.requestId === requestId);
  if (!entry || entry.state !== 'claimed' || entry.deliveryAttemptId !== attemptId)
    return fail('DEX_LOCAL_RECEIPT_ACK_MISMATCH');
  entry.state = exactNativeAck === true ? 'submitted-not-read' : 'outcome-unknown';
  entry.ackAt = stamp;
  return { ok: true, state: entry.state };
}
function status(room) {
  return (room?.localToolResults || []).map(({ requestId, targetId, state, at }) =>
    ({ requestId, targetId, state, at }));
}
module.exports = { MAX_RESULTS, matchingLocal, queue, claim, acknowledge, status };
