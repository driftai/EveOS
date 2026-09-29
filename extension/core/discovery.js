(function (root, factory) {
  const api = factory(
    root.EveOSExtensionProtocol || (typeof require === 'function' ? require('./protocol.js') : null),
    root.EveOSExtensionCatalog || (typeof require === 'function' ? require('./catalog.js') : null)
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EveOSExtensionDiscovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (protocol, catalog) {
  'use strict';

  const STORAGE_KEY = 'eveosExtensionHubConnectorsV1';

  function create({ chromeApi, fetchImpl }) {
    const timeout = (promise, ms = 1600) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);

    async function probeExtension(info) {
      try {
        const value = await timeout(chromeApi.runtime.sendMessage(
          info.id,
          protocol.request(protocol.REQUESTS.DESCRIBE)
        ));
        if (!protocol.isResponse(value)) return null;
        return catalog.descriptor(value.detail, info);
      } catch (_error) {
        return null;
      }
    }

    async function health(service) {
      try {
        const response = await timeout(fetchImpl(service.health, { cache: 'no-store' }));
        const payload = await response.json().catch(() => ({}));
        return { ...service, online: response.ok && payload?.ok !== false, detail: payload };
      } catch (_error) {
        return { ...service, online: false, detail: {} };
      }
    }

    async function saved() {
      const value = await chromeApi.storage.local.get(STORAGE_KEY);
      return Array.isArray(value?.[STORAGE_KEY]) ? value[STORAGE_KEY] : [];
    }

    async function scan() {
      const all = await chromeApi.management.getAll();
      const candidates = all.filter(info => catalog.candidate(info, chromeApi.runtime.id));
      const connectors = (await Promise.all(candidates.map(probeExtension))).filter(Boolean);
      await chromeApi.storage.local.set({ [STORAGE_KEY]: connectors });
      return snapshot(connectors);
    }

    async function refresh() {
      const prior = await saved();
      const connectors = (await Promise.all(prior.map(info => probeExtension({
        id: info.extensionId,
        name: info.name,
        version: info.version,
        description: info.description,
        enabled: true,
        type: 'extension'
      })))).filter(Boolean);
      if (connectors.length !== prior.length) await chromeApi.storage.local.set({ [STORAGE_KEY]: connectors });
      return snapshot(connectors);
    }

    async function snapshot(connectors) {
      const services = await Promise.all(catalog.services.map(health));
      const included = await globalThis.EveOSExtensionModules?.describe?.() || [];
      const includedIds = new Set(included.map(item => item.id));
      return { generatedAt: Date.now(), services,
        connectors: [...included, ...connectors.filter(item => !includedIds.has(item.id))] };
    }

    return Object.freeze({ scan, refresh, probeExtension, health });
  }

  return Object.freeze({ STORAGE_KEY, create });
});
