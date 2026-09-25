(() => {
  const runtimeConfig = globalThis.NexusBrowserRuntimeConfig
    || (typeof require === 'function' ? require('./runtime-config') : null);
  if (!runtimeConfig) throw new Error('Nexus Browser runtime configuration is unavailable.');
  const WS_URL = runtimeConfig.websocketUrl;
  const HEALTH_URL = runtimeConfig.healthUrl;
  const pending = new Map();
  const recentActions = new Map();
  const deliveredResults = new Map();
  const streamAuthPending = new Map();
  const streamFinalPending = new Map();
  const commandAdmission = new Map();
  const DEDUPE_TTL_MS = 120000;
  const MAX_SEEN = 256;
  const REPAIR_COOLDOWN_MS = 5 * 60 * 1000;
  const taskCompletionApi = globalThis.BrowserAiBridgeTaskCompletionBridge
    || (typeof require === 'function' ? require('./task-completion-bridge.js') : null);
  const repairTabs = new Map();
  const MALFORMED_CODES = new Set(['MALFORMED_DELIMITERS', 'MISSING_CLOSER', 'INCOMPLETE_MARKER', 'INCOMPLETE_JSON', 'INVALID_JSON', 'UNKNOWN_ACTION', 'TRAILING_TEXT']);
  const telemetry = { duplicateCommandsSuppressed: 0, duplicateResultsSuppressed: 0, deliveriesAttempted: 0, deliveriesAccepted: 0, deliveriesRejected: 0, doneWatchesReceived: 0, doneWatchesConfirmed: 0, doneWatchesFailed: 0, headsUpsReceived: 0, headsUpsConfirmed: 0, headsUpsFailed: 0, repairNudgesReceived: 0, repairNudgesAccepted: 0, repairNudgesRejected: 0, taskCompletionsReceived: 0, taskCompletionsConfirmed: 0, taskCompletionsFailed: 0, lastDeliveryError: null };
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
  const taskCompletionBridge = taskCompletionApi?.createTaskCompletionBridge({
    providerForUrl, remember, deliveredResults, getSocket: () => socket, telemetry
  });

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
    if (msg?.type === 'dex_task_completion_event') { taskCompletionBridge?.handle(msg); return; }
    if (msg?.type === 'dex_stream_nudge_authorization') {
      const entry = streamAuthPending.get(String(msg.requestId || ''));
      if (entry) { clearTimeout(entry.timer); streamAuthPending.delete(String(msg.requestId));
        entry.resolve(msg.result || { ok: false, code: 'STREAM_NUDGE_NO_AUTH_RESULT' }); }
      return;
    }
    if (msg?.type === 'dex_stream_nudge_final_ack') {
      const entry = streamFinalPending.get(String(msg.requestId || ''));
      if (entry) { clearTimeout(entry.timer); streamFinalPending.delete(String(msg.requestId));
        entry.resolve(msg.result || { ok: false, code: 'STREAM_NUDGE_NO_FINAL_RESULT' }); }
      return;
    }
    if (msg?.type === 'provider_control_received' && msg.requestId) {
      const admission = commandAdmission.get(String(msg.requestId));
      if (admission) { clearTimeout(admission.timer); commandAdmission.delete(String(msg.requestId));
        admission.resolve({ ok: true, accepted: true, dispatched: true, requestId: String(msg.requestId) }); }
      return;
    }
    if (msg?.type !== 'provider_control_result' || !msg.requestId) return;
    const admission = commandAdmission.get(String(msg.requestId));
    if (admission) { clearTimeout(admission.timer); commandAdmission.delete(String(msg.requestId));
      admission.resolve({ ok: true, accepted: true, dispatched: true, requestId: String(msg.requestId), completed: true }); }
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
      for (const [key, entry] of streamAuthPending) {
        clearTimeout(entry.timer); entry.resolve({ ok: false, code: 'STREAM_NUDGE_AUTH_SOCKET_LOST' });
        streamAuthPending.delete(key);
      }
      for (const [key, entry] of streamFinalPending) {
        clearTimeout(entry.timer); entry.resolve({ ok: false, code: 'STREAM_NUDGE_FINAL_SOCKET_LOST' });
        streamFinalPending.delete(key);
      }
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


  async function authorizeStreamNudge(source, turnKey, reason = 'CHATGPT_MESSAGE_STREAM_ERROR') {
    const ws = await ensureSocket();
    if (streamAuthPending.size >= 24) return { ok: false, code: 'STREAM_NUDGE_AUTH_LIMIT' };
    const requestId = uid();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        streamAuthPending.delete(requestId);
        resolve({ ok: false, code: 'STREAM_NUDGE_AUTH_TIMEOUT' });
      }, 4000);
      streamAuthPending.set(requestId, { resolve, timer });
      try {
        ws.send(JSON.stringify({
          type: 'dex_stream_nudge_authorize', requestId, source, turnKey,
          reason
        }));
      } catch {
        clearTimeout(timer); streamAuthPending.delete(requestId);
        resolve({ ok: false, code: 'STREAM_NUDGE_AUTH_SEND_FAILED' });
      }
    });
  }


  async function submitStreamNudgeFinal(source, payload = {}) {
    const ws = await ensureSocket(), requestId = uid();
    if (streamFinalPending.size >= 24) return { ok: false, code: 'STREAM_NUDGE_FINAL_LIMIT' };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        streamFinalPending.delete(requestId);
        resolve({ ok: false, code: 'STREAM_NUDGE_FINAL_TIMEOUT' });
      }, 5000);
      streamFinalPending.set(requestId, { resolve, timer });
      try {
        ws.send(JSON.stringify({ type: 'dex_stream_nudge_final', requestId, source,
          originalRequestId: payload.originalRequestId, turnKey: payload.turnKey,
          reason: payload.reason, text: String(payload.text || '').slice(0, 131072) }));
      } catch {
        clearTimeout(timer); streamFinalPending.delete(requestId);
        resolve({ ok: false, code: 'STREAM_NUDGE_FINAL_SEND_FAILED' });
      }
    });
  }

  async function handleContentMessage(msg, sender) {
    if (msg?.type !== 'dex_provider_command') return { ok: false, accepted: false, dispatched: false, code: 'DEX_CONTROL_BAD_MESSAGE' };
    const provider = providerForUrl(sender?.tab?.url);
    if (!provider || !sender?.tab?.id || msg.providerId !== provider.id)
      return { ok: false, accepted: false, dispatched: false, code: 'DEX_CONTROL_BAD_SOURCE' };
    const actionId = String(msg.clientActionId || ''), actionKey = actionId ? `${sender.tab.id}:${actionId}` : '';
    if (actionKey && recentActions.has(actionKey)) {
      telemetry.duplicateCommandsSuppressed += 1;
      return { ok: true, accepted: true, dispatched: true, deduplicated: true };
    }
    const requestId = uid(), source = sourceFromSender(sender, provider);
    repairTabs.delete(Number(sender.tab.id));
    try { await globalThis.chrome?.storage?.session?.remove?.('dex-control-repair-tab:' + sender.tab.id); } catch {}
    let ws;
    try { ws = await ensureSocket(); }
    catch (error) { return { ok: false, accepted: false, dispatched: false, retryable: true,
      code: 'DEX_CONTROL_OFFLINE', error: String(error.message || error).slice(0, 160) }; }
    pending.set(requestId, { source, at: Date.now() });
    const admitted = new Promise((resolve) => {
      const timer = setTimeout(() => { commandAdmission.delete(requestId);
        resolve({ ok: false, accepted: false, dispatched: true, retryable: false,
          uncertain: true, code: 'DEX_CONTROL_ADMISSION_TIMEOUT' }); }, 6000);
      commandAdmission.set(requestId, { resolve, timer, at: Date.now() });
    });
    try { ws.send(JSON.stringify({ type: 'provider_control_request', requestId,
      clientActionId: actionId || null, source, command: msg.command || {} })); }
    catch (error) {
      const admission = commandAdmission.get(requestId);
      if (admission) { clearTimeout(admission.timer); commandAdmission.delete(requestId); }
      pending.delete(requestId);
      return { ok: false, accepted: false, dispatched: false, retryable: true,
        code: 'DEX_CONTROL_SEND_FAILED', error: String(error.message || error).slice(0, 160) };
    }
    const receipt = await admitted;
    if (receipt.accepted && actionKey) remember(recentActions, actionKey);
    return receipt;
  }


  // One-shot, exact-tab feedback. Never guess command arguments or replay an
  // ambiguous browser submission, and never send a localhost room command.
  async function claimRepairTab(tabId) {
    const key = 'dex-control-repair-tab:' + tabId;
    const now = Date.now();
    if (repairTabs.get(tabId) > now) return false;
    repairTabs.set(tabId, now + REPAIR_COOLDOWN_MS); // synchronous claim across concurrent events
    const store = globalThis.chrome?.storage?.session;
    try {
      const last = store ? (await store.get(key))?.[key] : 0;
      if (Number(last) > now) { repairTabs.set(tabId, Number(last)); return false; }
    } catch {} // In-memory claim remains protective if storage is unavailable.
    const until = now + REPAIR_COOLDOWN_MS;
    repairTabs.set(tabId, until);
    try { await store?.set?.({ [key]: until }); } catch {}
    return true;
  }
  async function handleMalformedMessage(msg, sender) {
    if (msg?.type !== 'dex_provider_command_malformed') return false;
    const provider = providerForUrl(sender?.tab?.url);
    if (!provider || !sender?.tab?.id || msg.providerId !== provider.id
      || !MALFORMED_CODES.has(msg.code)) return false;
    const actionId = String(msg.clientActionId || '');
    if (!/^[-a-z0-9:]{8,256}$/i.test(actionId)) return false;
    if (!remember(recentActions, 'repair:' + sender.tab.id + ':' + actionId)) {
      telemetry.duplicateCommandsSuppressed += 1;
      return false;
    }
    telemetry.repairNudgesReceived += 1;
    const tabId = Number(sender.tab.id);
    if (!(await claimRepairTab(tabId))) { telemetry.duplicateCommandsSuppressed += 1; return false; }
    const freshness = globalThis.BrowserAiBridgeProviderAdapterFreshness;
    try {
      if (!freshness?.ensure || !globalThis.chrome?.tabs?.sendMessage) {
        throw new Error('Exact provider adapter or tab messaging is unavailable.');
      }
      await freshness.ensure(tabId, provider, chrome);
      const currentTab = await chrome.tabs.get(tabId);
      if (String(currentTab?.url || '') !== String(sender.tab.url || '')) {
        throw new Error('Original provider conversation navigated before format nudge delivery.');
      }
      const message = [
        '[DEX FORMAT NUDGE — ONE SHOT]',
        'Your previous assistant reply appeared to attempt a Dex command.',
        'Reason: ' + msg.code + '. No malformed command was executed.',
        'If the original action is still appropriate, issue a NEW assistant',
        'reply containing ONE complete trailing Dex CMD marker with valid JSON.',
        'Both opening brackets, literal JSON braces, and both closing brackets',
        'must appear in the RENDERED reply. Do not use fenced code or quotes.',
        'Preserve the intended action and arguments. If the previous reply does',
        'not contain enough information, ask the user instead of guessing.',
        'This nudge is single-use; another malformed reply will NOT nudge again.',
        'Do not create acknowledgement loops or claim a command was sent.'
      ].join('\n');
      const ack = await chrome.tabs.sendMessage(tabId, {
        type: 'send_prompt', requestId: 'dex-control-repair-' + actionId,
        text: message, delivery: { kind: 'dex-control-nudge', originalTurnKey: actionId }
      });
      if (ack?.ok !== true) {
        throw new Error(String(ack?.error || 'Provider did not confirm nudge submission.').slice(0, 140));
      }
      telemetry.repairNudgesAccepted += 1;
      return true;
    } catch (error) {
      telemetry.repairNudgesRejected += 1;
      telemetry.lastDeliveryError = String(error?.message || error).slice(0, 160);
      // A negative or unknown result is recorded; no automatic retry.
      return false;
    }
  }

  function prunePending(maxAgeMs = DEDUPE_TTL_MS) {
    const now = Date.now();
    for (const [requestId, entry] of pending) {
      if (now - entry.at > maxAgeMs) pending.delete(requestId);
    }
    for (const [tabId, until] of repairTabs) if (until <= now) repairTabs.delete(tabId);
    for (const map of [recentActions, deliveredResults]) {
      for (const [key, at] of map) if (now - at > maxAgeMs) map.delete(key);
    }
  }

  if (typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type === 'dex_provider_command_malformed') {
        // Keep MV3's async response channel alive until exact-tab submission has
        // either been accepted or explicitly failed. Do not claim success early.
        handleMalformedMessage(msg, sender)
          .then((accepted) => sendResponse({ ok: accepted === true, accepted: accepted === true }))
          .catch((error) => sendResponse({ ok: false, error: String(error?.message || error).slice(0, 160) }));
        return true;
      }
      if (msg?.type !== 'dex_provider_command') return;
      handleContentMessage(msg, sender)
        .then((result) => sendResponse(result || { ok: false, accepted: false, dispatched: false }))
        .catch((error) => sendResponse({ ok: false, accepted: false, dispatched: false,
          code: 'DEX_CONTROL_BACKGROUND_FAILURE', error: String(error?.message || error).slice(0, 160) }));
      return true;
    });
    setInterval(prunePending, 30000);
    ensureSocket().catch(() => {});
  }

  const api = { pending, uid, sourceFromSender, formatResult, sameTarget, injectOriginReceipt, injectDoneWatch, handleDoneWatchEvent, taskCompletionBridge, handleContentMessage, handleMalformedMessage, authorizeStreamNudge, submitStreamNudgeFinal, claimRepairTab, handleServerMessage, prunePending, diagnostics, localRelayReady, ensureSocket };
  globalThis.BrowserAiBridgeDexProviderControlBridge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
