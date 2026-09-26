'use strict';
// Route authenticated room SEND directly into localhost's durable FIFO. Never
// wait for an older relay's final receipt just to admit a new message.
const mailbox = require('./recovery-mailbox');
function route({ source, command, requestId, ws }, {
  getState, saveState, broadcastState, getScheduler, now,
  sendResult, commitOriginReceipt, findOrigin
}) {
  const snapshot = getState();
  const origin = findOrigin(snapshot, source, command) || null;
  const queued = mailbox.queueRoomSend(snapshot, {
    source, command, requestId, at: new Date(now()).toISOString()
  });
  if (!queued) {
    const result = { ok: false, code: 'DEX_ROOM_NOT_BOUND_OR_AMBIGUOUS',
      message: 'Specify exactly one room bound to this authenticated source. No message was enqueued.' };
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
