/* Main-world adapter for media web components whose controls are not visible in an extension isolated world.
   Passive by default: attachment never changes layout, quality, playback, or media state unless WatchFusion
   sends an explicit user transport command. */
(() => {
  if (window.__watchFusionPageMediaAdapter) return;
  window.__watchFusionPageMediaAdapter = true;
  const CHANNEL = 'eveos.watchfusion.page-media.v1';
  const bindings = new Map();
  const state = { hasMedia:false, paused:true, ended:false, currentTime:0, duration:0, rate:1, volume:1, title:'' };
  let observer = null, refreshTimer = null, refreshPending = null, disposed = false;

  function player() {
    return [...document.querySelectorAll('strmcx-embed')].find(element =>
      typeof element.play === 'function' && typeof element.pause === 'function' && typeof element.seek === 'function'
    ) || null;
  }

  function publish(target = player()) {
    if (disposed) return;
    state.hasMedia = !!target;
    state.title = navigator.mediaSession?.metadata?.title
      || target?.shadowRoot?.querySelector('iframe')?.getAttribute('aria-label') || document.title;
    window.postMessage({ channel:CHANNEL, type:'state', ...state }, '*');
  }

  function bind(target) {
    if (!target || bindings.has(target)) return;
    const handlers = {
      state: event => {
        const next = String(event.detail?.state || '').toLowerCase();
        state.paused = next !== 'playing';
        if (next === 'playing') state.ended = false;
        publish(target);
      },
      time: event => {
        state.currentTime = Number(event.detail?.currentTime) || 0;
        if (Number.isFinite(Number(event.detail?.duration))) state.duration = Number(event.detail.duration);
        if (state.duration > 0 && state.currentTime < state.duration - .25) state.ended = false;
        publish(target);
      },
      duration: event => { state.duration = Number(event.detail?.duration) || 0; publish(target); },
      ended: () => { state.paused = true; state.ended = true; publish(target); }
    };
    target.addEventListener('strmcx-state-change', handlers.state, { passive:true });
    target.addEventListener('strmcx-time-update', handlers.time, { passive:true });
    target.addEventListener('strmcx-duration-change', handlers.duration, { passive:true });
    target.addEventListener('strmcx-ended', handlers.ended, { passive:true });
    bindings.set(target, handlers);
  }

  function unbindAll() {
    for (const [target, handlers] of bindings) {
      try { target.removeEventListener('strmcx-state-change', handlers.state); } catch {}
      try { target.removeEventListener('strmcx-time-update', handlers.time); } catch {}
      try { target.removeEventListener('strmcx-duration-change', handlers.duration); } catch {}
      try { target.removeEventListener('strmcx-ended', handlers.ended); } catch {}
    }
    bindings.clear();
  }

  function safeCall(target, name, ...args) {
    try {
      const fn = target?.[name];
      if (typeof fn === 'function') return fn.apply(target, args);
    } catch {}
  }

  function onMessage(event) {
    const data = event.data;
    if (event.source !== window || data?.channel !== CHANNEL) return;
    if (data.type === 'dispose') { dispose(); return; }
    if (data.type !== 'control' || disposed) return;
    const target = player();
    if (!target) return;
    const value = Number(data.value) || 0;
    if (data.action === 'toggle') safeCall(target, 'togglePlay');
    else if (data.action === 'play') safeCall(target, 'play');
    else if (data.action === 'pause') safeCall(target, 'pause');
    else if (data.action === 'seek') safeCall(target, 'seek', Math.max(0, value));
    else if (data.action === 'rate') { state.rate = Math.max(.25, Math.min(4, value)); safeCall(target, 'setPlaybackRate', state.rate); }
    else if (data.action === 'volume') { state.volume = Math.max(0, Math.min(1, value)); safeCall(target, 'setVolume', state.volume); }
    else if (data.action === 'next') safeCall(target, 'nextEpisode');
    else if (data.action === 'prev') safeCall(target, 'previousEpisode');
    publish(target);
  }

  function refresh() {
    if (disposed) return;
    refreshPending = null;
    const target = player();
    bind(target);
    publish(target);
  }

  function scheduleRefresh() {
    if (disposed || refreshPending) return;
    refreshPending = setTimeout(refresh, 120);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(refreshPending);
    clearInterval(refreshTimer);
    refreshPending = null; refreshTimer = null;
    observer?.disconnect();
    observer = null;
    unbindAll();
    window.removeEventListener('message', onMessage);
    try { delete window.__watchFusionPageMediaAdapterCleanup; } catch { window.__watchFusionPageMediaAdapterCleanup = null; }
    try { delete window.__watchFusionPageMediaAdapter; } catch { window.__watchFusionPageMediaAdapter = false; }
  }

  window.__watchFusionPageMediaAdapterCleanup = dispose;
  window.addEventListener('message', onMessage);
  observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.documentElement, { childList:true, subtree:true });
  refreshTimer = setInterval(refresh, 1200);
  refresh();
})();
