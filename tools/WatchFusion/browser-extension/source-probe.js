/* Runs in every accessible frame of the explicitly selected tab. */
(() => {
  if (window.__watchFusionMediaProbe) return;
  window.__watchFusionMediaProbe = true;
  let enabled = true, focused = null, savedStyle = null, pageMedia = null;
  const frameToken = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, children = new Map();
  const PAGE_CHANNEL = 'eveos.watchfusion.page-media.v1';

  window.addEventListener('message', event => {
    if (event.source === window && event.data?.channel === PAGE_CHANNEL && event.data.type === 'state') {
      pageMedia = { ...event.data, at:Date.now() };
      return;
    }
    if (event.data?.type !== 'watchfusion:media-frame' || typeof event.data.token !== 'string') return;
    const frame = [...document.querySelectorAll('iframe')].find(value => value.contentWindow === event.source);
    if (frame) children.set(frame, { ...event.data, at: Date.now() });
  });
  document.addEventListener('load', event => {
    if (enabled && event.target?.tagName === 'IFRAME') {
      chrome.runtime.sendMessage({ to: 'worker', type: 'refresh-probes' }).catch(() => {});
    }
  }, true);

  function visible(element) {
    const rect = element?.getBoundingClientRect?.();
    const style = element ? getComputedStyle(element) : null;
    return rect && rect.width > 24 && rect.height > 24 && style?.visibility !== 'hidden'
      && style?.display !== 'none' && Number(style?.opacity || 1) > 0;
  }

  function media() {
    return [...document.querySelectorAll('video,audio')]
      .filter(element => element.readyState > 0)
      .sort((a, b) => Number(a.paused) - Number(b.paused)
        || (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0] || null;
  }

  function pagePlayer() {
    if (!pageMedia?.hasMedia || Date.now() - pageMedia.at > 1800) return null;
    return [...document.querySelectorAll('strmcx-embed')].find(visible) || null;
  }

  function frameFallback() {
    // Never assume the biggest iframe is a player (it may be comments or ads).
    return [...children].filter(([frame, sample]) => frame.isConnected && visible(frame)
      && sample.hasMedia && Date.now() - sample.at < 1800)
      .sort((a, b) => b[1].score - a[1].score)[0]?.[0] || null;
  }

  function restoreFocus() {
    if (!focused) return;
    if (savedStyle == null) focused.removeAttribute('style');
    else focused.setAttribute('style', savedStyle);
    focused = null; savedStyle = null;
  }

  function cleanup() {
    enabled = false;
    restoreFocus();
    children.clear();
    pageMedia = null;
  }
  window.__watchFusionMediaProbeCleanup = cleanup;

  function focus(element) {
    if (!element || focused === element) return;
    restoreFocus();
    focused = element;
    savedStyle = element.getAttribute('style');
    const style = element.style;
    const values = {
      position: 'fixed', inset: '0', width: '100vw', height: '100vh',
      maxWidth: 'none', maxHeight: 'none', margin: '0', transform: 'none',
      objectFit: 'contain', background: '#080c12', zIndex: '2147483646',
      pointerEvents: 'none'
    };
    for (const [name, value] of Object.entries(values)) style.setProperty(name.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), value, 'important');
  }

  function normalizedRect(element) {
    if (!visible(element)) return null;
    const outer = element.getBoundingClientRect();
    let left = outer.left, top = outer.top, width = outer.width, height = outer.height;
    if (element.tagName === 'VIDEO' && element.videoWidth > 0 && element.videoHeight > 0
        && getComputedStyle(element).objectFit === 'contain') {
      const mediaRatio = element.videoWidth / element.videoHeight;
      const boxRatio = width / height;
      if (boxRatio > mediaRatio) {
        const fitted = height * mediaRatio;
        left += (width - fitted) / 2; width = fitted;
      } else if (boxRatio < mediaRatio) {
        const fitted = width / mediaRatio;
        top += (height - fitted) / 2; height = fitted;
      }
    }
    const x = Math.max(0, left), y = Math.max(0, top);
    const right = Math.min(innerWidth, left + width), bottom = Math.min(innerHeight, top + height);
    if (right <= x || bottom <= y) return null;
    return {
      x: x / innerWidth, y: y / innerHeight,
      width: (right - x) / innerWidth, height: (bottom - y) / innerHeight
    };
  }

  function clickTransport(action) {
    const selectors = action === 'next'
      ? ['.ytp-next-button', '[aria-label*="Next" i]', '[title*="Next" i]', '[data-testid*="next" i]', '[data-action*="next" i]']
      : ['.ytp-prev-button', '[aria-label*="Previous" i]', '[aria-label*="Back" i]', '[title*="Previous" i]', '[data-testid*="prev" i]', '[data-action*="prev" i]'];
    const button = selectors.flatMap(selector => [...document.querySelectorAll(selector)]).find(visible);
    if (!button) return false;
    button.click();
    return true;
  }

  function snapshot() {
    if (!enabled) return;
    const element = media();
    const controller = element ? null : pagePlayer();
    const fallback = element || controller ? null : frameFallback();
    const visual = element?.tagName === 'VIDEO' ? element : controller || fallback;
    if (visual) focus(visual);
    else if (!element) restoreFocus();
    const rect = normalizedRect(visual);
    const area = rect ? rect.width * rect.height : 0;
    const score = (element && !element.paused ? 2 : 0) + area;
    if (window !== top) parent.postMessage({ type: 'watchfusion:media-frame', token: frameToken,
      hasMedia: Boolean(element || fallback), score: fallback ? children.get(fallback).score : score }, '*');
    chrome.runtime.sendMessage({
      to: 'worker', type: 'sample', rect, token: frameToken, topFrame: window === top,
      children: [...children].filter(([frame, child]) => frame.isConnected && child.hasMedia && Date.now() - child.at < 1800)
        .map(([frame, child]) => ({ token: child.token, rect: normalizedRect(frame) })),
      hasMedia: Boolean(element || controller), score: controller ? score + 1 : score,
      metadata: {
        title: pageMedia?.title || navigator.mediaSession?.metadata?.title || document.title,
        paused: element ? element.paused : pageMedia?.paused !== false,
        currentTime: element?.currentTime || pageMedia?.currentTime || 0,
        duration: Number.isFinite(element?.duration) ? element.duration : pageMedia?.duration || 0,
        rate: element?.playbackRate || pageMedia?.rate || 1,
        volume: element ? (element.muted ? 0 : element.volume ?? 1) : pageMedia?.volume ?? 1,
        relayHint: controller ? 'direct-start' : 'auto',
        status: element || controller ? '' : 'Waiting for a playable video · embedded players may need Setup & embedded players access.'
      }
    }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'probe-stop') { cleanup(); return; }
    if (message.type === 'probe-start') { enabled = true; snapshot(); return; }
    if (message.type !== 'source-control' || !enabled) return;
    const element = media();
    const controller = element ? null : pagePlayer();
    const value = Number(message.value) || 0;
    if (controller) {
      window.postMessage({ channel:PAGE_CHANNEL, type:'control', action:message.action, value }, '*');
      snapshot(); return;
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
  });

  setInterval(snapshot, 300);
  snapshot();
})();
