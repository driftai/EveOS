'use strict';
(() => {
  const DEFAULT_PROBE_TIMEOUT_MS = 1000;
  const CONTROL_PING_TYPE = 'dex_provider_control_worker_ping';
  const WORKER_PROBE_TYPE = 'dex_provider_control_worker_probe';
  const WORKER_EPOCH = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let workerProbeInstalled = false;

  function installWorkerProbe(chromeApi = globalThis.chrome) {
    if (workerProbeInstalled || !chromeApi?.runtime?.onMessage?.addListener) return false;
    chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== WORKER_PROBE_TYPE) return;
      const matches = String(message.workerEpoch || '') === WORKER_EPOCH;
      sendResponse({ ok: matches, adapter: 'dex-provider-control-worker', workerEpoch: WORKER_EPOCH });
      return false;
    });
    workerProbeInstalled = true;
    return true;
  }

  function providerForTab(providers = [], tab = {}) {
    const url = String(tab?.url || tab?.pendingUrl || '');
    if (!url) return null;
    return providers.find((provider) => (provider?.urlPrefixes || []).some((prefix) =>
      url.startsWith(prefix) || `${url}/`.startsWith(prefix))) || null;
  }

  async function probeGroup(tabId, group, chromeApi = globalThis.chrome, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
    try {
      const workerBound = group.expectedAdapter === 'dex-provider-control';
      const message = workerBound
        ? { type: CONTROL_PING_TYPE, workerEpoch: WORKER_EPOCH }
        : { type: group.pingType };
      const probe = chromeApi.tabs.sendMessage(Number(tabId), message);
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
      const result = await Promise.race([probe, timeout]);
      return !!result?.ok && (!group.expectedAdapter || result.adapter === group.expectedAdapter)
        && (!workerBound || result.workerEpoch === WORKER_EPOCH);
    } catch {
      return false;
    }
  }

  async function clearGlobals(tabId, globals, chromeApi = globalThis.chrome) {
    if (!globals?.length) return;
    await chromeApi.scripting.executeScript({
      target: { tabId: Number(tabId) },
      func: (names) => names.forEach((name) => {
        try { globalThis[name]?.dispose?.(); } catch {}
        try { delete globalThis[name]; }
        catch { try { globalThis[name] = undefined; } catch {} }
      }),
      args: [globals]
    }).catch(() => {});
  }

  async function rehydrateGroup(tabId, group, chromeApi = globalThis.chrome, resolveAsset = (value) => value) {
    if (await probeGroup(tabId, group, chromeApi)) return false;
    await clearGlobals(tabId, group.globals, chromeApi);
    for (const file of group.files || []) {
      await chromeApi.scripting.executeScript({
        target: { tabId: Number(tabId) },
        files: [resolveAsset(file)]
      });
    }
    if (!(await probeGroup(tabId, group, chromeApi))) {
      const error = new Error(`Provider content group ${group.expectedAdapter || group.pingType || 'unknown'} did not recover after extension reload.`);
      error.code = 'PROVIDER_CONTENT_REHYDRATION_FAILED';
      throw error;
    }
    return true;
  }

  async function rehydrateTab(tab, provider, chromeApi = globalThis.chrome, resolveAsset = (value) => value) {
    if (!tab?.id || tab.discarded || (tab.status && tab.status !== 'complete') || !provider) {
      return { ok: true, skipped: true, rehydratedGroups: 0 };
    }
    let rehydratedGroups = 0;
    for (const group of provider.groups || []) {
      if (await rehydrateGroup(tab.id, group, chromeApi, resolveAsset)) rehydratedGroups += 1;
    }
    return { ok: true, skipped: false, rehydratedGroups };
  }

  async function rehydrateOpenProviderTabs({
    chromeApi = globalThis.chrome,
    providers = globalThis.BrowserAiBridgeProviders?.PROVIDERS || [],
    resolveAsset = (file) => globalThis.BrowserAiBridgeExtensionAssets?.path?.(file) || file
  } = {}) {
    if (!chromeApi?.tabs?.query || !chromeApi?.tabs?.sendMessage || !chromeApi?.scripting?.executeScript) {
      return { scanned: 0, rehydratedTabs: 0, rehydratedGroups: 0, failed: [] };
    }
    const tabs = await chromeApi.tabs.query({});
    let scanned = 0, rehydratedTabs = 0, rehydratedGroups = 0;
    const failed = [];
    for (const tab of tabs || []) {
      const provider = providerForTab(providers, tab);
      if (!provider || tab.discarded || (tab.status && tab.status !== 'complete')) continue;
      scanned += 1;
      try {
        const result = await rehydrateTab(tab, provider, chromeApi, resolveAsset);
        if (result.rehydratedGroups > 0) rehydratedTabs += 1;
        rehydratedGroups += result.rehydratedGroups;
      } catch (error) {
        failed.push({ tabId: tab.id, providerId: provider.id, code: error.code || 'PROVIDER_CONTENT_REHYDRATION_FAILED', message: String(error.message || error) });
      }
    }
    return { scanned, rehydratedTabs, rehydratedGroups, failed };
  }

  async function autoRehydrate() {
    const providers = globalThis.BrowserAiBridgeProviders?.PROVIDERS || [];
    if (!providers.length) return null;
    const result = await rehydrateOpenProviderTabs({ providers });
    if (result.rehydratedTabs || result.failed.length) {
      console.info('[bridge] provider content rehydration', result);
    }
    return result;
  }

  const api = {
    DEFAULT_PROBE_TIMEOUT_MS,
    CONTROL_PING_TYPE,
    WORKER_PROBE_TYPE,
    WORKER_EPOCH,
    installWorkerProbe,
    providerForTab,
    probeGroup,
    clearGlobals,
    rehydrateGroup,
    rehydrateTab,
    rehydrateOpenProviderTabs,
    autoRehydrate
  };
  globalThis.BrowserAiBridgeProviderContentRehydration = api;

  // MV3 extension reloads invalidate already-open provider content-script contexts.
  // Schedule one post-bootstrap pass in the new worker so those tabs regain their
  // adapters/provider-control scanner without a manual page refresh or tab reload.
  if (typeof chrome !== 'undefined' && chrome?.runtime && chrome?.tabs && chrome?.scripting) {
    installWorkerProbe(chrome);
    Promise.resolve().then(() => autoRehydrate()).catch((error) =>
      console.warn('[bridge] provider content rehydration failed:', error?.message || error));
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
