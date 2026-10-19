'use strict';
// Runs after boot and periodically. No own mutation authority: only invokes
// the narrowly defined state policy when no provider/execution lease is live.
const { reconcileDormant } = require('./stale-room-work');
function startStaleRoomSweeper({ stateStore, broadcast = () => {},
  hasPendingControls = () => false, maintenanceBusy = () => false,
  hasActiveTurn = () => false, machineTargetsBusy = () => false,
  log = console.log, startDelayMs = 12000, intervalMs = 60000,
  setTimeoutImpl = setTimeout, setIntervalImpl = setInterval } = {}) {
  let sweeping = false;
  function sweep() {
    if (sweeping || hasPendingControls() || maintenanceBusy()
      || hasActiveTurn() || machineTargetsBusy()) return { skipped: true };
    sweeping = true;
    try {
      const original = stateStore?.load?.();
      if (!original) return { skipped: true };
      const result = reconcileDormant(original);
      if (!result.changed) return { changed: false };
      const saved = stateStore.save(result.snapshot);
      broadcast(saved);
      log(`[bridge] stale-room-maintenance retired ${result.events.length} records (no commands dispatched)`);
      return { changed: true, events: result.events };
    } catch (error) {
      log(`[bridge] stale-room-maintenance refused: ${String(error?.message || error).slice(0, 180)}`);
      return { changed: false, error: true };
    } finally { sweeping = false; }
  }
  const first = setTimeoutImpl(sweep, startDelayMs);
  first?.unref?.();
  const timer = setIntervalImpl(sweep, intervalMs);
  timer?.unref?.();
  return { sweep };
}
module.exports = { startStaleRoomSweeper };
