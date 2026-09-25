(() => {
  const CHECK_MS = 5000, RELOAD_COOLDOWN_MS = 60000;
  function createBoundTabWatchdog({
    chromeApi = globalThis.chrome,
    getSocket = () => null,
    expectedRevision = Number(globalThis.BrowserAiBridgeProviderAdapterRevision?.ADAPTER_REVISION || 0),
    now = Date.now
  } = {}) {
    let requestId = null, lastRequestAt = 0;
    const reloading = new Map(), metrics = { requests: 0, snapshots: 0, scans: 0,
      rescans: 0, softRepairs: 0, reloads: 0, deferred: 0, errors: 0, lastError: null };
    const uid = () => 'dex-bound-watch-' + now() + '-' + Math.random().toString(36).slice(2);
    const open = (ws) => !!ws && ws.readyState === 1;
    async function ping(tabId, type) {
      try { return await chromeApi.tabs.sendMessage(Number(tabId), { type }); }
      catch { return null; }
    }
    async function repairTarget(target) {
      if (target?.providerId !== 'chatgpt') return;
      const tabId = Number(target.targetId);
      if (!Number.isSafeInteger(tabId) || tabId < 1 || !target.url) return;
      metrics.scans++;
      try {
        const tab = await chromeApi.tabs.get(tabId);
        if (String(tab?.url || '') !== String(target.url)) return;
        const revision = await ping(tabId, 'provider_adapter_revision_ping');
        const control = await ping(tabId, 'dex_provider_control_ping');
        const currentRevision = revision?.ok === true
          && Number(revision.revision || 0) === expectedRevision;
        const currentControl = control?.ok === true && control.adapter === 'dex-provider-control'
          && Number(control.revision || 0) === expectedRevision;
        if (currentRevision && currentControl) {
          const ack = await chromeApi.tabs.sendMessage(tabId, { type: 'dex_provider_control_rescan' })
            .catch(() => null);
          if (ack?.ok === true) metrics.rescans++;
          return;
        }
        if (currentRevision && !currentControl) {
          await chromeApi.scripting.executeScript({
            target: { tabId }, files: ['content/dex-provider-control.js']
          });
          metrics.softRepairs++;
          const ready = await ping(tabId, 'dex_provider_control_ping');
          if (ready?.ok === true && Number(ready.revision || 0) === expectedRevision) {
            await chromeApi.tabs.sendMessage(tabId, { type: 'dex_provider_control_rescan' }).catch(() => null);
            metrics.rescans++; return;
          }
        }
        const until = Number(reloading.get(tabId) || 0);
        if (until > now()) { metrics.deferred++; return; }
        // Stale/missing revision requires a clean isolated-world bootstrap.
        // Only exact tabs named by localhost's durable Dex membership snapshot
        // are eligible; reload is bounded to once per minute per tab.
        reloading.set(tabId, now() + RELOAD_COOLDOWN_MS);
        await chromeApi.tabs.reload(tabId, { bypassCache: true });
        metrics.reloads++;
      } catch (error) {
        metrics.errors++; metrics.lastError = String(error?.message || error).slice(0, 160);
      }
    }
    function request() {
      const ws = getSocket();
      if (!open(ws) || requestId || now() - lastRequestAt < CHECK_MS - 250) return false;
      requestId = uid(); lastRequestAt = now(); metrics.requests++;
      try { ws.send(JSON.stringify({ type: 'dex_bound_targets_request', requestId })); return true; }
      catch (error) {
        requestId = null; metrics.errors++; metrics.lastError = String(error?.message || error).slice(0,160);
        return false;
      }
    }
    function handleServerMessage(msg) {
      if (msg?.type !== 'dex_bound_targets_snapshot') return false;
      if (requestId && String(msg.requestId || '') !== requestId) return true;
      requestId = null; metrics.snapshots++;
      for (const target of Array.isArray(msg.targets) ? msg.targets : []) repairTarget(target);
      return true;
    }
    function disconnected() { requestId = null; }
    function diagnostics() { return { ...metrics, pendingRequest: !!requestId, trackedReloads: reloading.size }; }
    const timer = setInterval(request, CHECK_MS);
    timer?.unref?.();
    return { request, handleServerMessage, disconnected, diagnostics, stop: () => clearInterval(timer) };
  }
  const api = { createBoundTabWatchdog, CHECK_MS, RELOAD_COOLDOWN_MS };
  globalThis.BrowserAiBridgeDexBoundTabWatchdog = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
