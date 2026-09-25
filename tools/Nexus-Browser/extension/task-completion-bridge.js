(() => {
  // This service-worker helper never generates a Dex relay message. The server
  // owns the durable one-shot claim; the extension owns exact-tab submission.
  function createTaskCompletionBridge({
    providerForUrl, remember, deliveredResults, getSocket, telemetry
  } = {}) {
    async function inject(msg) {
      const source = msg?.source || {}, id = String(msg?.eventId || '');
      if (!/^task-completion-[0-9a-f-]{36}$/i.test(id)
        || !source.targetId || !source.url || !msg.text || msg.kind !== 'task-completion') {
        throw Error('Incomplete or invalid durable completion event.');
      }
      const provider = providerForUrl(source.url);
      if (!provider || provider.id !== source.providerId) {
        throw Error('Requested completion provider does not match original target.');
      }
      const tabId = Number(source.targetId);
      if (!Number.isSafeInteger(tabId) || tabId < 1
        || !globalThis.chrome?.tabs?.get || !globalThis.chrome?.tabs?.sendMessage) {
        throw Error('Original exact tab is unavailable.');
      }
      const liveTab = await chrome.tabs.get(tabId);
      if (liveTab?.url !== source.url) throw Error('Original tab navigated away; never redirect completion.');
      const freshness = globalThis.BrowserAiBridgeProviderAdapterFreshness;
      if (!freshness?.ensure) throw Error('Exact provider adapter freshness is unavailable.');
      await freshness.ensure(tabId, provider, chrome);
      const ack = await chrome.tabs.sendMessage(tabId, {
        type: 'send_prompt', requestId: 'dex-task-completion-' + id,
        text: msg.text, delivery: { kind: 'dex-task-completion', eventId: id }
      });
      if (ack?.ok !== true) {
        throw Error(String(ack?.error || 'Completion prompt submission was not confirmed.').slice(0, 160));
      }
    }
    function handle(msg) {
      const id = String(msg?.eventId || '');
      if (!/^task-completion-[0-9a-f-]{36}$/i.test(id)) return false;
      if (!remember(deliveredResults, 'completion:' + id)) return true;
      telemetry.taskCompletionsReceived++;
      inject(msg).then(() => {
        telemetry.taskCompletionsConfirmed++;
        getSocket()?.send?.(JSON.stringify({
          type: 'dex_task_completion_ack', eventId: id, ok: true
        }));
      }).catch((e) => {
        telemetry.taskCompletionsFailed++;
        telemetry.lastDeliveryError = String(e.message || e).slice(0, 160);
        getSocket()?.send?.(JSON.stringify({
          type: 'dex_task_completion_ack', eventId: id, ok: false,
          error: telemetry.lastDeliveryError
        }));
      });
      return true;
    }
    return { inject, handle };
  }
  const api = { createTaskCompletionBridge };
  globalThis.BrowserAiBridgeTaskCompletionBridge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
