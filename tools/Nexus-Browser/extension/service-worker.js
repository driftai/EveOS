if (typeof importScripts === 'function') {
  for (const script of ['tab-publish.js', 'target-metadata.js', 'provider-contract.js', 'providers.js', 'provider-health-state.js', 'gemini-background-poll.js', 'gemini-studio-window.js', 'gemini-studio-submit.js']) {
    try { importScripts(script); }
    catch { try { importScripts(script); } catch {} }
  }
}
const { websocketUrl: WS_URL, healthUrl: HEALTH_URL } = globalThis.NexusBrowserRuntimeConfig || require('./runtime-config');
const tabPublishApi = globalThis.BrowserAiBridgeTabPublish || (typeof module !== 'undefined' && module.exports ? require('./tab-publish.js') : null);
const targetMetadataApi = globalThis.BrowserAiBridgeTargetMetadata || (typeof module !== 'undefined' && module.exports ? require('./target-metadata.js') : null);
const providerApi = globalThis.BrowserAiBridgeProviders || (typeof module !== 'undefined' && module.exports ? require('./providers.js') : null); const providerHealthApi = globalThis.BrowserAiBridgeProviderHealthState || (typeof module !== 'undefined' && module.exports ? require('./provider-health-state.js') : null);
const geminiPollApi = globalThis.BrowserAiBridgeGeminiBackgroundPoll
  || (typeof module !== 'undefined' && module.exports ? require('./gemini-background-poll.js') : null);
const geminiStudioWindowApi = globalThis.BrowserAiBridgeGeminiStudioWindow
  || (typeof module !== 'undefined' && module.exports ? require('./gemini-studio-window.js') : null);
const geminiStudioSubmitApi = globalThis.BrowserAiBridgeGeminiStudioSubmit
  || (typeof module !== 'undefined' && module.exports ? require('./gemini-studio-submit.js') : null);
