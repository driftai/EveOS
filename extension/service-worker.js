'use strict';

const protocol = globalThis.EveOSExtensionProtocol;
const catalog = globalThis.EveOSExtensionCatalog;
const discovery = globalThis.EveOSExtensionDiscovery.create({ chromeApi: chrome, fetchImpl: fetch });

async function enablePanel() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(enablePanel);
chrome.runtime.onStartup.addListener(enablePanel);
void enablePanel();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.channel !== protocol.UI_CHANNEL) return;
  (async () => {
    if (message.type === 'refresh') return { ok: true, snapshot: await discovery.refresh() };
    if (message.type === 'scan') {
      const allowed = await chrome.permissions.contains({ permissions: ['management'] });
      if (!allowed) return { ok: false, code: 'DISCOVERY_PERMISSION_REQUIRED' };
      return { ok: true, snapshot: await discovery.scan() };
    }
    if (message.type === 'open-service') {
      const service = catalog.services.find(item => item.id === message.id);
      if (!service) return { ok: false, code: 'UNKNOWN_SERVICE' };
      await chrome.tabs.create({ url: service.url });
      return { ok: true };
    }
    if (message.type === 'open-connector') {
      const saved = await chrome.storage.local.get(globalThis.EveOSExtensionDiscovery.STORAGE_KEY);
      const connector = (saved[globalThis.EveOSExtensionDiscovery.STORAGE_KEY] || [])
        .find(item => item.extensionId === message.extensionId);
      if (!connector) return { ok: false, code: 'UNKNOWN_CONNECTOR' };
      const result = await chrome.runtime.sendMessage(
        connector.extensionId,
        protocol.request(protocol.REQUESTS.OPEN)
      );
      return { ok: protocol.isResponse(result) };
    }
    return { ok: false, code: 'UNKNOWN_COMMAND' };
  })().then(sendResponse, error => sendResponse({ ok: false, code: 'HUB_ERROR', message: error.message }));
  return true;
});
