/* Standalone paths are unchanged; the official package supplies a module root. */
(() => {
  const path = value => (globalThis.EveOSExtensionModuleRoots?.['nexus-browser'] || '') + value;
  globalThis.BrowserAiBridgeExtensionAssets = Object.freeze({ path });
})();
