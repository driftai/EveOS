'use strict';
let currentWindowId;
void chrome.windows.getCurrent().then(value => { currentWindowId = value.id; });
document.getElementById('openHub').onclick = () => {
  if (currentWindowId != null) chrome.sidePanel.open({ windowId: currentWindowId }).catch(error => {
    document.getElementById('popupStatus').textContent = error.message;
  });
};
for (const [button, serviceId] of [['openNexus', 'nexus-browser'], ['openEveOS', 'eveos']]) {
  document.getElementById(button).onclick = () => {
    const service = globalThis.EveOSExtensionCatalog.services.find(item => item.id === serviceId);
    chrome.tabs.create({ url: service.url });
  };
}
