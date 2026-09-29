/* The assembly supplies paths; each tool owns its implementation in both packages. */
(function () {
  'use strict';
  const handlers = new Map();
  const roots = globalThis.EveOSExtensionModuleRoots || {};
  globalThis.EveOSExtensionModules = Object.freeze({
    register(id, handler) {
      if (handlers.has(id)) throw new Error(`Duplicate EveOS module: ${id}`);
      handlers.set(id, handler);
    },
    async invoke(id, request) {
      const handler = handlers.get(id);
      if (!handler) throw new Error(`EveOS module unavailable: ${id}`);
      return handler(request);
    },
    async describe() {
      return Promise.all([...handlers.keys()].map(async id => {
        const result = await handlers.get(id)(globalThis.EveOSExtensionProtocol.request('describe'));
        return globalThis.EveOSExtensionCatalog.descriptor(result.detail, {
          id: chrome.runtime.id, integration: 'included', moduleId: id
        });
      }));
    }
  });

  const nativeImport = globalThis.importScripts.bind(globalThis);
  for (const entry of globalThis.EveOSExtensionModuleEntries || []) {
    const root = roots[entry.id];
    if (!root || !/^modules\/[a-z0-9-]+\/$/.test(root)) throw new Error('Invalid module root');
    // Classic workers resolve nested imports against the main worker, not the imported file.
    globalThis.importScripts = (...paths) => nativeImport(...paths.map(value => {
      if (/^(?:[a-z]+:|\/|\.\.)/i.test(value)) throw new Error('Invalid module import');
      return chrome.runtime.getURL(root + value);
    }));
    try { globalThis.importScripts(entry.entry); }
    finally { globalThis.importScripts = nativeImport; }
  }
})();
