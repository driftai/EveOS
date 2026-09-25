(() => {
  const runtimeConfig = globalThis.NexusBrowserRuntimeConfig
    || (typeof require === 'function' ? require('./runtime-config') : null);
  if (!runtimeConfig) throw new Error('Nexus Browser runtime configuration is unavailable.');
  const WS_URL = runtimeConfig.websocketUrl;
  const HEALTH_URL = runtimeConfig.healthUrl;
  const pending = new Map();
  const recentActions = new Map();
  const deliveredResults = new Map();
  const DEDUPE_TTL_MS = 120000;
  const MAX_SEEN = 256;
  const telemetry = { duplicateCommandsSuppressed: 0, duplicateResultsSuppressed: 0, deliveriesAttempted: 0, deliveriesAccepted: 0, deliveriesRejected: 0, doneWatchesReceived: 0, doneWatchesConfirmed: 0, doneWatchesFailed: 0, headsUpsReceived: 0, headsUpsConfirmed: 0, headsUpsFailed: 0, lastDeliveryError: null };
  function diagnostics() {
    return { ...telemetry, pending: pending.size, recentActions: recentActions.size, deliveredResults: deliveredResults.size };
  }
  function remember(map, key) {
    if (map.has(key)) return false;
    map.set(key, Date.now());
    while (map.size > MAX_SEEN) map.delete(map.keys().next().value);
    return true;
  }
  let socket = null;
  let connecting = null;

  const uid = () => `provider-control-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

  function providerForUrl(url) {
    return globalThis.BrowserAiBridgeProviders?.providerForUrl?.(String(url || '')) || null;
  }

  function sourceFromSender(sender, provider) {
    const tab = sender?.tab || {};
    return {
      targetClassId: 'online-origin',
      targetId: tab.id,
      providerId: provider.id,
      providerName: provider.name,
      url: String(tab.url || ''),
      title: String(tab.title || provider.name)
    };
  }

  function formatResult(result = {}) {
    const data = result.data == null ? '' : `\nData: ${JSON.stringify(result.data)}`;
    const status = result.ok ? 'OK' : `ERROR ${result.code || 'DEX_CONTROL_FAILED'}`;
    return [
      '[DEX TOOL RESULT]',
      `${status}: ${result.message || 'No message.'}${data}`,
      '',
      'If another Dex control action is needed, end your next reply with one trailing marker.',
      'Use [[DEX:CMD {"action":"help"}]] for the full room-admin command set.',
      'Common: [[DEX:CMD {"action":"status"}]] or [[DEX:CMD {"action":"send","text":"<message>","relay":true}]].',
      'Otherwise do not emit a Dex command.'
    ].join('\n');
  }

  async function injectResult(source, requestId, result) {
    if (!source?.targetId || !globalThis.chrome?.tabs?.sendMessage) return;
    if (result?.ok && result?.silent) return;
    const provider = providerForUrl(source.url);
    const freshness = globalThis.BrowserAiBridgeProviderAdapterFreshness;
    if (!provider || !freshness?.ensure) throw new Error('Dex result delivery could not resolve provider adapter freshness.');
    await freshness.ensure(Number(source.targetId), provider, chrome);
    const acknowledgement = await chrome.tabs.sendMessage(Number(source.targetId), {
      type: 'send_prompt',
      requestId: `dex-control-result-${requestId}`,
      text: formatResult(result),
      delivery: { kind: 'dex-control-result' }
    });
    // chrome.tabs.sendMessage resolves even when the provider responds { ok:false }.
    // Record that negative acknowledgement instead of silently treating seeded text
    // as successfully submitted; never replay an uncertain send automatically.
    if (acknowledgement?.ok === false) {
      throw new Error(`DEX_RESULT_SUBMISSION_FAILED: ${String(acknowledgement.error || 'Provider rejected result submission.').slice(0, 120)}`);
    }
    return acknowledgement;
  }

  function sameTarget(a = {}, b = {}) {
    if (a.targetClassId !== b.targetClassId || a.providerId !== b.providerId) return false;
    if (a.targetId != null && b.targetId != null) return String(a.targetId) === String(b.targetId);
    return !!a.url && !!b.url && a.url === b.url;
  }

  async function injectOriginReceipt(receipt, requestId) {
    const target = receipt?.originTarget;
    if (!target?.targetId || !globalThis.chrome?.tabs?.sendMessage || !receipt?.text) return;
    const provider = providerForUrl(target.url);
    const freshness = globalThis.BrowserAiBridgeProviderAdapterFreshness;
    if (!provider || !freshness?.ensure) throw new Error('Dex origin receipt delivery could not resolve provider adapter freshness.');
    await freshness.ensure(Number(target.targetId), provider, chrome);
    await chrome.tabs.sendMessage(Number(target.targetId), {
      type: 'send_prompt',
      requestId: `dex-control-origin-receipt-${requestId}`,
      text: receipt.text,
      delivery: { kind: 'dex-control-origin-receipt', controlRequestId: requestId }
    });
  }

  async function injectDoneWatch(msg) {
    const source = msg?.source || {};
    if (!source.targetId || !source.url || !msg?.eventId || !msg?.text)
      throw new Error('Incomplete DONE watch event.');
    const provider = providerForUrl(source.url);
    const freshness = globalThis.BrowserAiBridgeProviderAdapterFreshness;
    if (!provider || provider.id !== source.providerId || !freshness?.ensure)
      throw new Error('DONE watch target is not an exact authorized browser provider.');
    await freshness.ensure(Number(source.targetId), provider, chrome);
    const kind = msg.kind === 'heads-up' ? 'dex-heads-up' : 'dex-done-watch';
    const accepted = await chrome.tabs.sendMessage(Number(source.targetId), {
      type: 'send_prompt', requestId: `${kind}-${msg.eventId}`,
      text: msg.text, delivery: { kind, eventId: msg.eventId }
    });
    if (accepted?.ok !== true)
      throw new Error(String(accepted?.error || 'DONE notification submission was not confirmed.').slice(0, 160));
  }

  function handleDoneWatchEvent(msg) {
    const key = String(msg?.eventId || '');
    if (!key) return;
    if (!remember(deliveredResults, `done:${key}`)) return;
    const category = msg.kind === 'heads-up' ? 'headsUps' : 'doneWatches';
    telemetry[`${category}Received`] += 1;
    // The event is claimed once; neither reconnect nor an ambiguous browser
    // send acknowledgement may re-submit it automatically.
    injectDoneWatch(msg).then(() => {
      telemetry[`${category}Confirmed`] += 1;
      socket?.send?.(JSON.stringify({ type: 'dex_done_watch_ack', eventId: key, ok: true }));
    }).catch((error) => {
      telemetry[`${category}Failed`] += 1;
      telemetry.lastDeliveryError = String(error?.message || error).slice(0, 160);
      socket?.send?.(JSON.stringify({ type: 'dex_done_watch_ack', eventId: key, ok: false, error: telemetry.lastDeliveryError }));
    });
  }

  function handleServerMessage(raw) {
    let msg;
    try { msg = JSON.parse(String(raw?.data ?? raw)); } catch { return; }
    if (msg?.type === 'dex_done_watch_event') { handleDoneWatchEvent(msg); return; }
    if (msg?.type !== 'provider_control_result' || !msg.requestId) return;
    if (!remember(deliveredResults, String(msg.requestId))) {
      telemetry.duplicateResultsSuppressed += 1;
      return;
    }
    const entry = pending.get(msg.requestId);
    const source = entry?.source || msg.source;
    const result = msg.result || { ok: false, message: 'Dex provider-control returned no result.' };
    pending.delete(msg.requestId);
    telemetry.deliveriesAttempted += 1;
    injectResult(source, msg.requestId, result).then(() => {
      telemetry.deliveriesAccepted += 1;
      telemetry.lastDeliveryError = null;
    }).catch((error) => {
      telemetry.deliveriesRejected += 1;
      telemetry.lastDeliveryError = String(error?.message || error).slice(0, 160);
    });
    if (msg.originReceipt?.originTarget && (!sameTarget(msg.originReceipt.originTarget, source) || result?.silent)) {
      injectOriginReceipt(msg.originReceipt, msg.requestId).catch(() => {});
    }
  }

  function attachSocket(ws) {
    ws.addEventListener('message', handleServerMessage);
    ws.addEventListener('close', () => {
      if (socket === ws) socket = null;
      connecting = null;
    });
    ws.addEventListener('error', () => {});
    return ws;
  }

  async function localRelayReady(fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== 'function') return false;
    try {
      const response = await fetchImpl(HEALTH_URL, { cache: 'no-store' });
      return !!response?.ok;
    } catch {
      return false;
    }
  }

  function ensureSocket() {
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    if (connecting) return connecting;
    connecting = (async () => {
      if (!(await localRelayReady())) throw new Error('Dex provider-control bridge localhost is offline.');
      return new Promise((resolve, reject) => {
        const ws = attachSocket(new WebSocket(WS_URL));
        const timer = setTimeout(() => reject(new Error('Dex provider-control bridge connection timed out.')), 5000);
        ws.addEventListener('open', () => {
          clearTimeout(timer);
          socket = ws;
          ws.send(JSON.stringify({ type: 'hello', role: 'provider-control-extension', doneWatchVersion: 1 }));
          resolve(ws);
        }, { once: true });
        ws.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error('Dex provider-control bridge could not reach localhost.'));
        }, { once: true });
      });
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  async function handleContentMessage(msg, sender) {
    if (msg?.type !== 'dex_provider_command') return;
    const provider = providerForUrl(sender?.tab?.url);
    if (!provider || !sender?.tab?.id || msg.providerId !== provider.id) return;
    const actionId = String(msg.clientActionId || '');
    if (actionId && !remember(recentActions, `${sender.tab.id}:${actionId}`)) {
      telemetry.duplicateCommandsSuppressed += 1;
      return;
    }
    const requestId = uid();
    const source = sourceFromSender(sender, provider);
    pending.set(requestId, { source, at: Date.now() });
    try {
      const ws = await ensureSocket();
      ws.send(JSON.stringify({ type: 'provider_control_request', requestId, source, command: msg.command || {} }));
    } catch (error) {
      pending.delete(requestId);
      await injectResult(source, requestId, { ok: false, code: 'DEX_CONTROL_OFFLINE', message: error.message }).catch(() => {});
    }
  }

  function prunePending(maxAgeMs = DEDUPE_TTL_MS) {
    const now = Date.now();
    for (const [requestId, entry] of pending) {
      if (now - entry.at > maxAgeMs) pending.delete(requestId);
    }
    for (const map of [recentActions, deliveredResults]) {
      for (const [key, at] of map) if (now - at > maxAgeMs) map.delete(key);
    }
  }

  if (typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (msg?.type !== 'dex_provider_command') return;
      handleContentMessage(msg, sender).catch(() => {});
    });
    setInterval(prunePending, 30000);
    ensureSocket().catch(() => {});
  }

  const api = { pending, uid, sourceFromSender, formatResult, sameTarget, injectOriginReceipt, injectDoneWatch, handleDoneWatchEvent, handleContentMessage, handleServerMessage, prunePending, diagnostics, localRelayReady, ensureSocket };
  globalThis.BrowserAiBridgeDexProviderControlBridge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
