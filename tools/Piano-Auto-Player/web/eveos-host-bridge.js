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

  function reportModuleFailure(name, error) {
    const detail = error?.message || String(error || 'Unknown module error');
    const message = `Failed to load Piano ${name}: ${detail}`;
    console.error(`[PianoAutoPlayer] ${message}`, error);
    const text = document.getElementById('statusText');
    const chip = document.getElementById('statusChip');
    if (text) text.textContent = message;
    if (chip) chip.dataset.state = 'error';
    window.dispatchEvent(new CustomEvent('piano:module-error', { detail: { name, message } }));
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
      .then(() => import('./piano_unified_workspace.js'))
      .catch(error => reportModuleFailure('My Songs workspace', error));
    import('./sheet_progress.js?v=bc691cc2')
      .catch(error => reportModuleFailure('Sheet Progress', error));
  });
})();
