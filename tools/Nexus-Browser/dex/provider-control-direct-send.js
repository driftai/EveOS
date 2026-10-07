'use strict';
// Route authenticated room SEND directly into localhost's durable FIFO. Online-Origin
// sends must first correlate to the exact durable control origin; authenticated
// Local-Origin unsolicited sends intentionally remain originless-capable.
const mailbox = require('./recovery-mailbox');
const binding = require('../public/dex-members');
const controlReceipt = require('./provider-control-receipt');
const MAX_ORIGIN_WAIT_MS = 4 * 60 * 1000;
const ORIGIN_POLL_MS = 250;
const isOnlineOrigin = (source = {}) => String(source.targetClassId || '').trim().toLowerCase() === 'online-origin';
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function settleOrigin({ source, command, requestId }, { getState, now, sleep = defaultSleep }) {
  let snapshot = getState();
  let origin = controlReceipt.findIntent(snapshot, source, command);
  if (origin || !isOnlineOrigin(source)) return { origin: origin || null };
  const active = controlReceipt.activeSourceTurn(snapshot, source);
  if (!active) return { error: {
    code: 'DEX_CONTROL_ORIGIN_REQUIRED',
    message: 'Online-Origin state-changing provider-control requires an exact durable control origin; no message was enqueued.'
  } };
  if (active.ambiguous) return { error: {
    code: 'DEX_CONTROL_ORIGIN_AMBIGUOUS',
    message: 'Dex found more than one active relay turn for this provider-control source; refusing to enqueue without a unique origin.'
  } };
  const deadline = now() + MAX_ORIGIN_WAIT_MS;
  while (now() < deadline) {
    await sleep(ORIGIN_POLL_MS);
    snapshot = getState();
    origin = controlReceipt.findIntentInRoom(snapshot, active.roomId, source, command);
    if (origin) return { origin };
    const current = controlReceipt.activeSourceTurn(snapshot, source);
    const sameTurn = current && !current.ambiguous
      && current.roomId === active.roomId
      && (!active.requestId || !current.requestId || current.requestId === active.requestId);
    if (!sameTurn) return { error: {
      code: 'DEX_CONTROL_ORIGIN_UNCORRELATED',
      message: 'The relay turn settled without recording this Online-Origin send. Dex refused to enqueue it because the originating turn could not be correlated.'
    } };
  }
  return { error: {
    code: 'DEX_CONTROL_ORIGIN_TIMEOUT',
    message: `The Online-Origin send arrived before relay turn ${active.requestId || requestId || 'unknown'} finalized. Dex waited for exact origin correlation and refused to enqueue after timeout.`
  } };
}
async function route({ source, command, requestId, ws }, {
  getState, saveState, broadcastState, getScheduler, now,
  sendResult, commitOriginReceipt, sleep
}) {
  const settled = await settleOrigin({ source, command, requestId }, { getState, now, sleep });
  if (settled.error) {
    sendResult({ sourceSocket: ws, requestId, source }, { ok: false, ...settled.error }, null);
    return true;
  }
  const origin = settled.origin;
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
module.exports = { MAX_ORIGIN_WAIT_MS, ORIGIN_POLL_MS, isOnlineOrigin, settleOrigin, route };
