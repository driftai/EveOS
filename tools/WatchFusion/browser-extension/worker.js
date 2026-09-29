importScripts('eveos-hub-connector.js');

let sourceTab = null, controlFrameId = 0;
const frameSamples = new Map();
const asset = value => (globalThis.EveOSExtensionModuleRoots?.watchfusion || '') + value;

function pairing(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('Paste the private pairing link from WatchFusion.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Pairing link must use HTTP or HTTPS.');
  const match = url.hash.match(/^#live=([a-f\d-]{36})\.([a-f\d]{48})$/i);
  if (!match) throw new Error('That is not a WatchFusion source pairing link.');
  return { base: url.origin, id: match[1], token: match[2] };
}

async function offscreen() {
  const url = chrome.runtime.getURL(asset('offscreen.html'));
  if (!(await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })).length) {
    await chrome.offscreen.createDocument({
      url: asset('offscreen.html'),
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Relay only the selected tab media area and audio to WatchFusion.'
    });
  }
}

async function messageFrames(tabId, message) {
  const frameIds = new Set([0, ...frameSamples.keys()]);
  await Promise.all([...frameIds].map(frameId =>
    chrome.tabs.sendMessage(tabId, message, { frameId }).catch(() => {})
  ));
}

async function inject(tabId) {
  frameSamples.clear(); controlFrameId = 0;
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [asset('source-probe.js')] });
  } catch {
    results = await chrome.scripting.executeScript({ target: { tabId }, files: [asset('source-probe.js')] });
  }
  results.forEach(result => { if (!frameSamples.has(result.frameId)) frameSamples.set(result.frameId, null); });
  await messageFrames(tabId, { type: 'probe-start' });
}

function combinedSample(frameId, message) {
  frameSamples.set(frameId, { ...message, frameId, at: Date.now() });
  const fresh = [...frameSamples.values()].filter(value => value && Date.now() - value.at < 1800);
  const media = fresh.filter(value => value.hasMedia).sort((a, b) => b.score - a.score)[0];
  const top = fresh.find(value => value.topFrame);
  if (media) controlFrameId = media.frameId;
  const outer = top?.rect, inner = media?.rect;
  const rect = media?.topFrame ? inner : outer && inner ? {
    x: outer.x + inner.x * outer.width, y: outer.y + inner.y * outer.height,
    width: inner.width * outer.width, height: inner.height * outer.height
  } : outer || null;
  return { rect, metadata: media?.metadata || top?.metadata || message.metadata || {} };
}

async function stop() {
  const saved = await chrome.storage.session.get('sourceTab');
  const tabId = sourceTab ?? saved.sourceTab;
  if (tabId != null) await messageFrames(tabId, { type: 'probe-stop' });
  sourceTab = null; frameSamples.clear(); controlFrameId = 0;
  await chrome.storage.session.remove('sourceTab');
  await chrome.runtime.sendMessage({ to: 'offscreen', type: 'stop' }).catch(() => {});
  return { ok: true };
}

async function startCurrentTab(value, options = {}) {
  const config = pairing(value);
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = options.tabId ?? active?.id;
  if (!Number.isInteger(tabId) || active?.id !== tabId) throw new Error('Return to the source tab before linking it.');
  await stop();
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await offscreen();
    sourceTab = tabId;
    await chrome.storage.session.set({ sourceTab });
    const result = await chrome.runtime.sendMessage({ to: 'offscreen', type: 'start', streamId, ...config });
    if (result?.error) throw new Error(result.error);
    await inject(tabId);
    return { ok: true, message: 'Current tab linked to WatchFusion.' };
  } catch (error) { await stop(); throw error; }
}

globalThis.WatchFusionMediaLink = Object.freeze({
  pairing,
  startCurrentTab,
  stop,
  status: async () => ({ linked: Number.isInteger(sourceTab ?? (await chrome.storage.session.get('sourceTab')).sourceTab) })
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.to !== 'worker') return;
  (async () => {
    const internal = sender.id === chrome.runtime.id;
    if (message.type === 'preview-pairing' && internal) return { ok: true, ...pairing(message.pairing) };
    if (message.type === 'status' && internal) return globalThis.WatchFusionMediaLink.status();
    if (message.type === 'start-pairing' && internal && !sender.tab) {
      return startCurrentTab(message.pairing, { tabId: message.tabId, fromHub: false });
    }
    if (message.type === 'stop' && internal && !sender.tab) return stop();
    const tabId = sourceTab ?? (await chrome.storage.session.get('sourceTab')).sourceTab;
    if (message.type === 'sample' && sender.tab?.id === tabId) {
      return chrome.runtime.sendMessage({ to: 'offscreen', type: 'sample', ...combinedSample(sender.frameId || 0, message) });
    }
    if (message.type === 'control' && sender.url === chrome.runtime.getURL(asset('offscreen.html')) && tabId != null) {
      return chrome.tabs.sendMessage(tabId, { type: 'source-control', action: message.action, value: message.value }, { frameId: controlFrameId });
    }
    return { error: 'No selected media tab.' };
  })().then(reply, error => reply({ error: error.message, code: error.code }));
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const saved = await chrome.storage.session.get('sourceTab');
  if (tabId === saved.sourceTab) await stop();
});
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  const saved = await chrome.storage.session.get('sourceTab');
  if (tabId !== saved.sourceTab) return;
  if (info.status === 'complete') { try { await inject(tabId); } catch { await stop(); } }
});
