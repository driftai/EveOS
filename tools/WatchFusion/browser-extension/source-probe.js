/* Runs in every accessible frame of the explicitly selected tab. */
(() => {
  if (window.__watchFusionMediaProbe) return;
  window.__watchFusionMediaProbe = true;
  let enabled = true, focused = null, savedStyle = null;
  function visible(element) {
    const rect = element?.getBoundingClientRect?.(), style = element ? getComputedStyle(element) : null;
    return rect && rect.width > 24 && rect.height > 24 && style?.visibility !== 'hidden'
      && style?.display !== 'none' && Number(style?.opacity || 1) > 0;
  }
  function media() {
    return [...document.querySelectorAll('video,audio')].filter(element => element.readyState > 0)
      .sort((a, b) => Number(a.paused) - Number(b.paused)
        || (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0] || null;
  }
  function frameFallback() {
    if (window !== top) return null;
    return [...document.querySelectorAll('iframe')].filter(visible)
      .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0] || null;
  }
  function restoreFocus() {
    if (!focused) return;
    if (savedStyle == null) focused.removeAttribute('style'); else focused.setAttribute('style', savedStyle);
    focused = null; savedStyle = null;
  }
  function focus(element) {
    if (!element || focused === element) return;
    restoreFocus(); focused = element; savedStyle = element.getAttribute('style');
    Object.assign(element.style, {
      position: 'fixed', inset: '0', width: '100vw', height: '100vh', maxWidth: 'none', maxHeight: 'none',
      margin: '0', transform: 'none', objectFit: 'contain', background: '#080c12', zIndex: '2147483646'
    });
  }
  function normalizedRect(element) {
    if (!visible(element)) return null;
    const box = element.getBoundingClientRect(), x = Math.max(0, box.x), y = Math.max(0, box.y);
    const right = Math.min(innerWidth, box.right), bottom = Math.min(innerHeight, box.bottom);
    if (right <= x || bottom <= y) return null;
    return { x: x / innerWidth, y: y / innerHeight, width: (right - x) / innerWidth,
      height: (bottom - y) / innerHeight };
  }
  function snapshot() {
    if (!enabled) return;
    const element = media(), fallback = element ? null : frameFallback(), candidate = element || fallback;
    if (candidate) focus(candidate);
    const rect = normalizedRect(candidate), area = rect ? rect.width * rect.height : 0;
    chrome.runtime.sendMessage({ to: 'worker', type: 'sample', rect, topFrame: window === top,
      hasMedia: Boolean(element), score: (element && !element.paused ? 2 : 0) + area,
      metadata: { title: navigator.mediaSession?.metadata?.title || document.title,
        paused: !element || element.paused, currentTime: element?.currentTime || 0,
        duration: Number.isFinite(element?.duration) ? element.duration : 0,
        rate: element?.playbackRate || 1, volume: element ? (element.muted ? 0 : element.volume ?? 1) : 1,
        status: element ? '' : fallback ? 'Embedded media frame linked' : 'Waiting for playable media…' } }).catch(() => {});
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'probe-stop') { enabled = false; restoreFocus(); return; }
    if (message.type === 'probe-start') { enabled = true; snapshot(); return; }
    if (message.type !== 'source-control' || !enabled) return;
    const element = media(); if (!element) return;
    const value = Number(message.value) || 0;
    if (message.action === 'toggle') { if (element.paused) element.play().catch(() => {}); else element.pause(); }
    if (message.action === 'play') element.play().catch(() => {});
    if (message.action === 'pause') element.pause();
    if (message.action === 'seek') element.currentTime = Math.max(0, Math.min(value, Number.isFinite(element.duration) ? element.duration : value));
    if (message.action === 'rate') element.playbackRate = Math.max(.25, Math.min(4, value));
    if (message.action === 'volume') { element.volume = Math.max(0, Math.min(1, value)); element.muted = value === 0; }
    if (message.action === 'next') document.querySelector('[aria-label*="Next" i],.ytp-next-button')?.click();
    if (message.action === 'prev') document.querySelector('[aria-label*="Previous" i],.ytp-prev-button')?.click();
    snapshot();
  });
  setInterval(snapshot, 300); snapshot();
})();
