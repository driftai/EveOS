const $ = id => document.getElementById(id);
$('connect').onclick = async () => {
  try {
    const url = new URL($('pairing').value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Paste the pairing link from WatchFusion.');
    const match = url.hash.match(/^#live=([a-f\d-]{36})\.([a-f\d]{48})$/i);
    if (!match) throw new Error('That is not a source pairing link.');
    const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!granted) throw new Error('Allow access to your WatchFusion server to connect.');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    $('status').textContent = 'Connecting…';
    const result = await chrome.runtime.sendMessage({ to: 'worker', type: 'start', tabId: tab.id, base: url.origin, id: match[1], token: match[2] });
    if (result?.error) throw new Error(result.error);
    $('pairing').value = ''; $('status').textContent = 'Linked. Keep the media visible in its tab. Switching to WatchFusion is fine.';
  } catch (error) { $('status').textContent = error.message; }
};
$('stop').onclick = async () => { await chrome.runtime.sendMessage({ to: 'worker', type: 'stop' }); $('status').textContent = 'Stopped sharing.'; };