const hostAccessApi = globalThis.BrowserAiBridgeHostAccess || (typeof module !== 'undefined' && module.exports ? require('./host-access.js') : null);
const targetStateApi = globalThis.BrowserAiBridgeTargetState || (typeof module !== 'undefined' && module.exports ? require('./target-state.js') : null);
const targetResurrectionApi = globalThis.BrowserAiBridgeTargetResurrection || (typeof module !== 'undefined' && module.exports ? require('./target-resurrection.js') : null);
const qualificationControlApi = globalThis.BrowserAiBridgeQualificationControl || (typeof module !== 'undefined' && module.exports ? require('./qualification-control.js') : null);
const adapterReadinessApi = globalThis.BrowserAiBridgeAdapterReadinessCache || (typeof module !== 'undefined' && module.exports ? require('./adapter-readiness-cache.js') : null); const adapterFreshnessApi = globalThis.BrowserAiBridgeProviderAdapterFreshness || (typeof module !== 'undefined' && module.exports ? require('./provider-adapter-freshness.js') : null);
const dexUiEnsureApi = globalThis.BrowserAiBridgeDexUiEnsure || (typeof module !== 'undefined' && module.exports ? require('./dex-ui-ensure.js') : null); const providerTargetSpawnApi = globalThis.BrowserAiBridgeProviderTargetSpawn || (typeof module !== 'undefined' && module.exports ? require('./provider-target-spawn.js') : null);
const chatgptNavigationRecoveryApi = globalThis.BrowserAiBridgeChatGptNavigationRecovery || (typeof module !== 'undefined' && module.exports ? require('./chatgpt-navigation-recovery.js') : null);
const backgroundDispatchApi = globalThis.BrowserAiBridgeBackgroundDispatch || (typeof module !== 'undefined' && module.exports ? require('./background-dispatch.js') : null);
const tabReadinessApi = globalThis.BrowserAiBridgeTabReadiness || (typeof module !== 'undefined' && module.exports ? require('./tab-readiness.js') : null);
if (!tabPublishApi || !providerApi || !providerHealthApi || !geminiPollApi || !geminiStudioWindowApi || !geminiStudioSubmitApi || !hostAccessApi || !targetStateApi || !targetResurrectionApi || !qualificationControlApi || !adapterReadinessApi || !adapterFreshnessApi || !dexUiEnsureApi || !providerTargetSpawnApi || !chatgptNavigationRecoveryApi || !backgroundDispatchApi || !tabReadinessApi) {
  throw new Error('Bridge extension modules failed to load.');
}
const { createTabPublishController } = tabPublishApi; const { PROVIDERS, getProvider, providerForUrl, publicProviders } = providerApi;
const {
  isAiStudioTarget, rememberCompletedRequest, hasCompletedRequest,
  stopResponsePoll, stopAllResponsePolls, sampleAiStudioTab, startAiStudioResponsePoll
} = geminiPollApi;
const { ensureAiStudioBridgePopup, keepAiStudioPopupReady, findExistingAiStudioPopup, withAiStudioSubmissionWindow } = geminiStudioWindowApi; const { submitAiStudioPrompt } = geminiStudioSubmitApi;
let socket = null, reconnectTimer = null, heartbeatTimer = null, connectInFlight = false, targetTabId = null, targetProviderId = null, tabPublishController = null, targetRestoreAttempted = false; const selectedTargetStore = targetStateApi.createStore(), adapterReadiness = adapterReadinessApi.createCache();
const qualificationControl = qualificationControlApi.createControl({ chromeApi: globalThis.chrome, matchesProvider: (id, url) => providerMatchesUrl(getProvider(id), url) });
async function clearSelectedTarget() { targetTabId = null; targetProviderId = null; await selectedTargetStore.clear(); }
async function restoreSelectedTarget() {
  if (targetRestoreAttempted) return;
  targetRestoreAttempted = true;
  const saved = await selectedTargetStore.read();
  if (!saved) return;
  const provider = getProvider(saved.providerId);
  if (!provider) return selectedTargetStore.clear();
  let tab = null;
  try {
    const current = await chrome.tabs.get(saved.tabId);
    if (providerMatchesUrl(provider, String(current?.url || current?.pendingUrl || ''))) tab = current;
  } catch {}
  if (!tab && saved.url) tab = await targetResurrectionApi.findExisting({ provider, url: saved.url, chromeApi: chrome });
  if (!tab) return selectedTargetStore.clear();
  targetTabId = tab.id; targetProviderId = provider.id;
  await selectedTargetStore.write(targetTabId, targetProviderId, tab.url || tab.pendingUrl || saved.url || '');
}
function safeSend(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}
function emitError(code, message, requestId = null, detail = null) {
  safeSend({ type: 'error', code, message, requestId, detail });
}
async function getProviderTabs() {
  const all = [];
  let popupWindowIds = new Set();
  try {
    const windows = await chrome.windows?.getAll?.({ populate: true });
    if (Array.isArray(windows)) {
      for (const w of windows) {
        if (w.type === 'popup' || (Array.isArray(w.tabs) && w.tabs.length <= 1)) {
          popupWindowIds.add(w.id);
        }
      }
    }
  } catch {}
  for (const provider of PROVIDERS) {
    const tabs = await chrome.tabs.query({ url: provider.matchPatterns });
    for (const tab of tabs) {
      const isPopup = popupWindowIds.has(tab.windowId);
      const titlePrefix = isPopup ? '[Popup] ' : '';
      all.push(targetMetadataApi.formatTarget(tab, provider, { titlePrefix, health: providerHealthApi.get(tab.id) }));
    }
  }
  return all;
}
function currentTargetFromTabs(tabs) {
  if (targetTabId == null || !targetProviderId) return null;
  return tabs.find((tab) => tab.id === targetTabId && tab.providerId === targetProviderId) || null;
}
function getTabPublishController() {
  if (tabPublishController) return tabPublishController;
  tabPublishController = createTabPublishController({
    loadTabs: getProviderTabs,
    resolveTarget(tabs) {
      const target = currentTargetFromTabs(tabs);
      if (targetTabId != null && !target) clearSelectedTarget().catch(() => {});
      return target;
    },
    publicProviders,
    send: safeSend,
    onError: (error) => emitError('TAB_QUERY_FAILED', error.message)
  });
  return tabPublishController;
}
const publishTabs = (options) => getTabPublishController().publish(options);
const scheduleTabPublish = () => getTabPublishController().schedule();
async function probeScript(tabId, pingType, expectedAdapter, timeoutMs = 1500) {
  try {
    const probe = chrome.tabs.sendMessage(tabId, { type: pingType });
    const timer = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const pong = await Promise.race([probe, timer]);
    return !!pong?.ok && (!expectedAdapter || pong.adapter === expectedAdapter);
  } catch { return false; }
}
async function safeExecuteScript(details, timeoutMs = 10000) {
  const fileDesc = details.files?.join?.(',') || 'func';
  const run = chrome.scripting.executeScript(details);
  return Promise.race([run, new Promise((_, r) => setTimeout(() => r(new Error(`executeScript timeout for ${fileDesc}`)), timeoutMs))]);
}
const waitForTabComplete = (tabId, timeoutMs = 15000) => tabReadinessApi.waitForTabComplete(tabId, chrome, { timeoutMs });
async function clearContentGlobals(tabId, keys) {
  if (!keys?.length) return;
  await safeExecuteScript({
    target: { tabId },
    func: (names) => names.forEach((n) => { try { delete globalThis[n]; } catch { globalThis[n] = undefined; } }),
    args: [keys]
  }, 1500).catch(() => {});
}
async function ensureScriptGroup(tabId, group) {
  if (await probeScript(tabId, group.pingType, group.expectedAdapter)) return;
  await clearContentGlobals(tabId, group.globals);
  for (const file of group.files) await safeExecuteScript({ target: { tabId }, files: [file] });
  if (!(await probeScript(tabId, group.pingType, group.expectedAdapter))) {
    throw new Error(`${group.files.join(', ')} did not respond as ${group.expectedAdapter || 'expected'} after injection.`);
  }
}
async function ensureProviderAdapter(tabId, provider) {
  if (adapterReadiness.fresh(tabId, provider.id)) return;
  await adapterFreshnessApi.ensure(tabId, provider, chrome);
  adapterReadiness.mark(tabId, provider.id);
}
function providerMatchesUrl(provider, url) {
  if (!provider || !url) return false;
  const normalized = url.endsWith('/') ? url : `${url}/`;
  return provider.urlPrefixes.some((prefix) => url.startsWith(prefix) || normalized.startsWith(prefix));
}
function assertProviderMatchesTab(provider, tab) {
  const url = String(tab?.url || tab?.pendingUrl || '');
  if (!provider || !url || !providerMatchesUrl(provider, url)) {
    throw new Error('Selected tab does not match the requested provider.');
  }
}
async function prepareProviderTab(provider, tab) {
  if (!isAiStudioTarget(provider, tab)) return tab;
  const prepared = await ensureAiStudioBridgePopup(tab);
  return prepared?.tab || tab;
}
const formatTarget = targetMetadataApi.formatTarget;
async function selectTarget(tabId, requestedProviderId = null, options = {}) {
  if (!Number.isInteger(tabId)) throw new Error('Invalid tab ID.');
  if (!options.readyOnly) stopAllResponsePolls();
  let tab = await chrome.tabs.get(tabId);
  if (tab.discarded) { if (options.readyOnly) throw Object.assign(new Error('Warm qualification target is discarded and may not be reloaded.'), { code: 'QUALIFICATION_WARM_TARGET_NOT_READY' }); await chrome.tabs.reload(tab.id); await new Promise((r) => setTimeout(r, 800)); tab = await chrome.tabs.get(tabId); }
  const provider = requestedProviderId ? getProvider(requestedProviderId) : providerForUrl(tab.url);
  if (!provider) throw new Error('No supported provider matches the selected tab.');
  assertProviderMatchesTab(provider, tab);
  if (!options.readyOnly) await hostAccessApi.requireHostAccess(tab.id, tab.url || tab.pendingUrl || '', chrome.permissions);
  if (options.readyOnly) { const revision = await adapterFreshnessApi.probe(tab.id, chrome); if (!adapterFreshnessApi.current(revision)) throw Object.assign(new Error('Warm qualification target has a stale adapter revision and may not be reloaded.'), { code: 'QUALIFICATION_WARM_TARGET_NOT_READY' }); for (const group of provider.groups) if (group.expectedAdapter !== 'provider-health' && !(await probeScript(tab.id, group.pingType, group.expectedAdapter))) throw Object.assign(new Error('Warm qualification target lost adapter readiness and may not be reloaded.'), { code: 'QUALIFICATION_WARM_TARGET_NOT_READY' }); }
  else { tab = await prepareProviderTab(provider, tab); await ensureProviderAdapter(tab.id, provider); }
  targetTabId = tab.id; targetProviderId = provider.id;
  await selectedTargetStore.write(targetTabId, targetProviderId, tab.url || tab.pendingUrl || '');
  safeSend({ type: 'target_selected', requestId: options.requestId || null, target: formatTarget(tab, provider) });
  await publishTabs();
}
async function selectedProviderAndTab() {
  if (targetTabId != null && targetProviderId) {
    const provider = getProvider(targetProviderId);
    if (provider) {
      try {
        const tab = await chrome.tabs.get(targetTabId);
        const url = String(tab?.url || tab?.pendingUrl || '');
        if (providerMatchesUrl(provider, url)) return { provider, tab };
      } catch {}
    }
  }
  if (targetTabId != null || targetProviderId) await clearSelectedTarget();
  if (findExistingAiStudioPopup && chrome.tabs && chrome.windows) {
    try {
      const existing = await findExistingAiStudioPopup(chrome.tabs, chrome.windows);
      if (existing?.tab?.id != null) {
        targetTabId = existing.tab.id;
        targetProviderId = 'gemini';
        await selectedTargetStore.write(targetTabId, targetProviderId, existing.tab.url || '');
        const provider = getProvider('gemini');
        await ensureProviderAdapter(targetTabId, provider).catch(() => {});
        safeSend({ type: 'target_selected', target: formatTarget(existing.tab, provider) });
        publishTabs().catch(() => {});
        return { provider, tab: existing.tab };
      }
    } catch {}
  }
  if (targetTabId == null || !targetProviderId) throw new Error('No browser AI target is selected.');
  const provider = getProvider(targetProviderId);
  if (!provider) throw new Error('Selected provider is no longer registered.');
  const tab = await chrome.tabs.get(targetTabId);
  const name = provider.name; await clearSelectedTarget();
  safeSend({ type: 'target_lost', message: `Selected tab navigated away from ${name}.` });
  throw new Error(`Selected tab is no longer on ${name}.`);
}
async function sendToTarget(message, options = {}) {
  const pinned = options.tabId != null || options.providerId != null; let tabId = pinned ? Number(options.tabId) : targetTabId, provider = pinned ? getProvider(options.providerId) : null;
  if (pinned) { if (!Number.isInteger(tabId) || !provider) throw Object.assign(new Error('Qualification target authorization is missing.'), { code: options.readyOnly ? 'QUALIFICATION_WARM_TARGET_NOT_READY' : 'QUALIFICATION_TARGET_MISMATCH' }); let tab; try { tab = await chrome.tabs.get(tabId); } catch { throw Object.assign(new Error(options.readyOnly ? 'Warm qualification target disappeared and may not fall back to another tab.' : 'Qualification target disappeared and may not fall back to another tab.'), { code: options.readyOnly ? 'QUALIFICATION_WARM_TARGET_NOT_READY' : 'QUALIFICATION_TARGET_MISMATCH' }); } assertProviderMatchesTab(provider, tab); } else { ({ provider } = await selectedProviderAndTab()); tabId = targetTabId; }
  if (options.readyOnly) { const revision = await adapterFreshnessApi.probe(tabId, chrome); if (!adapterFreshnessApi.current(revision)) throw Object.assign(new Error('Warm qualification target has a stale adapter revision and may not be reloaded.'), { code: 'QUALIFICATION_WARM_TARGET_NOT_READY' }); for (const group of provider.groups) if (!(await probeScript(tabId, group.pingType, group.expectedAdapter))) throw Object.assign(new Error('Warm qualification target lost adapter readiness and may not be reloaded.'), { code: 'QUALIFICATION_WARM_TARGET_NOT_READY' }); } else await ensureProviderAdapter(tabId, provider);
  if (message?.type === 'send_prompt') return backgroundDispatchApi.sendMessage(tabId, message, chrome);
  return chrome.tabs.sendMessage(tabId, message);
}
async function getSearchResultsWithCollapsedRecovery(requestId, searchIndex, sendFn = sendToTarget) {
  let result = await sendFn({ type: 'get_search_results', requestId, searchIndex });
  if (result?.ok) return result;
  let recovery = null;
  try {
    recovery = await sendFn({ type: 'recover_search_stage', requestId, searchIndex });
    if (!recovery?.ok) {
      return {
        ...result,
        ok: false,
        error: recovery?.error || result?.error || 'Collapsed DeepSeek search-stage recovery failed.'
      };
    }
    return await sendFn({ type: 'get_search_results', requestId, searchIndex });
  } finally {
    if (recovery?.restoreToken) {
      sendFn({ type: 'restore_search_stage', restoreToken: recovery.restoreToken }).catch(() => {});
    }
  }
}
async function handleBridgeCommand(msg) {
  try {
    if (await qualificationControlApi.handleCommand(qualificationControl, msg, { chromeApi: chrome, getProvider, providerMatchesUrl, waitForTabComplete, selectTarget, clearSelectedTarget, publishTabs, targetResurrectionApi, safeSend, getSelection: async () => { if (targetTabId == null || !targetProviderId) return null; try { const tab = await chrome.tabs.get(targetTabId); return { tabId: targetTabId, providerId: targetProviderId, url: tab.url || tab.pendingUrl || '' }; } catch { return null; } } })) return;
    if (msg.type === 'reload_extension') { safeSend({ type: 'reloading_extension', requestId: msg.requestId || null }); chrome.runtime?.reload?.(); return; }
    if (msg.type === 'ensure_dex_ui') { await dexUiEnsureApi.ensureDexUiTab(chrome); return; }
    if (msg.type === 'reload_tab') {
      const id = Number(msg.tabId);
      if (msg.hard) { const t = await chrome.tabs.get(id); await chrome.tabs.update(id, { url: 'about:blank' }); await new Promise((r) => setTimeout(r, 400)); await chrome.tabs.update(id, { url: msg.url || t.url || 'https://muse.ai/' }); }
      else await chrome.tabs?.reload?.(id, { bypassCache: true });
      safeSend({ type: 'tab_reloaded', tabId: id }); return;
    }
    if (msg.type === 'request_tabs') return await publishTabs({ force: true });
    if (await providerTargetSpawnApi.handle(msg, { chromeApi: chrome, getProvider, waitForTabComplete, ensureProviderAdapter, publishTabs, safeSend })) return;
    if (msg.type === 'ensure_target') {
      const provider = getProvider(msg.providerId);
      const url = String(msg.url || '');
      if (!provider || !providerMatchesUrl(provider, url)) throw new Error('ensure_target requires an exact supported provider URL.');
      let { tab } = await targetResurrectionApi.ensure({ provider, url, chromeApi: chrome, open: true });
      if (!tab?.id) throw new Error('Could not restore the requested provider target.');
      if (tab.status !== 'complete') tab = await waitForTabComplete(tab.id);
      await selectTarget(Number(tab.id), provider.id);
      safeSend({ type: 'target_ensured', requestId: msg.requestId || null, target: formatTarget(tab, provider) });
      return;
    }
    if (msg.type === 'select_target') {
      return await selectTarget(Number(msg.tabId), msg.providerId || null, { requestId: msg.requestId || null });
    }
    if (msg.type === 'send_prompt') {
      if (typeof msg.text !== 'string' || !msg.text.trim()) throw new Error('Prompt text is empty.'); await providerHealthApi.assertSendable(chrome, targetTabId, targetProviderId);
      const qualificationClaim = msg.qualification?.runId ? await qualificationControl.claimPrompt({ runId: msg.qualification.runId, providerId: targetProviderId, tabId: targetTabId, requestId: msg.requestId, text: msg.text }) : null;
      const warmQualification = msg.qualification?.targetMode === 'preexisting-warm', authorizedTabId = qualificationClaim ? Number(qualificationClaim.recoveryTarget?.tabId ?? qualificationClaim.tabId) : targetTabId;
      let { provider, tab } = qualificationClaim ? { provider: getProvider(qualificationClaim.providerId), tab: await chrome.tabs.get(authorizedTabId) } : await selectedProviderAndTab(), deliveryProof = null, submissionMode = null;
      if (warmQualification && isAiStudioTarget(provider, tab)) throw Object.assign(new Error('Warm qualification does not use AI Studio window-management targets.'), { code: 'QUALIFICATION_WARM_TARGET_UNSUPPORTED' });
      if (isAiStudioTarget(provider, tab)) {
        tab = await keepAiStudioPopupReady(tab);
        const studioTransaction = await withAiStudioSubmissionWindow(tab, {
          run: async () => {
            const baseline = await sampleAiStudioTab(tab.id);
            if (!baseline || !Number.isFinite(Number(baseline.userCount))) return { submitted: { ok: false, code: 'PROMPT_DELIVERY_UNCOMMITTED', error: 'AI Studio baseline could not be observed.' } };
            const submitted = await submitAiStudioPrompt({ tabId: tab.id, text: msg.text });
            return { submitted, baseline };
          }
        });
        const submitted = studioTransaction?.submitted;
        if (!submitted?.ok || submitted?.deliveryProof?.committed !== true) {
          throw Object.assign(new Error(submitted?.error || 'Google AI Studio submission remains uncommitted.'), { code: submitted?.code || 'PROMPT_DELIVERY_UNCOMMITTED' });
        }
        deliveryProof = submitted.deliveryProof;
        submissionMode = 'studio-' + submitted.method;
        if (studioTransaction.windowRestored === false) console.warn('[bridge] AI Studio submitted, but popup state restoration failed:', studioTransaction.windowRestoreError);
        startAiStudioResponsePoll({ tabId: tab.id, targetWindowId: tab.windowId, requestId: msg.requestId,
          baseline: studioTransaction.baseline, expectedPrompt: msg.text, send: safeSend });
      } else {
        const initialUrl = tab.url || tab.pendingUrl || '';
        const result = await sendToTarget({ type: 'send_prompt', requestId: msg.requestId, text: msg.text, qualification: msg.qualification || null }, { readyOnly: warmQualification, tabId: qualificationClaim ? authorizedTabId : null, providerId: qualificationClaim?.providerId || null });
        if (!result?.ok) throw Object.assign(new Error(result?.error || `${provider.name} adapter rejected the prompt.`), { code: result?.code || 'PROMPT_SEND_FAILED', detail: result?.detail || null }); deliveryProof = result.deliveryProof || null; submissionMode = result.submissionMode || null; if (deliveryProof && deliveryProof.committed !== true) throw Object.assign(new Error('Provider adapter returned an uncommitted prompt delivery proof.'), { code: 'PROMPT_DELIVERY_UNCOMMITTED', detail: { deliveryProof } });
        if (!qualificationClaim && provider.id === 'chatgpt') chatgptNavigationRecoveryApi.start({ requestId: msg.requestId, tabId: tab.id, initialUrl, chromeApi: chrome, send: safeSend, completed: hasCompletedRequest, rememberCompleted: rememberCompletedRequest });
      }
      if (msg.qualification?.runId) { await qualificationControl.notePrompt({ runId: msg.qualification.runId, providerId: provider.id, tabId: authorizedTabId, requestId: msg.requestId, text: msg.text }); safeSend({ type: 'qualification_dispatch_committed', requestId: msg.requestId, runId: msg.qualification.runId, tabId: authorizedTabId, providerId: provider.id }); }
      safeSend({ type: 'prompt_accepted', requestId: msg.requestId, tabId: qualificationClaim ? authorizedTabId : targetTabId, providerId: provider.id, providerName: provider.name, submissionMode, deliveryProof, observedAt: Date.now() });
      return;
    }
    if (msg.type === 'capture_latest') {
      const warmQualification = msg.qualification?.targetMode === 'preexisting-warm';
      const authorized = msg.qualification?.runId ? await qualificationControl.assertPromptTarget({ runId: msg.qualification.runId }) : null;
      const selected = authorized ? null : await selectedProviderAndTab();
      const authorizedTabId = authorized ? Number(authorized.record.recoveryTarget?.tabId ?? authorized.record.tabId) : targetTabId, provider = authorized ? getProvider(authorized.record.providerId) : selected.provider, tab = authorized ? await chrome.tabs.get(authorizedTabId) : selected.tab;
      const result = isAiStudioTarget(provider, tab)
        ? await sampleAiStudioTab(tab.id, chrome.scripting, msg.expectedPrompt || '').then((sample) => ({ text: sample.text, isGenerating: sample.generating, observedAt: Date.now(), completenessHint: sample.generating ? 'unknown' : 'settled' }))
        : await sendToTarget({ type: 'capture_latest', requestId: msg.requestId, expectedPrompt: msg.expectedPrompt || '' }, { readyOnly: warmQualification, tabId: authorized ? authorizedTabId : null, providerId: authorized?.record?.providerId || null });
      const generationState = result?.generationState || (result?.isGenerating === true ? 'active' : result?.isGenerating === false ? 'idle' : 'unknown');
      safeSend({ type: 'capture_result', requestId: msg.requestId, text: result?.text || '', isGenerating: result?.isGenerating === true, generationState, observedAt: result?.observedAt || Date.now(), completenessHint: result?.completenessHint || null, tabId: authorized ? authorizedTabId : targetTabId, adapterRevision: adapterFreshnessApi.ADAPTER_REVISION, providerId: provider.id, providerName: provider.name });
      return;
    }
    if (msg.type === 'request_search_results') {
      const { provider } = await selectedProviderAndTab();
      if (!provider.capabilities.searchResults) {
        throw new Error(`${provider.name} does not expose search-result capture in this bridge yet.`);
      }
      const searchIndex = Number.isInteger(Number(msg.searchIndex)) ? Number(msg.searchIndex) : 0;
      const result = await getSearchResultsWithCollapsedRecovery(msg.requestId, searchIndex);
      safeSend({
        type: 'search_results_result',
        requestId: msg.requestId,
        searchIndex,
        providerId: provider.id,
        providerName: provider.name,
        ok: !!result?.ok,
        label: result?.label || '',
        expectedCount: result?.expectedCount ?? null,
        results: Array.isArray(result?.results) ? result.results : [],
        error: result?.error || null
      });
    }
  } catch (error) {
    emitError(error.code || 'COMMAND_FAILED', error.message, msg.requestId || null, error.detail || (msg.type === 'request_search_results' ? { searchIndex: msg.searchIndex ?? 0 } : null));
  }
}
async function localRelayReady() {
  try {
    const response = await fetch(HEALTH_URL, { cache: 'no-store' });
    return response.ok;
  } catch {
    return false;
  }
}
async function connect() {
  clearTimeout(reconnectTimer);
  if (connectInFlight) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  connectInFlight = true;
  try {
    await restoreSelectedTarget();
    if (!(await localRelayReady())) {
      reconnectTimer = setTimeout(connect, 1200);
      return;
    }
    socket = new WebSocket(WS_URL);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'hello', role: 'extension' }));
      safeSend({ type: 'extension_hello', version: chrome.runtime.getManifest().version });
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => safeSend({ type: 'ping', at: Date.now() }), 20000);
    });
    socket.addEventListener('message', (event) => {
      try { handleBridgeCommand(JSON.parse(event.data)); }
      catch (error) { emitError('BAD_SERVER_MESSAGE', error.message); }
    });
    socket.addEventListener('close', () => {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      socket = null;
      tabPublishController?.reset();
      reconnectTimer = setTimeout(connect, 1200);
    });
    socket.addEventListener('error', () => {});
  } finally {
    connectInFlight = false;
  }
}
if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (providerHealthApi.handle(msg, sender, { providerForUrl, safeSend, scheduleTabPublish })) return; if (!sender.tab?.id || sender.tab.id !== targetTabId) return;
    const allowed = new Set(['response_partial', 'response_final', 'response_activity', 'activity_update', 'adapter_error']);
    if (!allowed.has(msg.type)) return;
    const provider = getProvider(targetProviderId);
    if (!provider) return;
    if (msg.type === 'adapter_error') {
      if (msg.requestId) { stopResponsePoll(msg.requestId); chatgptNavigationRecoveryApi.stop(msg.requestId); }
      if (hasCompletedRequest(msg.requestId)) return;
      emitError(msg.code || 'ADAPTER_ERROR', msg.message || `${provider.name} adapter error.`, msg.requestId || null, msg.detail || null);
      return;
    }
    if (hasCompletedRequest(msg.requestId)) return;
    if (msg.type === 'response_final' && msg.requestId) {
      stopResponsePoll(msg.requestId);
      chatgptNavigationRecoveryApi.stop(msg.requestId);
      rememberCompletedRequest(msg.requestId);
      if (provider.capabilities.activity) {
        chrome.tabs.sendMessage(targetTabId, { type: 'activity_stop', requestId: msg.requestId }).catch(() => {});
      }
    }
    safeSend({ ...msg, providerId: provider.id, providerName: provider.name });
  });
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    adapterReadiness.invalidate(tabId); providerHealthApi.forget(tabId);
    if (qualificationControl.consumeClosingTab(tabId)) return;
    if (tabId === targetTabId) {
      stopAllResponsePolls(); chatgptNavigationRecoveryApi.clear();
      if (targetProviderId === 'gemini' && findExistingAiStudioPopup && chrome.tabs && chrome.windows) {
        try {
          const existing = await findExistingAiStudioPopup(chrome.tabs, chrome.windows, tabId);
          if (existing?.tab?.id != null) {
            targetTabId = existing.tab.id;
            targetProviderId = 'gemini';
            await selectedTargetStore.write(targetTabId, targetProviderId, existing.tab.url || '');
            const provider = getProvider('gemini');
            await ensureProviderAdapter(targetTabId, provider).catch(() => {});
            safeSend({ type: 'target_selected', target: formatTarget(existing.tab, provider) });
            scheduleTabPublish();
            return;
          }
        } catch {}
      }
      const provider = getProvider(targetProviderId);
      await clearSelectedTarget();
      safeSend({ type: 'target_lost', message: `Selected ${provider?.name || 'provider'} tab was closed.` });
    }
    scheduleTabPublish();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' || changeInfo.url) { adapterReadiness.invalidate(tabId); providerHealthApi.forget(tabId); }
    if (tabId === targetTabId && changeInfo.url) {
      const provider = getProvider(targetProviderId);
      if (!provider || !providerMatchesUrl(provider, changeInfo.url)) {
        stopAllResponsePolls(); chatgptNavigationRecoveryApi.clear();
        const name = provider?.name || 'provider';
        clearSelectedTarget().catch(() => {});
        safeSend({ type: 'target_lost', message: `Selected tab navigated away from ${name}.` });
      }
    }
    if (changeInfo.status === 'complete' || changeInfo.url) scheduleTabPublish();
  });
  chrome.runtime.onInstalled.addListener(() => connect());
  chrome.runtime.onStartup.addListener(() => connect());
  connect();
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getSearchResultsWithCollapsedRecovery, isAiStudioTarget, prepareProviderTab, PROVIDERS, getProvider, providerForUrl };
}
