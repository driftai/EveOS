'use strict';

function createAppTargetServerController({
  appTargets,
  safeSend,
  uiSockets,
  getDurability,
  maintenanceBusy = () => false
} = {}) {
  let lastTargets = [];

  function selected(ws) {
    if (!ws?.appTargetId) return null;
    return lastTargets.find((target) => target.id === ws.appTargetId) || null;
  }

  function statusPayload(targetId) {
    return {
      type: 'app_target_status',
      targetId,
      status: appTargets.getAppTargetStatus(targetId),
      diagnostics: appTargets.discoveryDiagnostics()
    };
  }

  function sendStatus(ws, targetId = ws?.appTargetId) {
    if (!targetId) return false;
    return safeSend(ws, statusPayload(targetId));
  }

  function sendEvent(targetId, source, payload) {
    safeSend(source, payload);
    for (const peer of uiSockets) {
      if (peer === source || peer.clientKind === 'dex' || peer.appTargetId !== targetId) continue;
      safeSend(peer, payload);
    }
  }

  async function refresh(destination = null, { force = false } = {}) {
    lastTargets = await appTargets.listAppTargets({ force });
    const destinations = destination ? [destination] : [...uiSockets];
    const diagnostics = appTargets.discoveryDiagnostics();
    const types = appTargets.publicAppTargetTypes();
    for (const ws of destinations) {
      if (ws.appTargetId && !lastTargets.some((target) => target.id === ws.appTargetId)) {
        ws.appTargetId = null;
      }
      safeSend(ws, {
        type: 'app_targets_update',
        types,
        targets: lastTargets,
        target: selected(ws),
        diagnostics
      });
      if (ws.appTargetId) sendStatus(ws);
    }
    return lastTargets;
  }

  async function handle(ws, msg) {
    const appCommand = msg.type === 'request_app_targets'
      || msg.type === 'select_app_target'
      || msg.type === 'request_app_status'
      || (msg.targetClassId === 'app-origin'
        && (msg.type === 'send_prompt' || msg.type === 'capture_latest'));
    if (!appCommand) return false;

    if (ws?.clientKind === 'dex' && !['request_app_targets', 'request_app_status'].includes(msg.type)) {
      safeSend(ws, {
        type: 'error',
        requestId: msg.requestId || null,
        code: 'DEX_SERVER_SCHEDULER_OWNS_TRANSPORT',
        message: 'Localhost scheduler owns Dex App-Origin dispatch; the Dex viewer may only discover/status app targets.'
      });
      return true;
    }

    if (msg.type === 'request_app_targets') {
      await refresh(ws, { force: !!msg.force });
      return true;
    }

    if (msg.type === 'request_app_status') {
      const targetId = String(msg.targetId || ws.appTargetId || '');
      if (!targetId || !sendStatus(ws, targetId)) {
        safeSend(ws, {
          type: 'error',
          requestId: msg.requestId || null,
          code: 'APP_TARGET_NOT_SELECTED',
          message: 'No App-Origin target is selected.'
        });
      }
      return true;
    }

    if (msg.type === 'select_app_target') {
      const target = await appTargets.getAppTarget(String(msg.targetId || ''), { force: true });
      if (!target) {
        safeSend(ws, {
          type: 'error',
          requestId: msg.requestId || null,
          code: 'APP_TARGET_NOT_FOUND',
          message: 'That App-Origin target is not available.'
        });
        return true;
      }
      ws.appTargetId = target.id;
      safeSend(ws, {
        type: 'app_target_selected',
        target,
        status: appTargets.getAppTargetStatus(target.id),
        diagnostics: appTargets.discoveryDiagnostics()
      });
      return true;
    }

    const targetId = String(msg.targetId || ws.appTargetId || '');

    if (msg.type === 'capture_latest') {
      try {
        const result = await appTargets.captureAppLatest({ targetId });
        safeSend(ws, {
          type: 'capture_result',
          requestId: msg.requestId || null,
          text: result.text || '',
          targetClassId: 'app-origin',
          targetId,
          providerId: result.target?.providerId,
          providerName: result.target?.providerName
        });
      } catch (error) {
        safeSend(ws, {
          type: 'error',
          requestId: msg.requestId || null,
          code: error.code || 'APP_CAPTURE_FAILED',
          message: error.message,
          targetClassId: 'app-origin',
          targetId
        });
      }
      return true;
    }

    if (msg.type === 'send_prompt') {
      if (maintenanceBusy()) {
        safeSend(ws, { type: 'error', requestId: msg.requestId || null, code: 'POST_IDLE_LEASE_BUSY',
          message: 'Post-idle maintenance holds the exclusive dispatch lease.' });
        return true;
      }
      const target = await appTargets.getAppTarget(targetId, { force: true });
      if (!target) {
        safeSend(ws, {
          type: 'error',
          requestId: msg.requestId || null,
          code: 'APP_TARGET_NOT_FOUND',
          message: 'Selected App-Origin target is not available.'
        });
        return true;
      }

      const durability = getDurability();
      const meta = {
        targetClassId: 'app-origin',
        targetId,
        providerId: target.providerId
      };

      try {
        await appTargets.sendAppPrompt({
          targetId,
          requestId: msg.requestId,
          text: msg.text,
          beforeSend: async () => {
            const gate = await durability.beforeDispatch(msg, meta);
            if (gate.ok) return;
            const error = new Error('Durable turn ledger blocked a duplicate app dispatch.');
            error.code = 'DUPLICATE_DISPATCH_BLOCKED';
            throw error;
          },
          emit: (payload) => {
            durability.observe(payload, meta).catch(() => {});
            sendEvent(targetId, ws, payload);
          }
        });
        sendStatus(ws, targetId);
      } catch (error) {
        await durability.markFailed?.(msg.requestId, error.code || 'APP_TARGET_ERROR', {
          targetClassId: 'app-origin',
          targetId,
          providerId: target.providerId
        }).catch?.(() => {});
        sendEvent(targetId, ws, {
          type: 'error',
          requestId: msg.requestId || null,
          code: error.code || 'APP_TARGET_ERROR',
          message: error.message,
          detail: error.detail || null,
          targetClassId: 'app-origin',
          targetId
        });
        sendStatus(ws, targetId);
      }
      return true;
    }

    return false;
  }

  function diagnostics() {
    return {
      targets: lastTargets.length,
      discovery: appTargets.discoveryDiagnostics()
    };
  }

  function stop() {
    appTargets.stopAppTargets();
    lastTargets = [];
  }

  return {
    handle,
    refresh,
    selected,
    diagnostics,
    stop,
    targets: () => lastTargets.map((target) => ({ ...target }))
  };
}

module.exports = { createAppTargetServerController };
