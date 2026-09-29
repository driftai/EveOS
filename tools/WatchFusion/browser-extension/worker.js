importScripts('eveos-hub-connector.js');

let sourceTab = null, controlFrameId = 0;
const frameSamples = new Map();
async function offscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  if (!(await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })).length) {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'], justification: 'Relay only the selected tab media area and audio to WatchFusion.' });
  }
}
async function messageFrames(tabId, message) {
  await Promise.all([...frameSamples.keys()].map(frameId => chrome.tabs.sendMessage(tabId, message, { frameId }).catch(() => {})));
}
async function inject(tabId) {
  frameSamples.clear(); controlFrameId = 0;
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['source-probe.js'] });
  results.forEach(result => frameSamples.set(result.frameId, null));
  await messageFrames(tabId, { type: 'probe-start' });
}
function combinedSample(frameId, message) {
  frameSamples.set(frameId, { ...message, frameId, at: Date.now() });
  const fresh = [...frameSamples.values()].filter(value => value && Date.now() - value.at < 1800);
  const media = fresh.filter(value => value.hasMedia).sort((a, b) => b.score - a.score)[0];
  const top = fresh.find(value => value.topFrame);
  if (media) controlFrameId = media.frameId;
  return { rect: media?.topFrame ? media.rect : top?.rect || media?.rect || null,
    metadata: media?.metadata || top?.metadata || message.metadata || {} };
}
async function stop() {
  const saved = await chrome.storage.session.get('sourceTab'), tabId = sourceTab ?? saved.sourceTab;
  if (tabId != null) await messageFrames(tabId, { type: 'probe-stop' });
  sourceTab = null; frameSamples.clear(); controlFrameId = 0;
  await chrome.storage.session.remove('sourceTab');
  await chrome.runtime.sendMessage({ to: 'offscreen', type: 'stop' }).catch(() => {});
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.to !== 'worker') return;
  (async () => {
    if (message.type === 'start' && !sender.tab && sender.url === chrome.runtime.getURL('popup.html')) {
      await stop();
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active?.id !== message.tabId) throw new Error('Return to the source tab and click the companion there.');
      await inject(message.tabId);
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: message.tabId });
      await offscreen(); sourceTab = message.tabId; await chrome.storage.session.set({ sourceTab });
      const result = await chrome.runtime.sendMessage({ to: 'offscreen', type: 'start', streamId, base: message.base, id: message.id, token: message.token });
      if (result?.error) { await stop(); throw new Error(result.error); }
      return { ok: true };
    }
    if (message.type === 'stop' && !sender.tab) { await stop(); return { ok: true }; }
    const tabId = sourceTab ?? (await chrome.storage.session.get('sourceTab')).sourceTab;
    if (message.type === 'sample' && sender.tab?.id === tabId) {
      return chrome.runtime.sendMessage({ to: 'offscreen', type: 'sample', ...combinedSample(sender.frameId || 0, message) });
    }
    if (message.type === 'control' && sender.url === chrome.runtime.getURL('offscreen.html') && tabId != null) {
      return chrome.tabs.sendMessage(tabId, { type: 'source-control', action: message.action, value: message.value }, { frameId: controlFrameId });
    }
    return { error: 'No selected media tab.' };
  })().then(reply, error => reply({ error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(async tabId => { const saved = await chrome.storage.session.get('sourceTab'); if (tabId === saved.sourceTab) await stop(); });
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  const saved = await chrome.storage.session.get('sourceTab'); if (tabId !== saved.sourceTab) return;
  if (info.status === 'complete') { try { await inject(tabId); } catch { await stop(); } }
});
