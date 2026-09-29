(function () {
  'use strict';
  const CHANNEL = 'eveos.extension.v1';
  const respond = (type, detail) => ({ channel: CHANNEL, version: 1, type, ok: true, detail });
  async function handle(message) {
    if (message.type === 'describe') return respond('describe', {
      id: 'tab-collector', name: 'Tab URLs', version: chrome.runtime.getManifest().version,
      description: 'Manually collect URLs from one browser window. No AI or uploads.',
      capabilities: ['Current window only', 'Copy URLs', 'Export text', 'Local-only collection'],
      status: { available: true }
    });
    if (message.type === 'status') return respond('status', { available: true });
    if (message.type === 'open') {
      const source = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      await chrome.windows.create({ type: 'popup', width: 420, height: 520,
        url: chrome.runtime.getURL(`popup.html?windowId=${source.id}`) });
      return respond('open', { opened: true });
    }
    return { channel: CHANNEL, version: 1, type: message.type, ok: false, code: 'UNKNOWN_REQUEST' };
  }
  if (globalThis.EveOSExtensionModules) {
    globalThis.EveOSExtensionModules.register('tab-collector', handle);
  } else {
    chrome.runtime.onMessageExternal.addListener((message, sender, reply) => {
      if (sender.id !== 'doioapjnmiknkdigmdoapoahlhcaikag'
          || message?.channel !== CHANNEL || Number(message.version) !== 1) return;
      handle(message).then(reply, () => reply({ channel: CHANNEL, version: 1, ok: false, code: 'COLLECTOR_UI_FAILED' }));
      return true;
    });
  }
})();
