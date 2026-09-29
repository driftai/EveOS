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
    return !!info && info.id !== selfId && info.enabled !== false && info.type === 'extension';
  }

  function descriptor(value = {}, extension = {}) {
    const id = String(value.id || '').trim();
    if (!id) return null;
    return {
      id,
      extensionId: String(extension.id || value.extensionId || ''),
      integration: extension.integration === 'included' ? 'included' : 'standalone',
      moduleId: String(extension.moduleId || ''),
      name: String(value.name || extension.name || id),
      description: String(value.description || ''),
      version: String(value.version || extension.version || ''),
      capabilities: Array.isArray(value.capabilities) ? value.capabilities.map(String).slice(0, 24) : [],
      actions: Array.isArray(value.actions) ? value.actions.map(action => {
        const id = String(action?.id || '').trim();
        if (!id) return null;
        const input = action?.input && typeof action.input === 'object'
          ? { kind: action.input.kind === 'text' ? 'text' : '', placeholder: String(action.input.placeholder || '').slice(0, 120) }
          : null;
        return {
          id,
          label: String(action.label || id).slice(0, 80),
          description: String(action.description || '').slice(0, 160),
          input: input?.kind ? input : null
        };
      }).filter(Boolean).slice(0, 16) : [],
      dashboardUrl: /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(value.dashboardUrl || '')
        ? String(value.dashboardUrl) : '',
      status: value.status && typeof value.status === 'object' ? value.status : {}
    };
  }

  return Object.freeze({ services, candidate, descriptor });
});
