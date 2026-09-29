/* Runs only in the explicitly selected source tab under activeTab permission. */
(() => {
  if (window.__watchFusionMediaProbe) return;
  window.__watchFusionMediaProbe = true;
  let enabled = true;
  function media() {
    return [...document.querySelectorAll('video,audio')].filter(el => el.readyState > 0)
      .sort((a, b) => Number(a.paused) - Number(b.paused) || (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
  }
  function snapshot() {
    if (!enabled) return;
    const el = media();
    let rect = null;
    if (el?.tagName === 'VIDEO') {
      const r = el.getBoundingClientRect(), style = getComputedStyle(el);
      if (r.width > 1 && r.height > 1 && style.visibility !== 'hidden' && style.display !== 'none') {
        const x = Math.max(0, r.x), y = Math.max(0, r.y), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
        if (right > x && bottom > y) rect = { x: x / innerWidth, y: y / innerHeight, width: (right - x) / innerWidth, height: (bottom - y) / innerHeight };
      }
    }
    chrome.runtime.sendMessage({ to: 'worker', type: 'sample', rect, metadata: { title: navigator.mediaSession?.metadata?.title || document.title,
      paused: !el || el.paused, currentTime: el?.currentTime || 0, duration: Number.isFinite(el?.duration) ? el.duration : 0,
      rate: el?.playbackRate || 1, volume: el?.muted ? 0 : el?.volume ?? 1,
      status: el ? (rect ? '' : 'Audio only · keep the source video visible to share its picture') : 'Waiting for playable media in the selected tab…' } }).catch(() => {});
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'probe-stop') { enabled = false; return; }
    if (message.type === 'probe-start') { enabled = true; snapshot(); return; }
    if (message.type !== 'source-control' || !enabled) return;
    const el = media(); if (!el) return;
    const value = Number(message.value) || 0;
    if (message.action === 'toggle') { if (el.paused) el.play().catch(() => {}); else el.pause(); }
    if (message.action === 'play') el.play().catch(() => {});
    if (message.action === 'pause') el.pause();
    if (message.action === 'seek') el.currentTime = Math.max(0, Math.min(value, Number.isFinite(el.duration) ? el.duration : value));
    if (message.action === 'rate') el.playbackRate = Math.max(.25, Math.min(4, value));
    if (message.action === 'volume') { el.volume = Math.max(0, Math.min(1, value)); el.muted = value === 0; }
    if (message.action === 'next') document.querySelector('.ytp-next-button')?.click();
    if (message.action === 'prev') document.querySelector('.ytp-prev-button')?.click();
    snapshot();
  });
  setInterval(snapshot, 250); snapshot();
})();
