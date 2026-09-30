(function () {
  'use strict';

  const CHANNEL = 'eveos.extension.v1';
  const VERSION = 1;
  const dashboardUrl = `${globalThis.NexusBrowserRuntimeConfig.httpOrigin}/`;

  function response(type, detail) {
    return { channel: CHANNEL, version: VERSION, type, ok: true, detail };
  }

  async function serviceStatus() {
    return globalThis.NexusBrowserDashboard.status();
  }

  function description(status) {
    return {
      id: 'nexus-browser',
      name: 'EveOS Nexus Browser',
      description: 'Authenticated AI-tab transport and Dex room bridge.',
      version: chrome.runtime.getManifest().version,
      dashboardUrl,
      capabilities: ['Provider routing', 'Dex rooms', 'Local agents'],
      actions: [],
      status
    };
  }

  async function handle(message) {
    const status = await serviceStatus();
    if (message.type === 'describe') return response('describe', description(status));
    if (message.type === 'status') return response('status', status);
    if (message.type === 'open' || (message.type === 'invoke' && message.detail?.action === 'open-dashboard')) {
      return response(message.type, await globalThis.NexusBrowserDashboard.open());
    }
    return { channel: CHANNEL, version: VERSION, type: message.type, ok: false, code: 'UNKNOWN_ACTION' };
  }
  if (globalThis.EveOSExtensionModules) {
    globalThis.EveOSExtensionModules.register('nexus-browser', handle);
    return;
  }
  chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
    if (message?.channel !== CHANNEL || Number(message.version) !== VERSION) return;
    handle(message).then(sendResponse, () => sendResponse({ channel: CHANNEL, version: VERSION, ok: false }));
    return true;
  });
})();
