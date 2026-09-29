(function () {
  'use strict';

  const CHANNEL = 'eveos.extension.v1';
  const VERSION = 1;
  const dashboardUrl = 'http://127.0.0.1:9087/';

  function response(type, detail) {
    return { channel: CHANNEL, version: VERSION, type, ok: true, detail };
  }

  function failure(type, code, message) {
    return { channel: CHANNEL, version: VERSION, type, ok: false, code, message };
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
      actions: [
        {
          id: 'prepare-tab-link',
          label: 'Prepare tab link',
          description: 'Then click WatchFusion Media Link once on the source tab; Chrome requires that companion click before tab capture.',
          input: { kind: 'text', placeholder: 'Paste private pairing link' }
        },
        { id: 'stop-sharing', label: 'Stop sharing', description: 'Stops the companion-owned tab capture.' },
        { id: 'open-extension-folder', label: 'Open companion folder', description: 'Opens the unpacked extension folder on the EveOS host.' }
      ],
      status
    };
  }

  async function invoke(detail = {}) {
    const action = String(detail.action || '');
    if (action === 'stop-sharing') {
      await globalThis.WatchFusionMediaLink?.stop?.();
      return response('invoke', { message: 'WatchFusion sharing stopped.' });
    }
    if (action === 'open-extension-folder') {
      const result = await fetch('http://127.0.0.1:9087/api/setup/open-extension-folder', { method: 'POST', cache: 'no-store' });
      const payload = await result.json().catch(() => ({}));
      return result.ok
        ? response('invoke', { message: payload.message || 'Companion folder opened.' })
        : failure('invoke', 'OPEN_FOLDER_FAILED', payload.error || 'WatchFusion could not open the companion folder.');
    }
    if (action === 'prepare-tab-link') {
      const api = globalThis.WatchFusionMediaLink;
      if (!api?.pairing) return failure('invoke', 'MEDIA_LINK_NOT_READY', 'WatchFusion Media Link is still starting.');
      try {
        const value = String(detail.value || '');
        api.pairing(value);
        await chrome.storage.local.set({ watchFusionPendingPairing: value });
        return response('invoke', {
          message: 'Prepared. On the playing source tab, click WatchFusion Media Link once to grant tab capture.'
        });
      } catch (error) {
        return failure('invoke', 'PAIRING_INVALID', error?.message || String(error));
      }
    }
    return failure('invoke', 'UNKNOWN_ACTION', 'Unknown WatchFusion companion action.');
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
      if (message.type === 'invoke') return invoke(message.detail);
      return failure(message.type, 'UNKNOWN_REQUEST', 'Unknown EveOS hub request.');
    })().then(sendResponse, error => sendResponse(failure(message.type, 'CONNECTOR_ERROR', error?.message || String(error))));
    return true;
  });
})();
