(() => {
  const OWNER_KEY = 'browser-ai-bridge.workspace-owner.v1';
  const SNAPSHOT_KEY = 'browser-ai-bridge.workspace-snapshot.v1';
  const CONTROL_TYPE = 'eveos:nexus-workspace-control';

  function parse(value) {
    try { return JSON.parse(value || 'null'); } catch { return null; }
  }

  function createCoordinator({
    storage = globalThis.localStorage,
    addEvent = globalThis.addEventListener?.bind(globalThis),
    removeEvent = globalThis.removeEventListener?.bind(globalThis),
    setTimer = globalThis.setTimeout?.bind(globalThis),
    clearTimer = globalThis.clearTimeout?.bind(globalThis),
    now = () => Date.now(),
    detached = new URLSearchParams(globalThis.location?.search || '').get('eveosDetached') === '1',
    instanceId = globalThis.crypto?.randomUUID?.() || `workspace-${Math.random().toString(36).slice(2)}`,
    heartbeatMs = 1500,
    ownerTtlMs = 5500
  } = {}) {
    const clients = new Map();
    let owned = false, started = false, timer = null;

    function readOwner() { return parse(storage?.getItem?.(OWNER_KEY)); }
    function readSnapshot() { return parse(storage?.getItem?.(SNAPSHOT_KEY)); }
    function ownerFresh(owner = readOwner()) {
      return !!owner?.id && Number.isFinite(Number(owner.at)) && now() - Number(owner.at) <= ownerTtlMs;
    }
    function restoreClient(name, client) {
      const part = readSnapshot()?.parts?.[name];
      if (part != null) {
        try { client.restore?.(part); } catch {}
      }
    }
    function applyOwnership(next) {
      if (owned === next) return;
      owned = next;
      for (const [name, client] of clients) {
        if (owned) {
          restoreClient(name, client);
          try { client.resume?.(); } catch {}
        } else {
          try { client.suspend?.(); } catch {}
        }
      }
    }
    function writeOwner() {
      const record = { version: 1, id: instanceId, detached: !!detached, at: now() };
      try { storage?.setItem?.(OWNER_KEY, JSON.stringify(record)); } catch {}
      return record;
    }
    function snapshotNow(reason = 'handoff') {
      const parts = {};
      for (const [name, client] of clients) {
        try { parts[name] = client.snapshot?.() ?? null; } catch { parts[name] = null; }
      }
      const value = { version: 1, at: now(), source: instanceId, detached: !!detached, reason, parts };
      try { storage?.setItem?.(SNAPSHOT_KEY, JSON.stringify(value)); } catch {}
      return value;
    }
    function claim({ force = false } = {}) {
      const current = readOwner();
      if (!force && current?.id !== instanceId && ownerFresh(current)) {
        applyOwnership(false);
        return false;
      }
      writeOwner();
      applyOwnership(true);
      return true;
    }
    function relinquish(reason = 'handoff') {
      if (owned) snapshotNow(reason);
      const current = readOwner();
      if (current?.id === instanceId) {
        try { storage?.removeItem?.(OWNER_KEY); } catch {}
      }
      applyOwnership(false);
    }
    function register(name, client = {}) {
      clients.set(String(name), client);
      if (owned) {
        restoreClient(String(name), client);
        try { client.resume?.(); } catch {}
      }
      return () => clients.delete(String(name));
    }
    function scheduleTick() {
      if (!started || !setTimer) return;
      timer = setTimer(() => {
        timer = null;
        const current = readOwner();
        if (owned) {
          if (current?.id === instanceId) writeOwner();
          else applyOwnership(false);
        } else if (!detached && !ownerFresh(current)) {
          claim({ force: true });
        }
        scheduleTick();
      }, heartbeatMs);
    }
    function onStorage(event = {}) {
      if (event.key === OWNER_KEY) {
        const current = parse(event.newValue);
        if (current?.id === instanceId) applyOwnership(true);
        else {
          applyOwnership(false);
          if (!current && !detached) claim({ force: true });
        }
      }
      if (event.key === SNAPSHOT_KEY && owned) {
        for (const [name, client] of clients) restoreClient(name, client);
      }
    }
    function onMessage(event = {}) {
      if (event.source !== globalThis.parent || event.data?.type !== CONTROL_TYPE) return;
      if (event.data.action === 'snapshot') snapshotNow(event.data.reason || 'parent-request');
      if (event.data.action === 'claim') claim({ force: true });
    }
    function onUnload() {
      if (owned) relinquish(detached ? 'detached-unload' : 'embedded-unload');
    }
    function start() {
      if (started) return;
      started = true;
      addEvent?.('storage', onStorage);
      addEvent?.('message', onMessage);
      addEvent?.('beforeunload', onUnload);
      claim({ force: !!detached });
      scheduleTick();
    }
    function stop() {
      started = false;
      if (timer != null) clearTimer?.(timer);
      timer = null;
      removeEvent?.('storage', onStorage);
      removeEvent?.('message', onMessage);
      removeEvent?.('beforeunload', onUnload);
      relinquish('coordinator-stop');
    }

    return {
      register, start, stop, claim, relinquish, snapshotNow,
      isOwner: () => owned, instanceId, detached,
      owner: () => readOwner(), snapshot: () => readSnapshot(),
      keys: { owner: OWNER_KEY, snapshot: SNAPSHOT_KEY }
    };
  }

  const api = { createCoordinator, OWNER_KEY, SNAPSHOT_KEY, CONTROL_TYPE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    const coordinator = createCoordinator();
    coordinator.start();
    globalThis.BrowserAiBridgeWorkspaceHandoff = coordinator;
  }
})();
