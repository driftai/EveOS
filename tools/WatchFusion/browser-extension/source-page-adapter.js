/* Main-world adapter for media web components whose controls are not visible in an extension isolated world. */
(() => {
  if (window.__watchFusionPageMediaAdapter) return;
  window.__watchFusionPageMediaAdapter = true;
  const CHANNEL = 'eveos.watchfusion.page-media.v1';
  const bindings = new Map();
  const state = { hasMedia:false, paused:true, currentTime:0, duration:0, rate:1, volume:1, title:'' };
  const qualityRestore = new Map();
  let observer = null, refreshTimer = null, disposed = false;

  function player() {
    return [...document.querySelectorAll('strmcx-embed')].find(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 24 && rect.height > 24 && typeof element.play === 'function'
        && typeof element.pause === 'function' && typeof element.seek === 'function';
    }) || null;
  }

  function publish(target = player()) {
    if (disposed) return;
    state.hasMedia = !!target;
    state.title = navigator.mediaSession?.metadata?.title
      || target?.shadowRoot?.querySelector('iframe')?.getAttribute('aria-label') || document.title;
    window.postMessage({ channel:CHANNEL, type:'state', ...state }, '*');
  }

  async function preferLowestQuality(target) {
    if (!target || qualityRestore.has(target) || typeof target.setQuality !== 'function') return;
    qualityRestore.set(target, null);
    try {
      const previous = typeof target.getQuality === 'function' ? await target.getQuality() : null;
      const getter = typeof target.getQualities === 'function' ? target.getQualities.bind(target)
        : (typeof target.getAvailableQualities === 'function' ? target.getAvailableQualities.bind(target) : null);
      if (!getter) return;
      const raw = await getter();
      const qualities = (Array.isArray(raw) ? raw : []).map(item => typeof item === 'string' ? item : item?.id || item?.label).filter(Boolean);
      const ranked = qualities.map(value => ({ value, n:Number(String(value).match(/(\d{3,4})/)?.[1]) || Infinity }))
        .filter(item => Number.isFinite(item.n)).sort((a,b) => a.n-b.n);
      if (!ranked.length) return;
      qualityRestore.set(target, previous);
      await target.setQuality(ranked[0].value);
    } catch {}
  }

  function bind(target) {
    if (!target || bindings.has(target)) return;
    const handlers = {
      state: event => { state.paused = event.detail?.state !== 'playing'; publish(target); },
      time: event => {
        state.currentTime = Number(event.detail?.currentTime) || 0;
        if (Number.isFinite(Number(event.detail?.duration))) state.duration = Number(event.detail.duration);
        publish(target);
      },
      duration: event => { state.duration = Number(event.detail?.duration) || 0; publish(target); },
      ended: () => { state.paused = true; publish(target); }
    };
    target.addEventListener('strmcx-state-change', handlers.state);
    target.addEventListener('strmcx-time-update', handlers.time);
    target.addEventListener('strmcx-duration-change', handlers.duration);
    target.addEventListener('strmcx-ended', handlers.ended);
    bindings.set(target, handlers);
    void preferLowestQuality(target);
  }

  function unbindAll() {
    for (const [target, handlers] of bindings) {
      try { target.removeEventListener('strmcx-state-change', handlers.state); } catch {}
      try { target.removeEventListener('strmcx-time-update', handlers.time); } catch {}
      try { target.removeEventListener('strmcx-duration-change', handlers.duration); } catch {}
      try { target.removeEventListener('strmcx-ended', handlers.ended); } catch {}
    }
    for (const [target, previous] of qualityRestore) {
      if (previous != null && typeof target?.setQuality === 'function') {
        try { Promise.resolve(target.setQuality(previous)).catch(() => {}); } catch {}
      }
    }
    qualityRestore.clear();
    bindings.clear();
  }

  function onMessage(event) {
    const data = event.data;
    if (event.source !== window || data?.channel !== CHANNEL) return;
    if (data.type === 'dispose') { dispose(); return; }
    if (data.type !== 'control' || disposed) return;
    const target = player();
    if (!target) return;
    const value = Number(data.value) || 0;
    if (data.action === 'toggle') target.togglePlay();
    else if (data.action === 'play') target.play();
    else if (data.action === 'pause') target.pause();
    else if (data.action === 'seek') target.seek(Math.max(0, value));
    else if (data.action === 'rate') { state.rate = Math.max(.25, Math.min(4, value)); target.setPlaybackRate(state.rate); }
    else if (data.action === 'volume') { state.volume = Math.max(0, Math.min(1, value)); target.setVolume(state.volume); }
    else if (data.action === 'next') target.nextEpisode();
    else if (data.action === 'prev') target.previousEpisode();
    publish(target);
  }

  function refresh() {
    if (disposed) return;
    const target = player();
    bind(target);
    publish(target);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(refreshTimer);
    refreshTimer = null;
    observer?.disconnect();
    observer = null;
    unbindAll();
    window.removeEventListener('message', onMessage);
    try { delete window.__watchFusionPageMediaAdapterCleanup; } catch { window.__watchFusionPageMediaAdapterCleanup = null; }
    try { delete window.__watchFusionPageMediaAdapter; } catch { window.__watchFusionPageMediaAdapter = false; }
  }

  window.__watchFusionPageMediaAdapterCleanup = dispose;
  window.addEventListener('message', onMessage);
  observer = new MutationObserver(refresh);
  observer.observe(document.documentElement, { childList:true, subtree:true });
  refreshTimer = setInterval(refresh, 500);
  refresh();
})();
