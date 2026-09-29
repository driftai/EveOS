let sourceTab = null;
async function offscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  if (!(await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })).length) {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'], justification: 'Relay only the selected tab media area and audio to WatchFusion.' });
  }
}
async function stop() {
  const saved = await chrome.storage.session.get('sourceTab');
  const tabId = sourceTab ?? saved.sourceTab;
  if (tabId != null) await chrome.tabs.sendMessage(tabId, { type: 'probe-stop' }).catch(() => {});
  sourceTab = null; await chrome.storage.session.remove('sourceTab');
  await chrome.runtime.sendMessage({ to: 'offscreen', type: 'stop' }).catch(() => {});
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.to !== 'worker') return;
  (async () => {
    if (message.type === 'start' && !sender.tab && sender.url === chrome.runtime.getURL('popup.html')) {
      await stop();
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active?.id !== message.tabId) throw new Error('Return to the source tab and click the companion there.');
      await chrome.scripting.executeScript({ target: { tabId: message.tabId }, files: ['source-probe.js'] });
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: message.tabId });
      await offscreen(); sourceTab = message.tabId; await chrome.storage.session.set({ sourceTab });
      const result = await chrome.runtime.sendMessage({ to: 'offscreen', type: 'start', streamId, base: message.base, id: message.id, token: message.token });
      if (result?.error) { await stop(); throw new Error(result.error); }
      await chrome.tabs.sendMessage(sourceTab, { type: 'probe-start' });
      return { ok: true };
    }
    if (message.type === 'stop' && !sender.tab) { await stop(); return { ok: true }; }
    const tabId = sourceTab ?? (await chrome.storage.session.get('sourceTab')).sourceTab;
    if (message.type === 'sample' && sender.tab?.id === tabId) return chrome.runtime.sendMessage({ ...message, to: 'offscreen' });
    if (message.type === 'control' && sender.url === chrome.runtime.getURL('offscreen.html') && tabId != null) {
      return chrome.tabs.sendMessage(tabId, { type: 'source-control', action: message.action, value: message.value });
    }
    return { error: 'No selected media tab.' };
  })().then(reply, error => reply({ error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(async tabId => { const saved = await chrome.storage.session.get('sourceTab'); if (tabId === saved.sourceTab) await stop(); });
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  const saved = await chrome.storage.session.get('sourceTab'); if (tabId !== saved.sourceTab) return;
  if (info.status === 'loading') chrome.runtime.sendMessage({ to: 'offscreen', type: 'sample', rect: null, metadata: { status: 'Source navigating…' } }).catch(() => {});
  if (info.status === 'complete') {
    try { await chrome.scripting.executeScript({ target: { tabId }, files: ['source-probe.js'] }); await chrome.tabs.sendMessage(tabId, { type: 'probe-start' }); }
    catch { await stop(); }
  }
});
