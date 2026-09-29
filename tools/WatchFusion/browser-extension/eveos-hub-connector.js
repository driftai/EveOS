(function () {
  'use strict';

  const CHANNEL = 'eveos.extension.v1';
  const VERSION = 1;
  const dashboardUrl = 'http://127.0.0.1:9087/';

  function response(type, detail) {
    return { channel: CHANNEL, version: VERSION, type, ok: true, detail };
  }

  async function serviceStatus() {
    let linked = false;
    try {
      linked = Number.isInteger((await chrome.storage.session.get('sourceTab')).sourceTab);
    } catch (_error) {}
    try {
      const result = await fetch(`${dashboardUrl}api/health`, { cache: 'no-store' });
      const payload = await result.json().catch(() => ({}));
      return { online: result.ok && payload?.ok !== false, linked };
    } catch (_error) {
      return { online: false, linked };
    }
  }

  function description(status) {
    return {
      id: 'watchfusion',
      name: 'WatchFusion Media Link',
      description: 'Connects a selected browser tab to WatchFusion.',
      version: chrome.runtime.getManifest().version,
      dashboardUrl,
      capabilities: ['Selected-tab media', 'Playback controls', 'WatchFusion status'],
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
