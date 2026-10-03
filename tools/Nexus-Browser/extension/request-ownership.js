(() => {
  const KEY = 'nexusRequestOwnersV1';
  const TTL_MS = 30 * 60 * 1000;
  const MAX_OWNERS = 256;

  function createStore({ storage = globalThis.chrome?.storage?.session || globalThis.chrome?.storage?.local,
    now = () => Date.now() } = {}) {
    const owners = new Map();
    let loaded = false, loading = null, writes = Promise.resolve();

    function prune() {
      const cutoff = now() - TTL_MS;
      for (const [requestId, owner] of owners) {
        if (!owner || owner.createdAt < cutoff) owners.delete(requestId);
      }
      while (owners.size > MAX_OWNERS) owners.delete(owners.keys().next().value);
    }

    function persist() {
      if (!storage?.set) return Promise.resolve(false);
      prune();
      const snapshot = [...owners.entries()].map(([requestId, owner]) => ({ requestId, ...owner }));
      writes = writes.catch(() => {}).then(() => storage.set({ [KEY]: snapshot })).then(() => true);
      return writes;
    }

    async function restore() {
      if (loaded) return;
      if (loading) return loading;
      loading = (async () => {
        const result = await storage?.get?.(KEY);
        for (const row of result?.[KEY] || []) {
          const requestId = String(row?.requestId || '');
          const tabId = Number(row?.tabId);
          const providerId = String(row?.providerId || '');
          const createdAt = Number(row?.createdAt);
          if (!requestId || !Number.isInteger(tabId) || !providerId || !Number.isFinite(createdAt)) continue;
          owners.set(requestId, { tabId, providerId, createdAt });
        }
        prune();
        loaded = true;
      })();
      try { await loading; } finally { loading = null; }
    }

    async function remember(requestId, tabId, providerId) {
      requestId = String(requestId || '');
      tabId = Number(tabId);
      providerId = String(providerId || '');
      if (!requestId || !Number.isInteger(tabId) || !providerId) return null;
      await restore();
      prune();
      const existing = owners.get(requestId);
      if (existing && (existing.tabId !== tabId || existing.providerId !== providerId)) {
        throw new Error('Request ownership cannot move to a different provider target.');
      }
      const owner = existing || { tabId, providerId, createdAt: now() };
      owners.set(requestId, owner);
      prune();
      await persist();
      return { ...owner };
    }

    async function get(requestId) {
      requestId = String(requestId || '');
      if (!requestId) return null;
      await restore();
      const before = owners.size;
      prune();
      if (owners.size !== before) persist().catch(() => {});
      const owner = owners.get(requestId);
      return owner ? { ...owner } : null;
    }

    async function authorize(requestId, tabId) {
      const owner = await get(requestId);
      if (!owner) return { ok: false, reason: 'missing-owner', owner: null };
      if (owner.tabId !== Number(tabId)) return { ok: false, reason: 'tab-mismatch', owner };
      return { ok: true, reason: null, owner };
    }

    async function forget(requestId) {
      await restore();
      if (!owners.delete(String(requestId || ''))) return false;
      await persist();
      return true;
    }

    function diagnostics() {
      prune();
      return { pending: owners.size, requestIds: [...owners.keys()] };
    }

    return { restore, remember, get, authorize, forget, diagnostics };
  }

  const api = { KEY, TTL_MS, MAX_OWNERS, createStore };
  if (typeof globalThis !== 'undefined') globalThis.BrowserAiBridgeRequestOwnership = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
