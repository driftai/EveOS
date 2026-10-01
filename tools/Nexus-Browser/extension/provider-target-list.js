(() => {
  function createLoader({
    chromeApi = globalThis.chrome,
    providers = [],
    formatTarget,
    healthFor = () => null,
    decorateTarget = (target) => target
  } = {}) {
    if (typeof formatTarget !== 'function') throw new Error('Provider target formatter is required.');

    return async function loadProviderTargets() {
      const all = [];
      const popupWindowIds = new Set();
      try {
        const windows = await chromeApi.windows?.getAll?.({ populate: true });
        if (Array.isArray(windows)) {
          for (const windowInfo of windows) {
            if (windowInfo.type === 'popup'
                || (Array.isArray(windowInfo.tabs) && windowInfo.tabs.length <= 1)) {
              popupWindowIds.add(windowInfo.id);
            }
          }
        }
      } catch {}

      for (const provider of providers) {
        const tabs = await chromeApi.tabs.query({ url: provider.matchPatterns });
        for (const tab of tabs) {
          const titlePrefix = popupWindowIds.has(tab.windowId) ? '[Popup] ' : '';
          const target = formatTarget(tab, provider, {
            titlePrefix,
            health: healthFor(tab.id)
          });
          all.push(decorateTarget(target) || target);
        }
      }
      return all;
    };
  }

  const api = { createLoader };
  globalThis.BrowserAiBridgeProviderTargetList = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
