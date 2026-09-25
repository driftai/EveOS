'use strict';
const { createPostIdleMaintenance } = require('./post-idle-maintenance');
// The durable journal and its polling timer share one owner, not the WebSocket router.
function startPostIdleMaintenance({
  dexStateStore, providerControlRouting, providerTargetSpawnRouting,
  dexScheduler, localTargets, serverLocalRelay, serverSessionId,
  onError = (error) => console.error('[bridge] post-idle tick:', error)
}) {
  const maintenance = createPostIdleMaintenance({
    getState: () => dexStateStore.load(),
    hasPendingControls: () => providerControlRouting.pending.size > 0
      || providerTargetSpawnRouting.pending.size > 0,
    hasActiveTurn: () => !!dexScheduler.diagnostics().current,
    getTarget: (id) => localTargets.getLocalTarget(id),
    getTargetStatus: (id) => localTargets.getLocalTargetStatus(id),
    sendPrompt: (task) => serverLocalRelay.sendLocalPrompt(task),
    serverSessionId
  });
  const timer = setInterval(() => maintenance.tick().catch(onError), 1000);
  timer.unref?.();
  return maintenance;
}
module.exports = { startPostIdleMaintenance };
