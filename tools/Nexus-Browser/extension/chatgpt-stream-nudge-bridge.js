(() => {
  const REASON = 'CHATGPT_MESSAGE_STREAM_ERROR';
  const COOLDOWN_MS = 15 * 60 * 1000;
  const exactChat = /^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+(?:[?#].*)?$/;
  function createStreamNudgeBridge({
    chromeApi = globalThis.chrome, freshness = globalThis.BrowserAiBridgeProviderAdapterFreshness,
    now = Date.now
  } = {}) {
    const inFlight = new Set();
    const stats = { seen: 0, accepted: 0, rejected: 0, suppressed: 0, lastError: null };
    function key(tabId) { return 'nexus-stream-nudge:' + tabId; }
    function text() {
      return [
        '[NEXUS CHATGPT STREAM RECOVERY — ONE SHOT]',
        'The preceding assistant reply in this same chat stopped with "Error in message stream".',
        'Continue from the LAST VERIFIED checkpoint. Before repeating any tool action,',
        'Git operation, file write, external call or agent dispatch, inspect whether',
        'that action already completed. An interrupted reply does not roll back work.',
        'Do not repeat or restart a task merely because its answer was interrupted.',
        'If the result is uncertain, report that uncertainty and the evidence needed.',
        'This is a one-time continuation nudge, NOT a Dex relay turn or approval',
        'for a new command. Do not send an acknowledgement-only reply or another nudge.'
      ].join('\n');
    }
    async function handle(msg, sender) {
      if (msg?.type !== 'nexus_chatgpt_stream_error') return false;
      const source = sender?.tab || {}, tabId = Number(source.id);
      if (!Number.isSafeInteger(tabId) || tabId < 1 || !exactChat.test(source.url || '')
        || msg.reason !== REASON || !/^native-[a-z0-9-]{8,110}$/i.test(msg.turnKey || '')) {
        stats.rejected++; return false;
      }
      if (sender?.id && sender.id !== chromeApi.runtime.id) {
        stats.rejected++; return false;
      }
      stats.seen++;
      if (inFlight.has(tabId)) { stats.suppressed++; return false; }
      inFlight.add(tabId); // Synchronous claim before any asynchronous storage read.
      const store = chromeApi?.storage?.session;
      const recordKey = key(tabId);
      try {
        if (!store?.get || !store?.set) throw Error('Durable per-tab cooldown unavailable.');
        const last = (await store.get(recordKey))?.[recordKey];
        if (last?.until > now()) { stats.suppressed++; return false; }
        // Persist a one-shot claim BEFORE injecting a prompt. Unknown outcomes
        // remain claimed, including Chrome/service-worker restart uncertainty.
        const original = await chromeApi.tabs.get(tabId);
        if (original?.url !== source.url) throw Error('Origin ChatGPT conversation navigated.');
        await store.set({ [recordKey]: { until: now() + COOLDOWN_MS,
          turnKey: msg.turnKey, state: 'claimed' } });
        const provider = { id: 'chatgpt', name: 'ChatGPT' };
        if (!freshness?.ensure) throw Error('ChatGPT adapter freshness unavailable.');
        await freshness.ensure(tabId, provider, chromeApi);
        const live = await chromeApi.tabs.get(tabId);
        if (live?.url !== source.url) throw Error('ChatGPT tab navigated after claim.');
        const suppressed = await chromeApi.tabs.sendMessage(tabId,
          { type: 'nexus_stream_nudge_suppress' });
        if (suppressed?.ok !== true) throw Error('Content watcher did not confirm loop suppression.');
        const ack = await chromeApi.tabs.sendMessage(tabId, {
          type: 'send_prompt', requestId: 'nexus-stream-nudge-' + tabId + '-' + msg.turnKey,
          text: text(), delivery: { kind: 'dex-stream-nudge' }
        });
        if (ack?.ok !== true) throw Error(String(ack?.error || 'Continuation prompt not accepted').slice(0, 160));
        stats.accepted++; stats.lastError = null;
        return true;
      } catch (error) {
        stats.rejected++; stats.lastError = String(error.message || error).slice(0, 160);
        // A failed or uncertain send is never automatically retried.
        return false;
      } finally { inFlight.delete(tabId); }
    }
    const diagnostics = () => ({ ...stats, pending: inFlight.size });
    return { handle, diagnostics, text, COOLDOWN_MS, REASON };
  }
  const api = { createStreamNudgeBridge, COOLDOWN_MS, REASON };
  globalThis.BrowserAiBridgeChatGptStreamNudgeBridge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    const bridge = createStreamNudgeBridge();
    api.diagnostics = bridge.diagnostics;
    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
      if (msg?.type !== 'nexus_chatgpt_stream_error') return;
      bridge.handle(msg, sender).then((ok) => respond({ ok, accepted: ok }))
        .catch((error) => respond({ ok: false, error: String(error.message || error).slice(0, 160) }));
      return true; // MV3 listener retains its async response channel.
    });
  }
})();
