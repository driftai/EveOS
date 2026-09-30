importScripts('eveos-hub-connector.js');

let sourceTab = null, controlFrameId = 0;
let lastRefresh = 0, lastCombinedSample = null, publisherReady = false, stopping = false;
const frameSamples = new Map();
const asset = value => (globalThis.EveOSExtensionModuleRoots?.watchfusion || '') + value;

function pairing(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('Paste the private pairing link from WatchFusion.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Pairing link must use HTTP or HTTPS.');
  const match = url.hash.match(/^#live=([a-f\d-]{36})\.([a-f\d]{48})$/i);
  if (!match) throw new Error('That is not a WatchFusion source pairing link.');
  return { base:url.origin, id:match[1], token:match[2] };
}

async function offscreen() {
  const url = chrome.runtime.getURL(asset('offscreen.html'));
  if (!(await chrome.runtime.getContexts({ contextTypes:['OFFSCREEN_DOCUMENT'], documentUrls:[url] })).length) {
    await chrome.offscreen.createDocument({
      url: asset('offscreen.html'),
      reasons: ['WORKERS'],
      justification: 'Maintain the selected tab state/control link to WatchFusion without capturing its media.'
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
  frameSamples.clear(); controlFrameId = 0; lastCombinedSample = null;
  let results;
  try {
    await chrome.scripting.executeScript({ target:{ tabId, allFrames:true }, world:'MAIN',
      files:[asset('source-page-adapter.js')] });
    results = await chrome.scripting.executeScript({ target:{ tabId, allFrames:true }, files:[asset('source-probe.js')] });
  } catch {
    await chrome.scripting.executeScript({ target:{ tabId }, world:'MAIN', files:[asset('source-page-adapter.js')] });
    results = await chrome.scripting.executeScript({ target:{ tabId }, files:[asset('source-probe.js')] });
  }
  results.forEach(result => { if (!frameSamples.has(result.frameId)) frameSamples.set(result.frameId, null); });
  await messageFrames(tabId, { type:'probe-start' });
}

function combinedSample(frameId, message, pageUrl = '') {
  frameSamples.set(frameId, { ...message, frameId, at:Date.now() });
  const fresh = [...frameSamples.values()].filter(value => value && Date.now() - value.at < 1800);
  const media = fresh.filter(value => value.hasMedia).sort((a,b) => b.score - a.score)[0];
  const top = fresh.find(value => value.topFrame);
  if (media) controlFrameId = media.frameId;
  const metadata = media?.metadata || top?.metadata || {};
  lastCombinedSample = {
    metadata: {
      ...metadata,
      pageUrl: String(pageUrl || metadata.pageUrl || ''),
      status: media ? (metadata.status || '') : 'Waiting for playable media · enable Setup & embedded players access for embedded video.'
    }
  };
  return lastCombinedSample;
}

async function waitForInitialSample(timeoutMs = 1200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lastCombinedSample?.metadata?.pageUrl && Number(lastCombinedSample?.metadata?.duration) >= 0) return lastCombinedSample;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  return lastCombinedSample;
}

async function restoreSourceTab(tabId, previousMuted) {
  if (!Number.isInteger(tabId)) return;
  await messageFrames(tabId, { type:'probe-stop' });
  await chrome.scripting.executeScript({
    target:{ tabId, allFrames:true },
    func: () => {
      try { globalThis.__watchFusionMediaProbeCleanup?.(); } catch {}
      try { globalThis.__watchFusionPageMediaAdapterCleanup?.(); } catch {}
    }
  }).catch(() => {});
  if (typeof previousMuted === 'boolean') await chrome.tabs.update(tabId, { muted:previousMuted }).catch(() => {});
}

async function stop() {
  if (stopping) return { ok:true };
  stopping = true;
  try {
    const saved = await chrome.storage.session.get(['sourceTab','sourceTabWasMuted']);
    const tabId = sourceTab ?? saved.sourceTab;
    publisherReady = false;
    await chrome.runtime.sendMessage({ to:'offscreen', type:'stop' }).catch(() => {});
    await restoreSourceTab(tabId, saved.sourceTabWasMuted);
    sourceTab = null; frameSamples.clear(); controlFrameId = 0; lastCombinedSample = null;
    await chrome.storage.session.remove(['sourceTab','sourceTabWasMuted']);
    return { ok:true };
  } finally { stopping = false; }
}

async function startCurrentTab(value, options = {}) {
  const config = pairing(value);
  const [active] = await chrome.tabs.query({ active:true, currentWindow:true });
  const tabId = options.tabId ?? active?.id;
  if (!Number.isInteger(tabId) || active?.id !== tabId) throw new Error('Return to the source tab before linking it.');
  await stop();
  try {
    const tab = await chrome.tabs.get(tabId);
    sourceTab = tabId;
    await chrome.storage.session.set({ sourceTab, sourceTabWasMuted:!!tab?.mutedInfo?.muted });
    await chrome.tabs.update(tabId, { muted:true }).catch(() => {});
    await inject(tabId);
    const initial = await waitForInitialSample();
    await offscreen();
    const result = await chrome.runtime.sendMessage({
      to:'offscreen', type:'start', ...config, initialMetadata:initial?.metadata || null
    });
    if (result?.error) throw new Error(result.error);
    publisherReady = true;
    if (lastCombinedSample) await chrome.runtime.sendMessage({ to:'offscreen', type:'sample', ...lastCombinedSample }).catch(() => {});
    return { ok:true, message:'Current tab linked to WatchFusion state/control.' };
  } catch (error) { await stop(); throw error; }
}

globalThis.WatchFusionMediaLink = Object.freeze({
  pairing, startCurrentTab, stop,
  status: async () => {
    if (!Number.isInteger(sourceTab ?? (await chrome.storage.session.get('sourceTab')).sourceTab)) return { linked:false };
    try {
      const contexts = await chrome.runtime.getContexts({ contextTypes:['OFFSCREEN_DOCUMENT'], documentUrls:[chrome.runtime.getURL(asset('offscreen.html'))] });
      if (!contexts.length) return { linked:false };
      const result = await chrome.runtime.sendMessage({ to:'offscreen', type:'status' });
      return {
        linked:result?.linked === true,
        relayVideoMode:'state-only',
        captureSettings:null,
        diagnostics:[]
      };
    } catch { return { linked:false }; }
  }
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.to !== 'worker') return;
  (async () => {
    const internal = sender.id === chrome.runtime.id;
    if (message.type === 'preview-pairing' && internal) return { ok:true, ...pairing(message.pairing) };
    if (message.type === 'status' && internal) return globalThis.WatchFusionMediaLink.status();
    if (message.type === 'runtime-status' && internal) {
      return globalThis.WatchFusionHubConnector?.serviceStatus?.() || { online:false, exposureMode:null, mode:'Offline' };
    }
    if (message.type === 'start-pairing' && internal && !sender.tab) {
      return startCurrentTab(message.pairing, { tabId:message.tabId, fromHub:false });
    }
    if (message.type === 'stop' && internal && !sender.tab) return stop();
    if (message.type === 'source-ended' && internal) return stop();
    const tabId = sourceTab ?? (await chrome.storage.session.get('sourceTab')).sourceTab;
    if (message.type === 'refresh-probes' && internal && tabId != null && (!sender.tab || sender.tab.id === tabId)) {
      if (Date.now() - lastRefresh > 1000) { lastRefresh = Date.now(); await inject(tabId); }
      return { ok:true };
    }
    if (message.type === 'sample' && sender.tab?.id === tabId) {
      const sample = combinedSample(sender.frameId || 0, message, sender.tab?.url || '');
      if (!publisherReady) return { ok:true, pending:true };
      return chrome.runtime.sendMessage({ to:'offscreen', type:'sample', ...sample });
    }
    if (message.type === 'control' && sender.url === chrome.runtime.getURL(asset('offscreen.html')) && tabId != null) {
      return chrome.tabs.sendMessage(tabId, { type:'source-control', action:message.action, value:message.value }, { frameId:controlFrameId });
    }
    return { error:'No selected media tab.' };
  })().then(reply, error => reply({ error:error.message, code:error.code }));
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const saved = await chrome.storage.session.get('sourceTab');
  if (tabId === saved.sourceTab) await stop();
});
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  const saved = await chrome.storage.session.get('sourceTab');
  if (tabId !== saved.sourceTab) return;
  if (info.status === 'complete') {
    try { await inject(tabId); }
    catch { await stop(); }
  }
});
