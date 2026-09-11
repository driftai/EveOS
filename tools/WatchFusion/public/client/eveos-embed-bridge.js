(function () {
  'use strict';

  if (window.__watchFusionEveBridgeReady) return;
  window.__watchFusionEveBridgeReady = true;

  const embedded = window.parent && window.parent !== window;
  const detached = !embedded && window.opener && !window.opener.closed;
  let storageAccess = null;

  async function sampleStorageAccess() {
    if (typeof document.hasStorageAccess !== 'function') return;
    try { storageAccess = await document.hasStorageAccess(); }
    catch { storageAccess = null; }
    document.documentElement.classList.toggle('watchfusion-storage-partitioned', storageAccess === false);
  }

  function message(type) {
    return {
      source: 'WatchFusion',
      version: 1,
      type,
      url: location.href,
      embedded,
      detached,
      storageAccess,
      time: Date.now()
    };
  }

  function heartbeat() {
    try {
      if (embedded) window.parent.postMessage(message('watchfusion:embedded-presence'), '*');
      if (detached) window.opener.postMessage(message('watchfusion:detached-presence'), '*');
    } catch {}
  }

  sampleStorageAccess().finally(heartbeat);
  window.setInterval(heartbeat, 1500);
  window.addEventListener('pageshow', () => { sampleStorageAccess(); heartbeat(); });
  document.addEventListener('visibilitychange', heartbeat);
})();
