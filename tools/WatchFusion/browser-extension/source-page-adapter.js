/* Main-world adapter for media web components whose controls are not visible in an extension isolated world. */
(() => {
  if (window.__watchFusionPageMediaAdapter) return;
  window.__watchFusionPageMediaAdapter = true;
  const CHANNEL = 'eveos.watchfusion.page-media.v1';
  const bound = new WeakSet();
  const state = { hasMedia:false, paused:true, currentTime:0, duration:0, rate:1, volume:1, title:'' };

  function player() {
    return [...document.querySelectorAll('strmcx-embed')].find(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 24 && rect.height > 24 && typeof element.play === 'function'
        && typeof element.pause === 'function' && typeof element.seek === 'function';
    }) || null;
  }

  function publish(target = player()) {
    state.hasMedia = !!target;
    state.title = navigator.mediaSession?.metadata?.title
      || target?.shadowRoot?.querySelector('iframe')?.getAttribute('aria-label') || document.title;
    window.postMessage({ channel:CHANNEL, type:'state', ...state }, '*');
  }

  function bind(target) {
    if (!target || bound.has(target)) return;
    bound.add(target);
    target.addEventListener('strmcx-state-change', event => {
      state.paused = event.detail?.state !== 'playing'; publish(target);
    });
    target.addEventListener('strmcx-time-update', event => {
      state.currentTime = Number(event.detail?.currentTime) || 0;
      if (Number.isFinite(Number(event.detail?.duration))) state.duration = Number(event.detail.duration);
      publish(target);
    });
    target.addEventListener('strmcx-duration-change', event => {
      state.duration = Number(event.detail?.duration) || 0; publish(target);
    });
    target.addEventListener('strmcx-ended', () => { state.paused = true; publish(target); });
  }

  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window || data?.channel !== CHANNEL || data.type !== 'control') return;
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
  });

  function refresh() { const target = player(); bind(target); publish(target); }
  new MutationObserver(refresh).observe(document.documentElement, { childList:true, subtree:true });
  setInterval(refresh, 500);
  refresh();
})();
