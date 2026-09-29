(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EveOSExtensionCatalog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const services = Object.freeze([
    Object.freeze({ id: 'eveos', name: 'EveOS', url: 'http://127.0.0.1:8765/EveOS.html', health: 'http://127.0.0.1:8765/api/status' }),
    Object.freeze({ id: 'nexus-browser', name: 'Nexus Browser', url: 'http://127.0.0.1:9088/', health: 'http://127.0.0.1:9088/health' }),
    Object.freeze({ id: 'watchfusion', name: 'WatchFusion', url: 'http://127.0.0.1:9087/', health: 'http://127.0.0.1:9087/api/health' })
  ]);

  function candidate(info, selfId = '') {
    if (!info || info.id === selfId || info.enabled === false || info.type !== 'extension') return false;
    return /(?:eveos|nexus browser|watchfusion)/i.test(`${info.name || ''} ${info.description || ''}`);
  }

  function descriptor(value = {}, extension = {}) {
    const id = String(value.id || '').trim();
    if (!id) return null;
    return {
      id,
      extensionId: String(extension.id || value.extensionId || ''),
      name: String(value.name || extension.name || id),
      description: String(value.description || ''),
      version: String(value.version || extension.version || ''),
      capabilities: Array.isArray(value.capabilities) ? value.capabilities.map(String).slice(0, 24) : [],
      dashboardUrl: /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(value.dashboardUrl || '')
        ? String(value.dashboardUrl) : '',
      status: value.status && typeof value.status === 'object' ? value.status : {}
    };
  }

  return Object.freeze({ services, candidate, descriptor });
});
