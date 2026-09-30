/* Generated from config/eveos-ports.json by tools/audit/sync-nexus-browser-port.js. */
(() => {
  const port = 9088;
  const controlPort = 9082;
  const httpOrigin = `http://127.0.0.1:${port}`;
  const config = Object.freeze({
    port,
    httpOrigin,
    controlOrigin: `http://127.0.0.1:${controlPort}`,
    healthUrl: `${httpOrigin}/health`,
    websocketUrl: `ws://127.0.0.1:${port}/ws`,
    dexUrl: `${httpOrigin}/?mode=dex`,
    tabPattern: `${httpOrigin}/*`
  });
  globalThis.NexusBrowserRuntimeConfig = config;
  if (typeof module !== 'undefined' && module.exports) module.exports = config;
})();
