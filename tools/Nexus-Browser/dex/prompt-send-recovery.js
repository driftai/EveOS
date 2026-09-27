'use strict';
// A failed send is never permission to replay the original Dex request.
// Persist bounded evidence only; never store draft text or prompt contents.
const ATTENTION_MS = 45000;
function classify(detail, requestId) {
  const e = detail?.deliveryEvidence;
  if (!e || e.requestId !== requestId || !['blocked', 'uncertain'].includes(e.phase)
    || typeof e.gestureAttempted !== 'boolean') return 'submission-unknown';
  return e.gestureAttempted ? 'gesture-outcome-unknown' : 'pre-gesture-reported';
}
function noteFailure(recovery, event, requestId, stamp = Date.now()) {
  if (!recovery || event?.code !== 'PROMPT_SEND_FAILED'
    || recovery.requestId !== requestId || !Number.isFinite(stamp)) return false;
  const incoming = classify(event.detail, requestId), prior = recovery.promptSendFailure;
  const rank = { 'submission-unknown': 0, 'pre-gesture-reported': 1, 'gesture-outcome-unknown': 2 };
  const classification = rank[incoming] > rank[prior?.classification]
    ? incoming : (prior?.classification || incoming);
  recovery.promptSendFailure = { code: 'PROMPT_SEND_FAILED', classification,
    observedAtMs: prior?.observedAtMs || stamp, attentionAtMs: prior?.attentionAtMs || null };
  return true;
}
function attentionDue(recovery, stamp = Date.now()) {
  const f = recovery?.promptSendFailure;
  return !!f && !f.attentionAtMs && !recovery.passiveAt
    && Number.isFinite(f.observedAtMs) && stamp - f.observedAtMs >= ATTENTION_MS;
}
function scheduleAttention(recovery, stamp, schedule) {
  const f = recovery?.promptSendFailure;
  if (!f || f.attentionAtMs || typeof schedule !== 'function') return false;
  schedule(Math.max(1, ATTENTION_MS - (stamp - f.observedAtMs)));
  return true;
}
function flagAttention(snapshot, stamp, save, incident) {
  let changed = 0;
  for (const room of snapshot?.rooms || []) {
    const journal = room.recovery;
    if (!attentionDue(journal, stamp)) continue;
    journal.promptSendFailure.attentionAtMs = stamp;
    incident?.({ code: 'PROMPT_SEND_RECOVERY_ATTENTION', roomId: room.id,
      memberId: journal.memberId || null, requestId: journal.requestId,
      source: 'server-scheduler',
      evidence: { classification: journal.promptSendFailure.classification,
        promptResent: false, originalRecoveryHeld: true } });
    changed++;
  }
  if (changed) save(snapshot);
  return changed;
}
function summary(recovery) {
  if (!recovery) return null;
  const f = recovery.promptSendFailure;
  return { heldTurns: Math.max(0, Number(recovery.relayRemaining || 0)),
    requestId: recovery.requestId || null, classification: f?.classification || null,
    attentionRequired: !!f?.attentionAtMs,
    nextStep: recovery.passiveAt ? 'await-passive-archive'
      : f?.attentionAtMs ? 'inspect-exact-bound-tab-no-replay'
        : f ? 'capture-only' : 'standard-recovery' };
}
module.exports = { ATTENTION_MS, classify, noteFailure, attentionDue,
  scheduleAttention, flagAttention, summary };
