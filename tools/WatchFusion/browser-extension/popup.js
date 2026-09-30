const $ = id => document.getElementById(id);
const status = message => { $('status').textContent = message; };
let sharingRevision = 0;
async function refreshSharing() {
  const revision = ++sharingRevision;
  try {
    const result = await chrome.runtime.sendMessage({ to:'worker', type:'status' });
    if (revision === sharingRevision) $('stop').hidden = result?.linked !== true;
    return result;
  } catch { if (revision === sharingRevision) $('stop').hidden = true; return { linked:false }; }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && Object.hasOwn(changes, 'sourceTab')) void refreshSharing();
});
chrome.runtime.onMessage.addListener((message, sender) => {
  const path = location.pathname.slice(1).replace(/popup\.html$/, 'offscreen.html');
  if (sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(path)
      && message.to === 'popup' && message.type === 'capture-state') {
    sharingRevision++; $('stop').hidden = message.linked !== true;
  }
});

async function previewPairing(value) {
  const result = await chrome.runtime.sendMessage({ to: 'worker', type: 'preview-pairing', pairing: value });
  if (result?.error) throw new Error(result.error);
  if (!result?.base) throw new Error('That is not a WatchFusion source pairing link.');
  return result;
}

async function connectPairing(value, requestAccess = true) {
  const parsed = await previewPairing(value);
  if (requestAccess) {
    const granted = await chrome.permissions.request({ origins: [`${parsed.base}/*`] });
    if (!granted) throw new Error('Allow access to your WatchFusion server to connect.');
  } else if (!(await chrome.permissions.contains({ origins: [`${parsed.base}/*`] }))) {
    throw new Error('Press Connect once to approve access to this WatchFusion server.');
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  status('Connecting…');
  const result = await chrome.runtime.sendMessage({ to: 'worker', type: 'start-pairing', pairing: value, tabId: tab?.id });
  if (result?.error) throw new Error(result.error);
  await refreshSharing();
  $('pairing').value = '';
  await chrome.storage.local.set({ watchFusionLastBase: parsed.base });
  await chrome.storage.local.remove('watchFusionPendingPairing');
  status('Tab selected. WatchFusion follows its playable media; embedded players may need Setup & embedded players access.');
}

$('connect').onclick = async () => {
  try { await connectPairing($('pairing').value.trim(), true); }
  catch (error) { status(error.message); }
};

$('stop').onclick = async () => {
  try {
    const result = await chrome.runtime.sendMessage({ to: 'worker', type: 'stop' });
    if (result?.error) throw new Error(result.error);
    await refreshSharing(); status('Stopped sharing.');
  } catch (error) { status(error.message); }
};

$('siteAccess').onclick = async () => {
  try {
    const granted = await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
    if (granted) await chrome.runtime.sendMessage({ to: 'worker', type: 'refresh-probes' });
    status(granted
      ? 'Embedded-player access enabled. Cross-origin players can now expose their own media controls.'
      : 'Embedded-player access was not granted. Standalone active-tab linking still works.');
  } catch (error) { status(error.message); }
};

async function restorePreparedLink() {
  const saved = await chrome.storage.local.get('watchFusionPendingPairing');
  const value = String(saved.watchFusionPendingPairing || '');
  if (!value) return;
  $('pairing').value = value;
  try {
    const parsed = await previewPairing(value);
    const allowed = await chrome.permissions.contains({ origins: [`${parsed.base}/*`] });
    if (allowed) {
      await connectPairing(value, false);
      return;
    }
  } catch {}
  status('Prepared by EveOS Bridge. Press Connect once to approve this WatchFusion server.');
}

void refreshSharing().then(result => {
  if (result?.linked) status('A tab is currently linked.');
  else return restorePreparedLink();
}).catch(() => restorePreparedLink());
