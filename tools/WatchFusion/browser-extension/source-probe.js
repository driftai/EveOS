/* Runs in every accessible frame of the explicitly selected tab.
   Passive sampler: read URL/playback state only. Never restyle, resize, capture, or change quality. */
(() => {
  if (window.__watchFusionMediaProbe) return;
  window.__watchFusionMediaProbe = true;
  let enabled = true, pageMedia = null, sampleTimer = null;
  const frameToken = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const PAGE_CHANNEL = 'eveos.watchfusion.page-media.v1';

  function onWindowMessage(event) {
    if (event.source === window && event.data?.channel === PAGE_CHANNEL && event.data.type === 'state') {
      pageMedia = { ...event.data, at:Date.now() };
    }
  }

  function onDocumentLoad(event) {
    if (enabled && event.target?.tagName === 'IFRAME') {
      chrome.runtime.sendMessage({ to:'worker', type:'refresh-probes' }).catch(() => {});
    }
  }

  function media() {
    return [...document.querySelectorAll('video,audio')]
      .filter(element => element.readyState > 0)
      .sort((a,b) => Number(a.paused) - Number(b.paused)
        || Number(b.readyState) - Number(a.readyState)
        || (Number(b.videoWidth || 0) * Number(b.videoHeight || 0)) - (Number(a.videoWidth || 0) * Number(a.videoHeight || 0)))[0] || null;
  }

  function pagePlayer() {
    if (!pageMedia?.hasMedia || Date.now() - pageMedia.at > 2200) return null;
    // Custom-element prototype methods live in the page's main world and are not
    // reliably visible from this isolated extension world. The main-world adapter
    // already validates the transport API before publishing hasMedia.
    return document.querySelector('strmcx-embed');
  }

  function cleanup() {
    if (!window.__watchFusionMediaProbe) return;
    enabled = false; pageMedia = null;
    clearInterval(sampleTimer); sampleTimer = null;
    window.removeEventListener('message', onWindowMessage);
    document.removeEventListener('load', onDocumentLoad, true);
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    window.postMessage({ channel:PAGE_CHANNEL, type:'dispose' }, '*');
    try { delete window.__watchFusionMediaProbeCleanup; } catch { window.__watchFusionMediaProbeCleanup = null; }
    try { delete window.__watchFusionMediaProbe; } catch { window.__watchFusionMediaProbe = false; }
  }
  window.__watchFusionMediaProbeCleanup = cleanup;

  function clickTransport(action) {
    const selectors = action === 'next'
      ? ['.ytp-next-button','[aria-label*="Next" i]','[title*="Next" i]','[data-testid*="next" i]','[data-action*="next" i]']
      : ['.ytp-prev-button','[aria-label*="Previous" i]','[aria-label*="Back" i]','[title*="Previous" i]','[data-testid*="prev" i]','[data-action*="prev" i]'];
    const button = selectors.flatMap(selector => [...document.querySelectorAll(selector)])
      .find(element => element && !element.disabled && !element.hidden);
    if (!button) return false;
    button.click();
    return true;
  }

  function snapshot() {
    if (!enabled) return;
    const element = media();
    const controller = element ? null : pagePlayer();
    const hasMedia = Boolean(element || controller);
    const score = (element && !element.paused ? 4 : 0) + (element?.tagName === 'VIDEO' ? 2 : 0) + (controller ? 3 : 0);
    if (window !== top) parent.postMessage({ type:'watchfusion:media-frame', token:frameToken, hasMedia, score }, '*');
    chrome.runtime.sendMessage({
      to:'worker', type:'sample', token:frameToken, topFrame:window === top, hasMedia, score,
      metadata: {
        pageUrl:location.href,
        sampledAt:Date.now(),
        title:pageMedia?.title || navigator.mediaSession?.metadata?.title || document.title,
        paused:element ? element.paused : pageMedia?.paused !== false,
        ended:element ? !!element.ended : !!pageMedia?.ended,
        currentTime:element?.currentTime || pageMedia?.currentTime || 0,
        duration:Number.isFinite(element?.duration) ? element.duration : pageMedia?.duration || 0,
        rate:element?.playbackRate || pageMedia?.rate || 1,
        volume:element ? (element.muted ? 0 : element.volume ?? 1) : pageMedia?.volume ?? 1,
        status:hasMedia ? '' : 'Waiting for playable media state.'
      }
    }).catch(() => {});
  }

  function onRuntimeMessage(message) {
    if (message.type === 'probe-stop') { cleanup(); return; }
    if (message.type === 'probe-start') { enabled = true; snapshot(); return; }
    if (message.type !== 'source-control' || !enabled) return;
    const element = media(), controller = element ? null : pagePlayer(), value = Number(message.value) || 0;
    if (controller) {
      window.postMessage({ channel:PAGE_CHANNEL, type:'control', action:message.action, value }, '*');
      snapshot();
      return;
    }
    if (message.action === 'next' || message.action === 'prev') { clickTransport(message.action); snapshot(); return; }
    if (!element) return;
    if (message.action === 'toggle') { if (element.paused) element.play().catch(() => {}); else element.pause(); }
    if (message.action === 'play') element.play().catch(() => {});
    if (message.action === 'pause') element.pause();
    if (message.action === 'seek') element.currentTime = Math.max(0, Math.min(value, Number.isFinite(element.duration) ? element.duration : value));
    if (message.action === 'rate') element.playbackRate = Math.max(.25, Math.min(4, value));
    if (message.action === 'volume') { element.volume = Math.max(0, Math.min(1, value)); element.muted = value === 0; }
    snapshot();
  }

  window.addEventListener('message', onWindowMessage);
  document.addEventListener('load', onDocumentLoad, true);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  sampleTimer = setInterval(snapshot, 350);
  snapshot();
})();
