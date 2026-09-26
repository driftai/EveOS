'use strict';
// Durable deadline wake prevents silent capture/transport stalls from pinning a room.
function remainingMs(journal, stamp, ceilingMs) {
  const started = Date.parse(journal?.interruptedAt || journal?.startedAt || '');
  return Number.isFinite(started) ? Math.max(0, started + ceilingMs - stamp) : null;
}
function createRecoveryLiveness({
  load, save, nowMs, schedule, ceilingMs, findRoom, expire, clearActive,
  onInvalid = () => {}
}) {
  function arm(journal) {
    const left = remainingMs(journal, nowMs(), ceilingMs);
    schedule(left == null ? 1 : Math.max(1, left + 1));
  }
  function check(worker, snapshot = load()) {
    const room = findRoom(snapshot, worker.roomId), journal = room?.recovery;
    if (!journal || journal.requestId !== worker.requestId || journal.passiveAt) {
      clearActive(); schedule(0); return false;
    }
    const left = remainingMs(journal, nowMs(), ceilingMs);
    if (left == null) onInvalid(room, journal);
    if (left == null || left === 0) {
      expire(room, journal); save(snapshot); clearActive(); return false;
    }
    arm(journal);
    return false;
  }
  return { arm, check, remainingMs };
}
module.exports = { remainingMs, createRecoveryLiveness };
