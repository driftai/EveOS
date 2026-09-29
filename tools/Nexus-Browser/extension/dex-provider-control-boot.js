(() => {
  const CONTROL_SCRIPT = 'content/dex-provider-control.js';
  const PING = { type: 'dex_provider_control_ping' };
  const hostAccess = globalThis.BrowserAiBridgeHostAccess || (typeof module !== 'undefined' && module.exports ? require('./host-access.js') : null);

  function providerPatterns(manifest = chrome.runtime.getManifest()) {
    const patterns = [];
    const file = globalThis.BrowserAiBridgeExtensionAssets?.path(CONTROL_SCRIPT) || CONTROL_SCRIPT;
    for (const entry of manifest?.content_scripts || []) {
      if (!(entry.js || []).includes(file)) continue;
      patterns.push(...(entry.matches || []));
    }
    return [...new Set(patterns)];
  }

  function providerForTab(tab) {
    return globalThis.BrowserAiBridgeProviders?.providerForUrl?.(String(tab?.url || tab?.pendingUrl || '')) || null;
  }

  async function ping(tabId) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, PING);
      return !!result?.ok && result.adapter === 'dex-provider-control';
    } catch {
      return false;
    }
  }

  async function ensureTab(tabId, { refreshAdapter = false } = {}) {
    if (!Number.isInteger(tabId)) return false;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !(await hostAccess.hasHostAccess(tab.url || tab.pendingUrl || '')).ok) return false;

    if (refreshAdapter) {
      const provider = providerForTab(tab);
      const freshness = globalThis.BrowserAiBridgeProviderAdapterFreshness;
      if (provider && freshness?.ensure) {
        try {
          await freshness.ensure(tabId, provider, chrome);
          return ping(tabId);
        } catch {
          return false;
        }
      }
    }

    if (await ping(tabId)) return true;
    try {
      const file = globalThis.BrowserAiBridgeExtensionAssets?.path(CONTROL_SCRIPT) || CONTROL_SCRIPT;
      const inject = chrome.scripting.executeScript({ target: { tabId }, files: [file] });
      await Promise.race([inject, new Promise((_, reject) => setTimeout(() => reject(new Error('provider-control injection timeout')), 2500))]);
    } catch {
      return false;
    }
    return ping(tabId);
  }

  async function ensureOpenProviderTabs() {
    const patterns = providerPatterns();
    if (!patterns.length) return { checked: 0, ready: 0 };
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: patterns }); }
    catch { return { checked: 0, ready: 0 }; }
    tabs.sort((a, b) => Number(!!b.active) - Number(!!a.active));
    let ready = 0;
    for (const tab of tabs) {
      if (await ensureTab(tab.id, { refreshAdapter: !!tab.active })) ready += 1;
    }
    return { checked: tabs.length, ready };
  }

  function scheduleBootstrap(delay) {
    setTimeout(() => ensureOpenProviderTabs().catch(() => {}), delay);
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.tabs && chrome.scripting) {
    scheduleBootstrap(500);
    scheduleBootstrap(2500);
    chrome.tabs.onActivated?.addListener(({ tabId }) => {
      setTimeout(() => ensureTab(Number(tabId), { refreshAdapter: true }).catch(() => {}), 150);
    });
  }

  const api = { CONTROL_SCRIPT, providerPatterns, providerForTab, ping, ensureTab, ensureOpenProviderTabs, scheduleBootstrap };
  globalThis.BrowserAiBridgeDexProviderControlBoot = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
