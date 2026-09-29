const $ = id => document.getElementById(id);
const status = message => { $('status').textContent = message; };

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
  $('pairing').value = '';
  await chrome.storage.local.set({ watchFusionLastBase: parsed.base });
  await chrome.storage.local.remove('watchFusionPendingPairing');
  status('Linked. WatchFusion now follows the media in this tab.');
}

$('connect').onclick = async () => {
  try { await connectPairing($('pairing').value.trim(), true); }
  catch (error) { status(error.message); }
};

$('stop').onclick = async () => {
  const result = await chrome.runtime.sendMessage({ to: 'worker', type: 'stop' });
  status(result?.error || 'Stopped sharing.');
};

$('siteAccess').onclick = async () => {
  try {
    const granted = await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
    status(granted
      ? 'Embedded-player access enabled. Cross-origin players can now expose their own media controls.'
      : 'Embedded-player access was not granted. Standalone active-tab linking still works.');
  } catch (error) { status(error.message); }
};

$('openFolder').onclick = async () => {
  try {
    const response = await fetch('http://127.0.0.1:9087/api/setup/open-extension-folder', { method: 'POST', cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Could not open the extension folder.');
    status(result.message || 'Extension folder opened.');
  } catch (_error) {
    status('Start WatchFusion on this PC, then try Open extension folder again.');
  }
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
  status('Prepared by EveOS Hub. Press Connect once to approve this WatchFusion server.');
}

void chrome.runtime.sendMessage({ to: 'worker', type: 'status' }).then(result => {
  if (result?.linked) status('A tab is currently linked.');
  else return restorePreparedLink();
}).catch(() => restorePreparedLink());
