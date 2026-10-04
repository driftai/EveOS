(function registerAppBusyRecovery(global) {
  'use strict';

  function create({ send, addMessage, log }) {
    let recoveryRequestId = null;

    function requestIfBusy({ target, pending, status }) {
      const busy = [...pending.values()].some((entry) => entry.targetClassId === 'app-origin')
        || ['waiting', 'streaming'].includes(status?.phase);
      if (!busy) return false;

      const pendingRequestId = [...pending.entries()]
        .find(([, entry]) => entry.targetClassId === 'app-origin')?.[0] || '';
      const activeRequestId = status?.requestId || pendingRequestId;
      addMessage('system', 'Current ChatGPT turn still running. Checking the finished native reply…');
      if (activeRequestId && recoveryRequestId !== activeRequestId
          && send({
            type: 'recover_app_target_busy',
            requestId: activeRequestId,
            targetClassId: 'app-origin',
            targetId: target.id
          })) {
        recoveryRequestId = activeRequestId;
        log(`Requested read-only ChatGPT busy recovery for ${activeRequestId}.`);
      }
      return true;
    }

    function observe(msg) {
      if (msg.recovered !== true && (!msg.requestId || recoveryRequestId === msg.requestId)) {
        recoveryRequestId = null;
      }
      log(msg.recovered
        ? `ChatGPT busy recovery armed for ${msg.requestId || 'active turn'} · waiting for canonical final event.`
        : `ChatGPT busy recovery kept the turn active${msg.reason ? ` · ${msg.reason}` : ''}.`);
    }

    function complete(requestId) {
      if (recoveryRequestId === requestId) recoveryRequestId = null;
    }

    function fail(requestId) {
      if (!requestId || recoveryRequestId === requestId) recoveryRequestId = null;
    }

    return { requestIfBusy, observe, complete, fail };
  }

  global.BrowserAiBridgeAppBusyRecovery = Object.freeze({ create });
})(globalThis);
