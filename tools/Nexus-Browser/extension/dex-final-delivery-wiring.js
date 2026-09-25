(() => {
  const outboxApi = globalThis.BrowserAiBridgeDexFinalReceipt
    || (typeof module !== 'undefined' && module.exports ? require('./dex-final-receipt.js') : null);

  function createFinalDelivery({ chromeApi, storage, getTarget, send, stopPolling,
    rememberCompleted, onError = () => {}, afterQueued = () => {} } = {}) {
    const outbox = outboxApi.createOutbox({ storage });
    const target = () => getTarget() || {};
    function flush() {
      const selected = target();
      return outbox.flush({ tabId: selected.tabId,
        providerId: selected.providerId, send });
    }
    function restoreSoon() {
      outbox.restore().then(() => setTimeout(flush, 1500))
        .catch((error) => onError('FINAL_RECEIPT_RESTORE_FAILED', error.message));
    }
    function onFinal(message, sender, sendResponse, provider) {
      const selected = target();
      const tabId = sender?.tab?.id;
      if (!tabId || selected.tabId !== tabId || selected.providerId !== provider?.id) {
        sendResponse({ ok: false, error: 'Final reply target no longer matches selected tab.' });
        return true;
      }
      outbox.queue({ ...message, tabId, providerId: provider.id,
        providerName: provider.name }, { tabId, providerId: provider.id, send })
        .then((receipt) => {
          stopPolling(message.requestId);
          afterQueued(message.requestId, provider, chromeApi, tabId);
          sendResponse(receipt);
        }).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    async function onCaptured(payload, tabId, provider) {
      try {
        const receipt = await outbox.queue({ ...payload, tabId,
          providerId: provider.id, providerName: provider.name },
          { tabId, providerId: provider.id, send });
        return receipt.ok === true;
      } catch (error) {
        onError('FINAL_QUEUE_FAILED', error.message, payload.requestId);
        return false;
      }
    }
    function onReceipt(message) {
      if (message?.type !== 'dex_turn_receipt') return false;
      outbox.acknowledge(message).then((accepted) => {
        if (accepted) rememberCompleted(message.requestId);
      }).catch((error) => onError('FINAL_RECEIPT_STORAGE_FAILED', error.message, message.requestId));
      return true;
    }
    return { onFinal, onCaptured, onReceipt, flush, restoreSoon, diagnostics: outbox.diagnostics };
  }
  function createForServiceWorker(chromeApi, getTarget, send,
    stopResponsePoll, stopNavigation, rememberCompleted, emitError) {
    return createFinalDelivery({
      chromeApi, storage: chromeApi?.storage?.local, getTarget, send,
      stopPolling(id) { stopResponsePoll(id); stopNavigation(id); },
      rememberCompleted, onError: emitError,
      afterQueued(id, provider, chrome, tabId) {
        if (provider.capabilities?.activity) chrome.tabs.sendMessage(tabId,
          { type: 'activity_stop', requestId: id }).catch(() => {});
      }
    });
  }
  const api = { createFinalDelivery, createForServiceWorker };
  if (typeof globalThis !== 'undefined') globalThis.BrowserAiBridgeDexFinalDeliveryWiring = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();