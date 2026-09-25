(() => {
  const CHECK_MS = 5000, RELOAD_COOLDOWN_MS = 60000;
  function createBoundTabWatchdog({
    chromeApi = globalThis.chrome, getSocket = () => null,
    expectedRevision = Number(globalThis.BrowserAiBridgeProviderAdapterRevision?.ADAPTER_REVISION || 0),
    now = Date.now
  } = {}) {
    let requestId = null, lastRequestAt = 0;
    const reloading = new Map(), metrics = { requests: 0, snapshots: 0, scans: 0,
      rescans: 0, softRepairs: 0, reloads: 0, runtimeReloads: 0,
      deferred: 0, errors: 0, lastError: null };
    const uid = () => 'dex-bound-watch-' + now() + '-' + Math.random().toString(36).slice(2);
    const open = (ws) => !!ws && ws.readyState === 1;
    async function ping(tabId, type) {
      try { return await chromeApi.tabs.sendMessage(Number(tabId), { type }); }
      catch { return null; }
    }
    async function composerHasDraft(tabId) {
      try {
        const rows = await chromeApi.scripting.executeScript({
          target: { tabId }, func: () => {
            const fields = [...document.querySelectorAll('textarea,[contenteditable="true"]')];
            return fields.some((node) => {
              const style = getComputedStyle(node);
              if (style.display === 'none' || style.visibility === 'hidden') return false;
              return !!String('value' in node ? node.value : node.textContent || '').trim();
            });
          }
        });
        return rows?.some((row) => row?.result === true) === true;
      } catch { return true; }
    }
    async function runtimeReloadIfNeeded(snapshot) {
      const wanted = Number(snapshot?.expectedAdapterRevision || 0);
      if (!wanted || wanted === expectedRevision) {
        try { await chromeApi.storage?.local?.remove?.('nexus-extension-runtime-reload'); } catch {}
        return false;
      }
      if (snapshot?.reloadSafe !== true) { metrics.deferred++; return false; }
      const store = chromeApi.storage?.local;
      if (!store?.get || !store?.set || !chromeApi.runtime?.reload) return false;
      const key = 'nexus-extension-runtime-reload', prior = (await store.get(key))?.[key];
      if (prior?.expectedAdapterRevision === wanted) { metrics.deferred++; return false; }
      await store.set({ [key]: { expectedAdapterRevision: wanted,
        observedAdapterRevision: expectedRevision, attemptedAt: now() } });
      metrics.runtimeReloads++; chromeApi.runtime.reload(); return true;
    }
    async function repairTarget(target, { hardReloadSafe = false } = {}) {
      if (target?.providerId !== 'chatgpt') return;
      const tabId = Number(target.targetId);
      if (!Number.isSafeInteger(tabId) || tabId < 1 || !target.url) return;
      metrics.scans++;
      try {
        const tab = await chromeApi.tabs.get(tabId);
        if (String(tab?.url || '') !== String(target.url)) return;
        const revision = await ping(tabId, 'provider_adapter_revision_ping');
        const control = await ping(tabId, 'dex_provider_control_ping');
        const currentRevision = revision?.ok === true && Number(revision.revision || 0) === expectedRevision;
        const currentControl = control?.ok === true && control.adapter === 'dex-provider-control'
          && Number(control.revision || 0) === expectedRevision;
        const reloadKey = 'nexus-bound-tab-reload:' + tabId;
        if (currentRevision && currentControl) {
          try { await chromeApi.storage?.session?.remove?.(reloadKey); } catch {}
          const ack = await chromeApi.tabs.sendMessage(tabId, { type: 'dex_provider_control_rescan' }).catch(() => null);
          if (ack?.ok === true) metrics.rescans++;
          return;
        }
        if (currentRevision && !currentControl) {
          await chromeApi.scripting.executeScript({ target: { tabId }, files: ['content/dex-provider-control.js'] });
          metrics.softRepairs++;
          const ready = await ping(tabId, 'dex_provider_control_ping');
          if (ready?.ok === true && Number(ready.revision || 0) === expectedRevision) {
            await chromeApi.tabs.sendMessage(tabId, { type: 'dex_provider_control_rescan' }).catch(() => null);
            metrics.rescans++; return;
          }
        }
        if (!hardReloadSafe || await composerHasDraft(tabId)) { metrics.deferred++; return; }
        const session = chromeApi.storage?.session;
        const prior = session?.get ? (await session.get(reloadKey))?.[reloadKey] : null;
        if (prior?.expectedRevision === expectedRevision) { metrics.deferred++; return; }
        const until = Number(reloading.get(tabId) || 0);
        if (until > now()) { metrics.deferred++; return; }
        reloading.set(tabId, now() + RELOAD_COOLDOWN_MS);
        if (session?.set) await session.set({ [reloadKey]: { expectedRevision, attemptedAt: now() } });
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
      runtimeReloadIfNeeded(msg).then((reloadingRuntime) => {
        if (reloadingRuntime) return;
        for (const target of Array.isArray(msg.targets) ? msg.targets : [])
          repairTarget(target, { hardReloadSafe: msg.reloadSafe === true });
      });
      return true;
    }
    function disconnected() { requestId = null; }
    function diagnostics() { return { ...metrics, pendingRequest: !!requestId, trackedReloads: reloading.size }; }
    const timer = setInterval(request, CHECK_MS);
    timer?.unref?.();
    return { request, handleServerMessage, disconnected, diagnostics, repairTarget,
      runtimeReloadIfNeeded, stop: () => clearInterval(timer) };
  }
  const api = { createBoundTabWatchdog, CHECK_MS, RELOAD_COOLDOWN_MS };
  globalThis.BrowserAiBridgeDexBoundTabWatchdog = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
