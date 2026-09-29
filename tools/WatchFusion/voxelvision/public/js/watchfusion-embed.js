(() => {
  'use strict';
  function announceReady() {
    if (window.parent === window) return;
    window.parent.postMessage({ type: 'watchfusion:voxelvision-ready' }, location.origin);
  }
  if (document.readyState === 'complete') announceReady();
  else window.addEventListener('load', announceReady, { once: true });
})();
