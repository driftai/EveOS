(function () {
  'use strict';

  const KEY = 'eveos:piano-host-context';
  let context = null;

  function accept(event) {
    const payload = event?.data;
    if (!payload || payload.type !== 'eveos:audioflix-context') return;
    context = payload.context && typeof payload.context === 'object' ? payload.context : null;
    try {
      if (context) sessionStorage.setItem(KEY, JSON.stringify(context));
      else sessionStorage.removeItem(KEY);
    } catch (_) {}
    window.dispatchEvent(new CustomEvent('piano:eveos-context', { detail: context }));
  }

  try { context = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (_) {}
  window.addEventListener('message', accept);
  window.PianoEveOS = Object.freeze({ getContext: () => context ? { ...context } : null });
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'piano:eveos-ready' }, '*');
  }

  window.addEventListener('load', () => {
    import('./player_queue.js')
      .then(() => import('./player_queue_advanced.js'))
      .catch(() => {});
    import('./sheet_progress.js?v=1999211b').catch(() => {});
  });
})();