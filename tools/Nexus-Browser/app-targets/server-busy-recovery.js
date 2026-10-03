'use strict';

function isBusyRecoveryCommand(msg = {}) {
  return msg.type === 'recover_app_target_busy' && msg.targetClassId === 'app-origin';
}

async function handleBusyRecovery({ ws, msg, targetId, appTargets, safeSend, sendStatus }) {
  try {
    const result = await appTargets.recoverBusyAppTarget({
      targetId,
      requestId: msg.requestId || null
    });
    safeSend(ws, {
      type: 'app_target_busy_recovery',
      targetClassId: 'app-origin',
      targetId,
      requestId: result?.requestId || msg.requestId || null,
      recovered: result?.recovered === true,
      reason: result?.reason || null
    });
  } catch (error) {
    safeSend(ws, {
      type: 'app_target_busy_recovery',
      targetClassId: 'app-origin',
      targetId,
      requestId: msg.requestId || null,
      recovered: false,
      reason: error.code || 'recovery-failed'
    });
  }
  sendStatus(ws, targetId);
  return true;
}

module.exports = { isBusyRecoveryCommand, handleBusyRecovery };
