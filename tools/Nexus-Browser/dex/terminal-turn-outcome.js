'use strict';
// Read-only projection of the exact source message's Dex outcome. New receipts
// carry sourceMessageId; legacy outcomes are matched only when unambiguous.
function failure(code, message) { return { ok: false, code, message }; }
const bounded = (value, n = 1800) => String(value || '').slice(0, n);

function stateFor(room = {}, requestId, live = null) {
  const messages = Array.isArray(room.messages) ? room.messages : [];
  const originals = messages.map((m, i) => ({ m, i }))
    .filter(({ m }) => m.senderKind === 'user' && m.clientRequestId === requestId);
  if (originals.length !== 1) return failure('DEX_TERMINAL_UNKNOWN_REQUEST',
    'Exactly one committed user message is required for this request ID.');
  const { m: origin, i: originIndex } = originals[0];
  const members = new Set((room.members || []).filter(m => m.relayEnabled !== false).map(m => m.id));
  const receipts = Array.isArray(room.finalReceipts) ? room.finalReceipts : [];
  const base = { ok: true, requestId, roomId: room.id, messageId: origin.id,
    recoveryPending: !!room.recovery, relayActive: !!room.relay?.active,
    lastStopReason: bounded(room.relay?.lastStopReason, 120) };
  const nextUserIndex = messages.findIndex((m, i) => i > originIndex && m.senderKind === 'user');
  const segment = messages.slice(originIndex + 1, nextUserIndex < 0 ? undefined : nextUserIndex);
  const exact = receipts.filter(r => r.sourceMessageId === origin.id);
  if (exact.length > 1) return failure('DEX_TERMINAL_RECEIPT_CONFLICT',
    'More than one final receipt references this exact source message.');
  let receipt = exact[0] || null;
  let reply = receipt ? messages.find(m => m.id === receipt.messageId && m.senderKind === 'agent' && members.has(m.senderId)) : null;
  if (receipt && !reply) return failure('DEX_TERMINAL_RECEIPT_UNVERIFIABLE',
    'Final receipt exists, but its authorized agent message is unavailable.');
  let olderUnresolved = false;
  if (!receipt) {
    // Earlier unresolved user requests could own a later reply. Old receipts
    // cannot prove which user message initiated a reply after that gap.
    const priorUserIndices = messages.slice(0, originIndex)
      .map((m, i) => m.senderKind === 'user' ? i : -1).filter(i => i >= 0);
    olderUnresolved = priorUserIndices.some(i => {
      const next = messages.findIndex((m, k) => k > i && m.senderKind === 'user');
      const previousSegment = messages.slice(i + 1, next < 0 ? undefined : next);
      return !previousSegment.some(m => m.senderKind === 'agent'
        && receipts.some(r => r.messageId === m.id))
        && !previousSegment.some(m => m.senderKind === 'system' && m.senderName === 'Dex'
          && /^[^:\n]{1,80}:\s+[A-Z][A-Z0-9_]+:/.test(String(m.text || '')));
    });
    // Legacy receipts without source identity: use only a bounded segment,
    // and never infer an association when an older request is unsettled.
    reply = !olderUnresolved && segment.find(m => m.senderKind === 'agent' && members.has(m.senderId) &&
      receipts.some(r => !r.sourceMessageId && r.messageId === m.id)) || null;
    if (reply) receipt = receipts.find(r => r.messageId === reply.id);
  }
  if (receipt && reply) return { ...base, status: 'FINAL_RECEIPT_CONFIRMED',
    finalRequestId: receipt.requestId || null,
    response: { id: reply.id, at: reply.at || null, text: bounded(reply.text) } };

  const exactFailure = messages.find(m => m.senderKind === 'system' && m.relayFailure === true && m.sourceMessageId === origin.id);
  const legacyFailure = segment.find(m => m.senderKind === 'system' && m.senderName === 'Dex'
    && /^[^:\n]{1,80}:\s+[A-Z][A-Z0-9_]+:/.test(String(m.text || '')));
  const failed = exactFailure || legacyFailure;
  if (failed) {
    const match = String(failed.text || '').match(/^[^:\n]{1,80}:\s+([A-Z][A-Z0-9_]+):\s*([\s\S]*)$/);
    return { ...base, status: 'TURN_FAILED', code: match?.[1] || 'DEX_RELAY_FAILED',
      message: bounded(match?.[2] || failed.text),
      failure: { id: failed.id, at: failed.at || null, turnRequestId: failed.turnRequestId || null } };
  }

  // Keep a visible response distinct from a final receipt. It is not safe to
  // attribute one when an earlier message is unresolved or its exact final
  // receipt belongs to a different source.
  const unconfirmed = !olderUnresolved && segment.find(m => m.senderKind === 'agent'
    && members.has(m.senderId)
    && !receipts.some(r => r.messageId === m.id && r.sourceMessageId && r.sourceMessageId !== origin.id));
  if (unconfirmed) return { ...base, status: 'REPLY_OBSERVED_NOT_FINAL',
    finalRequestId: null,
    response: { id: unconfirmed.id, at: unconfirmed.at || null, text: bounded(unconfirmed.text) } };

  const queued = room.pendingTurn?.sourceMessageId === origin.id;
  const recovering = room.recovery?.sourceMessageId === origin.id;
  const active = live?.sourceMessageId === origin.id && live?.roomId === room.id;
  const progress = recovering ? (room.recovery.dispatched ? 'generating-or-recovering' : 'dispatching')
    : queued ? 'queued' : active ? 'generating' : 'not-active';
  const partialText = active ? bounded(live.partialText) : '';
  // A momentarily idle relay is not proof that admission or dispatch ended.
  // Report an unknown outcome only when there is affirmative stop evidence.
  const stopped = typeof room.relay?.lastStopReason === 'string'
    && !!room.relay.lastStopReason.trim()
    && !/^(Idle|Running)$/i.test(room.relay.lastStopReason.trim());
  if (!queued && !recovering && !active && !room.relay?.active && stopped) {
    return { ...base, status: 'TURN_OUTCOME_UNKNOWN',
      code: 'DEX_TERMINAL_NO_AUTHORITATIVE_OUTCOME',
      message: 'The turn is no longer active and has no correlated success/failure receipt. Inspect its exact ID; do not resend.' };
  }
  return { ...base, status: 'AWAITING_REPLY_OR_RECOVERY', progress, partialText,
    turnRequestId: recovering ? room.recovery.requestId || null : active ? live.requestId || null : null };
}
module.exports = { stateFor };
