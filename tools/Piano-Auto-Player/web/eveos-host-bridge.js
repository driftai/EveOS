(function () {
  'use strict';

  const KEY = 'eveos:piano-host-context';
  const MODULE_RETRY_DELAYS = [250, 700, 1500];
  let context = null;
  let workspaceReady = false, workspaceLoad = null, sheetProgressReady = false, sheetProgressLoad = null;
  const failedModules = new Set();
  const eveHost = window.parent && window.parent !== window ? window.parent : window.opener;

  // Prevent the three legacy Piano surfaces from flashing as separate workspaces while the
  // queue/metadata controllers hydrate. Their DOM remains available as a compatibility bridge;
  // piano_unified_workspace.js becomes the only visible library/queue/inspector surface.
  const criticalStyle = document.createElement('style');
  criticalStyle.id = 'pianoUnifiedCriticalStyle';
  criticalStyle.textContent = '.library-panel,.sheet-workspace-queue,.sheet-workspace-planner>summary{display:none!important}';
  document.head.append(criticalStyle);

  function accept(event) {
    const payload = event?.data;
    if (!payload) return;
    if (payload.type === 'eveos:piano-refresh') {
      if (!eveHost || event.source !== eveHost) return;
      const text = document.getElementById('statusText');
      const chip = document.getElementById('statusChip');
      if (text) text.textContent = 'Reloading Piano workspace…';
      if (chip) chip.dataset.state = 'countdown';
      window.location.reload();
      return;
    }
    if (payload.type !== 'eveos:audioflix-context') return;
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
    failedModules.add(name);
    window.dispatchEvent(new CustomEvent('piano:module-error', { detail: { name, message } }));
  }

  function reportModuleRecovery(name) {
    if (!failedModules.delete(name)) return;
    const text = document.getElementById('statusText');
    const chip = document.getElementById('statusChip');
    if (text?.textContent?.startsWith(`Failed to load Piano ${name}:`)) text.textContent = 'Piano workspace recovered.';
    if (chip?.dataset.state === 'error') chip.dataset.state = 'idle';
    window.dispatchEvent(new CustomEvent('piano:module-recovered', { detail: { name } }));
  }

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const retryUrl = (url, attempt) => `${url}${url.includes('?') ? '&' : '?'}retry=${attempt}`;
  async function importWithRetry(initialImport, url) {
    let lastError;
    for (let attempt = 0; attempt <= MODULE_RETRY_DELAYS.length; attempt += 1) {
      try { return await (attempt === 0 ? initialImport() : import(retryUrl(url, attempt))); }
      catch (error) {
        lastError = error;
        if (attempt < MODULE_RETRY_DELAYS.length) await wait(MODULE_RETRY_DELAYS[attempt]);
      }
    }
    throw lastError;
  }

  try { context = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (_) {}
  window.addEventListener('message', accept);
  window.PianoEveOS = Object.freeze({ getContext: () => context ? { ...context } : null });
  eveHost?.postMessage?.({ type: 'piano:eveos-ready' }, '*');

  function installReattachControl() {
    const detached = new URL(window.location.href).searchParams.get('eveosDetached') === '1';
    const topbar = document.querySelector('.topbar');
    if (!detached || !window.opener || !topbar || document.getElementById('reattachEveOSBtn')) return;
    document.documentElement.classList.add('eveos-piano-detached');
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'reattachEveOSBtn';
    button.className = 'ghost piano-reattach';
    button.textContent = 'Reattach to EveOS';
    button.addEventListener('click', () => window.opener?.postMessage?.({ type: 'piano:eveos-reattach-request' }, '*'));
    topbar.append(button);
  }

  function loadWorkspaceModules() {
    installReattachControl();
    if (!workspaceReady && !workspaceLoad) {
      workspaceLoad = importWithRetry(() => import('./player_queue.js'), './player_queue.js')
        .then(() => importWithRetry(() => import('./player_queue_advanced.js'), './player_queue_advanced.js'))
        .then(() => importWithRetry(() => import('./piano_unified_workspace.js'), './piano_unified_workspace.js'))
        .then(() => { workspaceReady = true; reportModuleRecovery('My Songs workspace'); })
        .catch(error => reportModuleFailure('My Songs workspace', error))
        .finally(() => { workspaceLoad = null; });
    }
    if (!sheetProgressReady && !sheetProgressLoad) {
      sheetProgressLoad = importWithRetry(() => import('./sheet_progress.js?v=bc691cc2'), './sheet_progress.js?v=bc691cc2')
        .then(() => { sheetProgressReady = true; reportModuleRecovery('Sheet Progress'); })
        .catch(error => reportModuleFailure('Sheet Progress', error))
        .finally(() => { sheetProgressLoad = null; });
    }
  }

  window.addEventListener('piano:eveos-context', loadWorkspaceModules);
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', loadWorkspaceModules, { once: true });
  else loadWorkspaceModules();
})();
