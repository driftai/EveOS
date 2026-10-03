(() => {
  const outboxApi = globalThis.BrowserAiBridgeDexFinalReceipt
    || (typeof module !== 'undefined' && module.exports ? require('./dex-final-receipt.js') : null);

  const isDexRequestId = (requestId) => String(requestId || '').startsWith('dex-');

  function createFinalDelivery({ chromeApi, storage, send, stopPolling,
    rememberCompleted, onError = () => {}, afterDelivered = () => {} } = {}) {
    const outbox = outboxApi.createOutbox({ storage });

    function payloadFor(message, tabId, provider) {
      return { ...message, tabId: Number(tabId), providerId: provider.id, providerName: provider.name };
    }

    function finishDirect(message, tabId, provider) {
      const payload = payloadFor(message, tabId, provider);
      if (!send(payload)) return { ok: false, delivered: false, error: 'Nexus websocket is unavailable.' };
      stopPolling(message.requestId);
      rememberCompleted(message.requestId);
      afterDelivered(message.requestId, provider, chromeApi, tabId);
      return { ok: true, delivered: true, durable: false };
    }

    function flush() {
      return outbox.flush({ send });
    }

    function restoreSoon() {
      outbox.restore().then(() => setTimeout(flush, 1500))
        .catch((error) => onError('FINAL_RECEIPT_RESTORE_FAILED', error.message));
    }

    function onFinal(message, sender, sendResponse, provider) {
      const tabId = sender?.tab?.id;
      if (!tabId || !provider?.id) {
        sendResponse({ ok: false, error: 'Final reply has no bound provider target.' });
        return true;
      }
      if (!isDexRequestId(message.requestId)) {
        sendResponse(finishDirect(message, tabId, provider));
        return true;
      }
      const payload = payloadFor(message, tabId, provider);
      outbox.queue(payload, { tabId, providerId: provider.id, send })
        .then((receipt) => {
          stopPolling(message.requestId);
          afterDelivered(message.requestId, provider, chromeApi, tabId);
          sendResponse(receipt);
        }).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    async function onCaptured(payload, tabId, provider) {
      if (!isDexRequestId(payload?.requestId)) {
        return finishDirect(payload, tabId, provider).ok === true;
      }
      try {
        const receipt = await outbox.queue(payloadFor(payload, tabId, provider),
          { tabId, providerId: provider.id, send });
        if (receipt.ok) {
          stopPolling(payload.requestId);
          afterDelivered(payload.requestId, provider, chromeApi, tabId);
        }
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

  function createForServiceWorker(chromeApi, send,
    stopResponsePoll, stopNavigation, rememberCompletedRequest, emitError) {
    return createFinalDelivery({
      chromeApi, storage: chromeApi?.storage?.local, send,
      stopPolling(id) { stopResponsePoll(id); stopNavigation(id); },
      rememberCompleted: rememberCompletedRequest, onError: emitError,
      afterDelivered(id, provider, chrome, tabId) {
        if (provider.capabilities?.activity) chrome.tabs.sendMessage(tabId,
          { type: 'activity_stop', requestId: id }).catch(() => {});
      }
    });
  }

  const api = { isDexRequestId, createFinalDelivery, createForServiceWorker };
  if (typeof globalThis !== 'undefined') globalThis.BrowserAiBridgeDexFinalDeliveryWiring = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
