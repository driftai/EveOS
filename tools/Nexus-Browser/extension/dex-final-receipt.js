(() => {
  // Only final RESULTS are replayed. Dispatched prompts are never retried here.
  const KEY = 'nexusDexPendingFinalsV1';
  const TTL_MS = 30 * 60 * 1000, MIN_RETRY_MS = 10000, MAX_PENDING = 16;
  function createOutbox({ storage, now = () => Date.now() } = {}) {
    const pending = new Map();
    const stats = { queued: 0, acknowledged: 0, retries: 0, expiredUnconfirmed: 0, lastError: null };
    let loaded = false, loading = null, writes = Promise.resolve();
    function persist() {
      if (!storage?.set) return Promise.reject(new Error('Durable final receipt storage unavailable.'));
      const snapshot = [...pending.values()].map((entry) => ({ ...entry }));
      writes = writes.catch(() => {}).then(() => storage.set({ [KEY]: snapshot }));
      return writes;
    }
    async function restore() {
      if (loaded) return;
      if (loading) return loading;
      loading = (async () => {
        const data = await storage?.get?.(KEY);
        for (const entry of data?.[KEY] || []) {
          if (!entry?.requestId || !entry?.payload || !Number.isFinite(entry.createdAt)) continue;
          pending.set(entry.requestId, entry);
        }
        loaded = true;
      })();
      try { await loading; } finally { loading = null; }
    }
    async function queue(payload, { tabId, providerId, send = () => false } = {}) {
      await restore();
      const id = String(payload?.requestId || '');
      if (payload?.type !== 'response_final' || !id || !payload.text || !tabId || !providerId)
        throw new Error('Final reply requires a bound provider tab, nonempty text and exact request ID.');
      if (pending.has(id)) {
        if (pending.get(id).payload.text !== payload.text)
          throw new Error('Conflicting final response for the same Dex request ID.');
        return { ok: true, queued: true, duplicate: true };
      }
      if (pending.size >= MAX_PENDING) throw new Error('Unacknowledged final result limit reached.');
      const entry = { requestId: id, tabId: Number(tabId), providerId,
        payload, createdAt: now(), lastSentAt: 0, expiredReported: false };
      pending.set(id, entry);
      try { await persist(); }
      catch (error) { pending.delete(id); stats.lastError = String(error?.message || error); throw error; }
      stats.queued += 1;
      flush({ tabId, providerId, send });
      return { ok: true, queued: true };
    }
    function flush({ tabId, providerId, send = () => false } = {}) {
      let sent = 0;
      for (const entry of pending.values()) {
        const age = now() - entry.createdAt;
        if (age > TTL_MS) {
          if (!entry.expiredReported) { entry.expiredReported = true; stats.expiredUnconfirmed += 1; }
          continue;
        }
        if (String(entry.tabId) !== String(tabId) || entry.providerId !== providerId) continue;
        if (entry.lastSentAt && now() - entry.lastSentAt < MIN_RETRY_MS) continue;
        if (!send(entry.payload)) continue;
        if (entry.lastSentAt) stats.retries += 1;
        entry.lastSentAt = now();
        sent += 1;
      }
      if (sent) persist().catch((error) => { stats.lastError = String(error?.message || error); });
      return { sent, pending: pending.size };
    }
    async function acknowledge(message) {
      if (message?.type !== 'dex_turn_receipt' || message.state !== 'committed') return false;
      await restore();
      if (!pending.has(message.requestId)) return false;
      pending.delete(message.requestId);
      await persist();
      stats.acknowledged += 1;
      return true;
    }
    function diagnostics() { return { ...stats, pending: pending.size,
      pendingRequestIds: [...pending.keys()] }; }
    return { queue, restore, flush, acknowledge, diagnostics };
  }
  const api = { KEY, TTL_MS, MIN_RETRY_MS, MAX_PENDING, createOutbox };
  if (typeof globalThis !== 'undefined') globalThis.BrowserAiBridgeDexFinalReceipt = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();