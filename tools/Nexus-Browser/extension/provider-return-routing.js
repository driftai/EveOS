(() => {
  function createRouter({ requestOwners, getProvider, getSelectedTarget,
    noteRuntimeMessage, rememberCompletedRequest, hasCompletedRequest,
    stopResponsePoll, stopNavigation, emitError, finalDelivery, send } = {}) {
    function reject(message, senderTabId, authorization, sendResponse) {
      const owner = authorization?.owner || null;
      const reason = authorization?.reason || 'unbound-target';
      const selected = getSelectedTarget?.() || {};
      const detail = reason === 'tab-mismatch'
        ? 'Provider reply came from a different tab than the request owner.'
        : 'Provider reply has no matching request owner or selected target.';
      emitError('RESPONSE_RETURN_REJECTED', detail, message?.requestId || null, {
        reason,
        messageType: message?.type || null,
        senderTabId: Number(senderTabId) || null,
        ownerTabId: owner?.tabId ?? null,
        ownerProviderId: owner?.providerId ?? null,
        selectedTabId: selected.tabId ?? null,
        selectedProviderId: selected.providerId ?? null
      });
      if (message?.type === 'response_final') {
        sendResponse({ ok: false, code: 'RESPONSE_RETURN_REJECTED', error: detail });
      }
    }

    async function resolve(message, sender) {
      const tabId = Number(sender?.tab?.id);
      if (!Number.isInteger(tabId)) {
        return { ok: false, tabId: null, authorization: { reason: 'missing-tab', owner: null } };
      }
      const requestId = String(message?.requestId || '');
      if (requestId) {
        const authorization = await requestOwners.authorize(requestId, tabId);
        if (authorization.ok) {
          const provider = getProvider(authorization.owner.providerId);
          if (provider) return { ok: true, tabId, provider, authorization };
          return { ok: false, tabId, authorization: { ...authorization, reason: 'missing-provider' } };
        }
        if (authorization.reason === 'tab-mismatch') return { ok: false, tabId, authorization };
      }
      const selected = getSelectedTarget?.() || {};
      if (tabId !== Number(selected.tabId) || !selected.providerId) {
        return { ok: false, tabId, authorization: { reason: 'missing-owner', owner: null } };
      }
      const provider = getProvider(selected.providerId);
      if (!provider) return { ok: false, tabId, authorization: { reason: 'missing-provider', owner: null } };
      if (requestId) await requestOwners.remember(requestId, tabId, provider.id);
      return {
        ok: true, tabId, provider,
        authorization: { ok: true, reason: 'selected-target-fallback', owner: { tabId, providerId: provider.id } }
      };
    }

    async function handle(message, sender, sendResponse) {
      const resolved = await resolve(message, sender);
      if (!resolved.ok) {
        reject(message, resolved.tabId, resolved.authorization, sendResponse);
        return;
      }
      const provider = resolved.provider;
      noteRuntimeMessage(message, sender);
      if (/^dex-(?:done-watch|heads-up)-/.test(String(message.requestId || ''))) {
        if (message.type === 'response_final') {
          rememberCompletedRequest(message.requestId);
          sendResponse({ ok: true, notification: true });
        }
        return;
      }
      if (message.type === 'adapter_error') {
        if (message.requestId) {
          stopResponsePoll(message.requestId);
          stopNavigation(message.requestId);
        }
        if (!hasCompletedRequest(message.requestId)) {
          emitError(message.code || 'ADAPTER_ERROR', message.message || `${provider.name} adapter error.`,
            message.requestId || null, message.detail || null);
        }
        return;
      }
      if (hasCompletedRequest(message.requestId)) {
        if (message.type === 'response_final') sendResponse({ ok: true, alreadyCommitted: true });
        return;
      }
      if (message.type === 'response_final' && message.requestId) {
        finalDelivery.onFinal(message, sender, sendResponse, provider);
        return;
      }
      send({ ...message, providerId: provider.id, providerName: provider.name });
    }

    return { handle, resolve };
  }

  const api = { createRouter };
  if (typeof globalThis !== 'undefined') globalThis.BrowserAiBridgeProviderReturnRouting = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
