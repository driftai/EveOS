(function () {
  'use strict';

  const CHANNEL = 'eveos.extension.v1';
  const VERSION = 1;
  const dashboardUrl = 'http://127.0.0.1:9088/';

  function response(type, detail) {
    return { channel: CHANNEL, version: VERSION, type, ok: true, detail };
  }

  async function serviceStatus() {
    try {
      const healthUrl = globalThis.NexusBrowserRuntimeConfig?.healthUrl
        || 'http://127.0.0.1:9088/health';
      const result = await fetch(healthUrl, { cache: 'no-store' });
      const payload = await result.json().catch(() => ({}));
      return { online: result.ok && payload?.ok !== false };
    } catch (_error) {
      return { online: false };
    }
  }

  function description(status) {
    return {
      id: 'nexus-browser',
      name: 'EveOS Nexus Browser',
      description: 'Authenticated AI-tab transport and Dex room bridge.',
      version: chrome.runtime.getManifest().version,
      dashboardUrl,
      capabilities: ['Provider routing', 'Dex rooms', 'Local agents'],
      status
    };
  }

  chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
    if (message?.channel !== CHANNEL || Number(message.version) !== VERSION) return;
    (async () => {
      const status = await serviceStatus();
      if (message.type === 'describe') return response('describe', description(status));
      if (message.type === 'status') return response('status', status);
      if (message.type === 'open') {
        await chrome.tabs.create({ url: dashboardUrl });
        return response('open', { opened: true });
      }
      return { channel: CHANNEL, version: VERSION, type: message.type, ok: false };
    })().then(sendResponse, () => sendResponse({ channel: CHANNEL, version: VERSION, ok: false }));
    return true;
  });
})();
