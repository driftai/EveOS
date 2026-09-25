(() => {
  const active = new Map();
  const POLL_MS = 750;
  const RELIABLE_SETTLE_MS = 3000;
  const COMPLETE_NO_SIGNAL_SETTLE_MS = 5000;
  const INCOMPLETE_NO_SIGNAL_SETTLE_MS = 60000;
  const MAX_MS = 180000;

  function isFreshChatGptUrl(url) {
    try {
      const parsed = new URL(String(url || ''));
      return parsed.hostname === 'chatgpt.com' && parsed.pathname === '/' && !parsed.hash;
    } catch {
      return false;
    }
  }

  function isConversationUrl(url) {
    try {
      const parsed = new URL(String(url || ''));
      return parsed.hostname === 'chatgpt.com' && /^\/c\//.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function stop(requestId) {
    const entry = active.get(requestId);
    if (!entry) return false;
    clearInterval(entry.timer);
    active.delete(requestId);
    return true;
  }

  function start({
    requestId, tabId, initialUrl, chromeApi = globalThis.chrome,
    send, completed = () => false, rememberCompleted = () => {}
  }) {
    if (!requestId || !Number.isInteger(Number(tabId)) || !isFreshChatGptUrl(initialUrl)) return false;
    stop(requestId);
    const entry = {
      requestId,
      tabId: Number(tabId),
      startedAt: Date.now(),
      lastText: '',
      lastChangedAt: 0,
      sawGenerating: false,
      generatingEndedAt: 0,
      polling: false,
      timer: null
    };

    async function sample() {
      if (entry.polling || !active.has(requestId)) return;
      entry.polling = true;
      try {
        if (completed(requestId)) return stop(requestId);
        if (Date.now() - entry.startedAt >= MAX_MS) return stop(requestId);
        const tab = await chromeApi.tabs.get(entry.tabId).catch(() => null);
        if (!tab || !isConversationUrl(tab.url || tab.pendingUrl || '')) return;

        const result = await chromeApi.tabs.sendMessage(entry.tabId, {
          type: 'capture_latest',
          requestId: `nav-recovery-${requestId}`
        }).catch(() => null);
        if (!result?.ok) return;

        const text = String(result.text || '').trim();
        if (!text) return;
        const now = Date.now();
        if (text !== entry.lastText) {
          entry.lastText = text;
          entry.lastChangedAt = now;
          return;
        }
        const generating = result.generationState === 'active' || result.isGenerating === true;
        if (generating) {
          entry.sawGenerating = true;
          entry.generatingEndedAt = 0;
          return;
        }

        let settleMs;
        if (entry.sawGenerating) {
          if (!entry.generatingEndedAt) {
            entry.generatingEndedAt = now;
            return;
          }
          settleMs = RELIABLE_SETTLE_MS;
          if (now - entry.generatingEndedAt < settleMs) return;
        } else {
          settleMs = result.completenessHint === 'complete'
            ? COMPLETE_NO_SIGNAL_SETTLE_MS
            : INCOMPLETE_NO_SIGNAL_SETTLE_MS;
        }
        if (now - entry.lastChangedAt < settleMs) return;

        const delivered = await send({
          type: 'response_final',
          requestId,
          text,
          observedAt: now,
          detail: {
            navigationCaptureRecovery: true,
            stableForMs: now - entry.lastChangedAt,
            reliableGeneration: entry.sawGenerating,
            completenessHint: result.completenessHint || 'unknown'
          }
        });
        if (!delivered) return;
        rememberCompleted(requestId);
        stop(requestId);
      } finally {
        entry.polling = false;
      }
    }

    entry.timer = setInterval(sample, POLL_MS);
    active.set(requestId, entry);
    sample();
    return true;
  }

  function clear() {
    for (const requestId of [...active.keys()]) stop(requestId);
  }

  const api = { POLL_MS, RELIABLE_SETTLE_MS, COMPLETE_NO_SIGNAL_SETTLE_MS, INCOMPLETE_NO_SIGNAL_SETTLE_MS, MAX_MS, isFreshChatGptUrl, isConversationUrl, start, stop, clear };
  globalThis.BrowserAiBridgeChatGptNavigationRecovery = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();