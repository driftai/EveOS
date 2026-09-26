'use strict';
// Passive recovery may be detached only after the capture window AND a bounded
// late-final grace period. Detaching never retries the original prompt.
const protocol = require('../public/dex-protocol');
const stateApi = require('./server-scheduler-state');
const PASSIVE_GRACE_MS = 2 * 60 * 1000;
const LATE_FINAL_WATCH_MS = 24 * 60 * 60 * 1000;
function keepWatch(room, recovery, stamp, reason = 'passive-timeout') {
  const old = room.lateFinalWatches || [];
  if (old.some((entry) => entry.requestId === recovery.requestId)) return false;
  room.lateFinalWatches = [...old, {
    requestId: recovery.requestId, memberId: recovery.memberId,
    sourceMessageId: recovery.sourceMessageId, dispatched: !!recovery.dispatched,
    archivedAt: new Date(stamp).toISOString(),
    expiresAt: new Date(stamp + LATE_FINAL_WATCH_MS).toISOString(), reason
  }].slice(-32);
  return true;
}
function maintain(snapshot, stamp = Date.now()) {
  let changed = false, nextDelay = null;
  for (const room of snapshot.rooms || []) {
    const recovery = room.recovery;
    if (recovery && !room.relay?.active && !room.relay?.waitingFor && !room.pendingTurn) {
      const committed = (room.finalReceipts || []).some((entry) => entry.requestId === recovery.requestId);
      if (committed) {
        delete room.recovery;
        room.relay.lastStopReason = 'Already committed turn reconciled without replay';
        changed = true;
      } else if (recovery.passiveAt) {
        const parsed = Date.parse(recovery.passiveAt);
        if (!Number.isFinite(parsed)) continue; // Corrupt timestamp: fail closed.
        const remain = parsed + PASSIVE_GRACE_MS - stamp;
        if (remain <= 0) {
          keepWatch(room, recovery, stamp);
          delete room.recovery;
          room.relay.lastStopReason = 'Passive recovery archived; late final accepted by exact request ID only';
          changed = true;
        } else nextDelay = nextDelay == null ? remain : Math.min(nextDelay, remain);
      }
    }
    const existing = room.lateFinalWatches || [];
    const unexpired = existing.filter((watch) =>
      Number.isFinite(Date.parse(watch.expiresAt)) && Date.parse(watch.expiresAt) > stamp);
    if (unexpired.length !== existing.length) {
      room.lateFinalWatches = unexpired; changed = true;
    }
  }
  return { changed, nextDelay };
}
function acceptLateFinal(snapshot, event, {
  stamp = Date.now(), addMessage = stateApi.addMessage
} = {}) {
  if (event?.type !== 'response_final' || !event.requestId) return false;
  // A previously committed exact request remains terminal across duplicate
  // transport deliveries even after its late-final watch is consumed.
  if (stateApi.findFinalReceipt(snapshot, event.requestId)) return true;
  const room = (snapshot.rooms || []).find((r) =>
    (r.lateFinalWatches || []).some((w) => w.requestId === event.requestId));
  if (!room) return false;
  const watch = room.lateFinalWatches.find((w) => w.requestId === event.requestId);
  const parsed = protocol.parseAgentReply(event.text || '');
  if (parsed.returnRequestId && parsed.returnRequestId !== watch.requestId) return true;
  const body = protocol.cleanText(parsed.text);
  if (!body) return true;
  const member = stateApi.memberById(room, watch.memberId);
  const message = addMessage(room, {
    id: 'late-' + watch.requestId, at: new Date(stamp).toISOString(),
    senderKind: 'system', senderId: null, senderName: 'Dex',
    text: 'Late response from ' + (member?.name || 'agent')
      + ' for interrupted turn ' + watch.requestId
      + ' (archived without relay):\n' + body
  });
  stateApi.rememberFinalReceipt(room, watch.requestId, message.id, new Date(stamp).toISOString());
  room.lateFinalWatches = room.lateFinalWatches.filter((w) => w.requestId !== watch.requestId);
  // Intentionally do not run commands, DONE handlers or relay disposition on
  // an archived result. A newer unrelated turn may be in progress.
  return true;
}
module.exports = {
  PASSIVE_GRACE_MS, LATE_FINAL_WATCH_MS, keepWatch, maintain, acceptLateFinal
};
