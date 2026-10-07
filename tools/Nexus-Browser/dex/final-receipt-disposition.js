'use strict';
// Every Dex final the extension outbox delivers needs one terminal answer, or
// the outbox replays it on each heartbeat for its whole TTL. 'pending' keeps
// the retry alive; 'committed' and 'superseded' let the outbox drop it.
// Never replays or re-commits anything: it only reads the snapshot.
function isPending(snapshot, requestId, currentRequestId) {
  if (currentRequestId && currentRequestId === requestId) return true;
  for (const room of snapshot?.rooms || []) {
    if (room?.recovery && (room.recovery.requestId === requestId
        || room.recovery.captureRequestId === requestId)) return true;
    if ((room?.lateFinalWatches || []).some((watch) => watch?.requestId === requestId)) return true;
  }
  return false;
}

function finalDisposition(snapshot, requestId, { currentRequestId = null, findFinalReceipt } = {}) {
  const id = String(requestId || '');
  if (!id.startsWith('dex-')) return null;
  const receipt = typeof findFinalReceipt === 'function' ? findFinalReceipt(snapshot, id) : null;
  if (receipt) return { type: 'dex_turn_receipt', requestId: id,
    messageId: receipt.messageId, roomId: receipt.roomId, state: 'committed' };
  if (isPending(snapshot, id, currentRequestId)) return null;
  return { type: 'dex_turn_receipt', requestId: id, messageId: null, roomId: null,
    state: 'superseded', reason: 'no-pending-turn' };
}

module.exports = { finalDisposition, isPending };
