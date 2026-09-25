(() => {
  const ADAPTER_REVISION = 39;
  if (typeof window !== 'undefined' && globalThis.__browserAiBridgeProviderAdapterRevisionLoaded === ADAPTER_REVISION) return;
  if (typeof window !== 'undefined') globalThis.__browserAiBridgeProviderAdapterRevisionLoaded = ADAPTER_REVISION;

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type !== 'provider_adapter_revision_ping') return;
      sendResponse({ ok: true, adapter: 'provider-adapter-revision', revision: ADAPTER_REVISION });
      return true;
    });
  }

  const api = { ADAPTER_REVISION };
  globalThis.BrowserAiBridgeProviderAdapterRevision = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
