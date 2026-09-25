(() => {
  const REASON = 'CHATGPT_MESSAGE_STREAM_ERROR', COOLDOWN_MS = 15 * 60 * 1000;
  const REASONS = new Set([REASON, 'CHATGPT_STREAM_CACHE_EXPIRED']);
  const exactChat = (value) => {
    try { const url = new URL(String(value || '')); return url.protocol === 'https:'
      && url.hostname === 'chatgpt.com' && !url.username && !url.password; }
    catch { return false; }
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function createStreamNudgeBridge({
    chromeApi = globalThis.chrome, freshness = globalThis.BrowserAiBridgeProviderAdapterFreshness,
    authorize = (source, key, reason) => globalThis.BrowserAiBridgeDexProviderControlBridge
      ?.authorizeStreamNudge?.(source, key, reason),
    submitFinal = (source, payload) => globalThis.BrowserAiBridgeDexProviderControlBridge
      ?.submitStreamNudgeFinal?.(source, payload),
    now = Date.now, wait = sleep
  } = {}) {
    const inFlight = new Set();
    const stats = { seen: 0, accepted: 0, rejected: 0, suppressed: 0, deferred: 0,
      completed: 0, replyErrors: 0, lastError: null };
    const key = (tabId) => 'nexus-stream-nudge:' + tabId;
    function text(reason = REASON) {
      const label = reason === 'CHATGPT_STREAM_CACHE_EXPIRED' ? 'Stream cache expired' : 'Error in message stream';
      return [
        '[NEXUS CHATGPT STREAM RECOVERY — EXACT-CHAT ONE SHOT]',
        'This Dex-bound ChatGPT chat displayed "' + label + '" while',
        'its previous reply was being generated. Continue from the LAST VERIFIED',
        'checkpoint in this conversation, including the original task if unfinished.',
        'Your earlier message may already have executed tools, written files,',
        'changed Git state or issued a Dex command. Inspect existing results',
        'or durable receipts BEFORE repeating any action. Never blindly replay.',
        'If the original pending response was a first-time Dex CMD or HEADSUP,',
        'emit its complete trailing control marker ONLY when evidence shows it',
        'was not already committed. If evidence is ambiguous, ask for review',
        'instead of silently submitting a duplicate command.',
        'If the original action is complete, report its verified result.',
        'This is a new, one-shot continuation prompt, not a replayed Dex turn.',
        'No acknowledgement-only replies, auto retries or extra agent pings.'
      ].join('\n');
    }
    function exactSource(tab) {
      return { targetClassId: 'online-origin', providerId: 'chatgpt',
        targetId: tab.id, url: tab.url };
    }
    async function check(source, turnKey, reason, { allowWait = true } = {}) {
      for (let attempt = 0; attempt < (allowWait ? 40 : 1); attempt++) {
        let result;
        try { result = await authorize(source, turnKey, reason); }
        catch { return { ok: false, code: 'STREAM_NUDGE_AUTH_UNAVAILABLE' }; }
        if (result?.ok === true && result.authorized === true
          && Array.isArray(result.roomIds) && result.roomIds.length) return result;
        if (!result?.retryable || !allowWait || attempt >= 39) {
          return result || { ok: false, code: 'STREAM_NUDGE_AUTH_UNAVAILABLE' };
        }
        stats.deferred++;
        await wait(750);
      }
      return { ok: false, code: 'STREAM_NUDGE_AUTH_EXPIRED' };
    }
    async function handle(msg, sender) {
      if (msg?.type !== 'nexus_chatgpt_stream_error') return false;
      const tab = sender?.tab || {}, id = Number(tab.id);
      if (!Number.isSafeInteger(id) || id < 1 || !exactChat(tab.url)
        || !REASONS.has(msg.reason) || !/^(?:native|dex)-[a-z0-9-]{8,128}$/i.test(msg.turnKey || '')
        || (sender?.id && sender.id !== chromeApi.runtime.id)) {
        stats.rejected++; return false;
      }
      stats.seen++;
      if (inFlight.has(id)) { stats.suppressed++; return false; }
      inFlight.add(id);
      const store = chromeApi?.storage?.local, recordKey = key(id);
      try {
        if (!store?.get || !store?.set) throw Error('Persistent per-tab cooldown unavailable.');
        const last = (await store.get(recordKey))?.[recordKey];
        if (last?.until > now()) { stats.suppressed++; return false; }
        const source = exactSource(tab);
        // The server reads ALL durable rooms. Only an exact live tab bound to
        // at least one room may receive a continuation, including idle rooms.
        const permitted = await check(source, msg.turnKey, msg.reason);
        if (!permitted?.ok) throw Error(permitted?.code || 'STREAM_NUDGE_AUTH_DENIED');
        const before = await chromeApi.tabs.get(id);
        if (before?.url !== tab.url) throw Error('Original Dex-bound chat navigated.');
        if (!freshness?.ensure) throw Error('ChatGPT adapter freshness unavailable.');
        await freshness.ensure(id, { id: 'chatgpt', name: 'ChatGPT' }, chromeApi);
        const live = await chromeApi.tabs.get(id);
        if (live?.url !== tab.url) throw Error('ChatGPT tab navigated before nudge.');
        // Recheck room state immediately before durable claim. Another relay
        // may have started during adapter hydration; fail closed if so.
        const fresh = await check(source, msg.turnKey, msg.reason, { allowWait: false });
        if (!fresh?.ok) throw Error(fresh?.code || 'STREAM_NUDGE_AUTH_CHANGED');
        await store.set({ [recordKey]: { until: now() + COOLDOWN_MS,
          turnKey: msg.turnKey, state: 'claimed', roomIds: fresh.roomIds } });
        const suppressed = await chromeApi.tabs.sendMessage(id,
          { type: 'nexus_stream_nudge_suppress' });
        if (suppressed?.ok !== true) throw Error('Loop-suppression acknowledgement missing.');
        const originalRequestId = msg.turnKey.startsWith('dex-') ? msg.turnKey.slice(4) : null;
        const ack = await chromeApi.tabs.sendMessage(id, {
          type: 'send_prompt', requestId: 'nexus-stream-nudge-' + id + '-' + msg.turnKey,
          text: text(msg.reason), delivery: { kind: 'dex-stream-nudge', turnKey: msg.turnKey,
            originalRequestId, reason: msg.reason }
        });
        if (ack?.ok !== true) throw Error(String(ack?.error || 'Continuation prompt not accepted').slice(0, 160));
        await store.set({ [recordKey]: { until: now() + COOLDOWN_MS,
          turnKey: msg.turnKey, reason: msg.reason, state: 'submitted', roomIds: fresh.roomIds } });
        stats.accepted++; stats.lastError = null;
        return true;
      } catch (error) {
        stats.rejected++; stats.lastError = String(error.message || error).slice(0, 160);
        // On a claimed/uncertain send: never auto-resubmit even if the browser
        // worker reconnects. A human can inspect the persistent status.
        return false;
      } finally { inFlight.delete(id); }
    }
    async function handleOutcome(msg, sender) {
      if (msg?.type !== 'nexus_stream_nudge_reply_result') return false;
      const tab = sender?.tab || {}, id = Number(tab.id), recordKey = key(id);
      if (!Number.isSafeInteger(id) || !exactChat(tab.url)) return false;
      const store = chromeApi?.storage?.local;
      if (!store?.get || !store?.set) return false;
      const record = (await store.get(recordKey))?.[recordKey];
      if (!record || record.state !== 'submitted' || record.turnKey !== msg.turnKey) return false;
      if (msg.ok === true && msg.originalRequestId) {
        const source = exactSource(tab);
        const receipt = await submitFinal(source, { ...msg, reason: record.reason || msg.reason });
        if (receipt?.ok !== true) {
          await store.set({ [recordKey]: { ...record, state: 'reply-outcome-unknown' } });
          stats.replyErrors++; return false;
        }
      }
      await store.set({ [recordKey]: { ...record,
        state: msg.ok === true ? 'reply-completed' : 'reply-error' } });
      if (msg.ok === true) stats.completed++; else stats.replyErrors++;
      return true;
    }
    return { handle, handleOutcome, diagnostics: () => ({ ...stats, pending: inFlight.size }),
      text, check, COOLDOWN_MS, REASON };
  }
  const api = { createStreamNudgeBridge, COOLDOWN_MS, REASON, REASONS };
  globalThis.BrowserAiBridgeChatGptStreamNudgeBridge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    const bridge = createStreamNudgeBridge();
    api.diagnostics = bridge.diagnostics;
    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
      if (!['nexus_chatgpt_stream_error', 'nexus_stream_nudge_reply_result'].includes(msg?.type)) return;
      const fn = msg.type === 'nexus_chatgpt_stream_error' ? bridge.handle : bridge.handleOutcome;
      fn(msg, sender).then((ok) => respond({ ok, accepted: ok }))
        .catch((error) => respond({ ok: false, error: String(error.message || error).slice(0, 160) }));
      return true; // Preserve MV3's async response channel through tab submission.
    });
  }
})();
