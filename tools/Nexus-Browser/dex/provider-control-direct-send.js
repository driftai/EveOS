'use strict';
// Route an authenticated room SEND directly into localhost's durable FIFO.
// Online-Origin callers must pass an already-settled durable control origin;
// authenticated Local-Origin unsolicited sends intentionally pass origin=null.
const mailbox = require('./recovery-mailbox');
const binding = require('../public/dex-members');
function route({ source, command, requestId, ws, origin = null }, {
  getState, saveState, broadcastState, getScheduler, now,
  sendResult, commitOriginReceipt
}) {
  const snapshot = getState();
  const queued = mailbox.queueRoomSend(snapshot, {
    source, command, requestId, at: new Date(now()).toISOString()
  });
  if (!queued) {
    const stale = binding.staleRoomCount(snapshot.rooms, source, command.room) > 0;
    const result = { ok: false,
      code: stale ? 'DEX_ROOM_STALE_BINDING' : 'DEX_ROOM_NOT_BOUND_OR_AMBIGUOUS',
      message: stale ? 'Outdated tab ID or chat URL; explicitly rebind Eve in the existing room. No message was enqueued.'
        : 'Specify exactly one room bound to this authenticated source. No message was enqueued.' };
    const receipt = commitOriginReceipt(origin, result, requestId);
    sendResult({ sourceSocket: ws, requestId, source }, result, receipt);
    return true;
  }
  if (queued.changed) {
    // Store the new source and stable request ID before invoking a worker.
    queued.snapshot.savedAt = new Date(now()).toISOString();
    let saved;
    try { saved = saveState(queued.snapshot); }
    catch {
      const uncertain = { ok: false, code: 'DEX_INBOX_COMMIT_UNCERTAIN',
        message: 'Durable inbox write could not be confirmed. Inspect the same request ID before any retry; do not send a new ID.' };
      sendResult({ sourceSocket: ws, requestId, source }, uncertain, null);
      return true;
    }
    // A viewer socket failure cannot roll back or silently retry a committed send.
    try { broadcastState?.(saved); } catch {}
    try { getScheduler?.()?.onStateChanged?.(); } catch {}
  }
  const receipt = commitOriginReceipt(origin, queued.result, requestId);
  sendResult({ sourceSocket: ws, requestId, source }, queued.result, receipt);
  return true;
}
module.exports = { route };
