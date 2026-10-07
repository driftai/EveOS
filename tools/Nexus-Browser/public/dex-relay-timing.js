(() => {
  // Relay timing for the Dex log. Each final requestId is timed once: the
  // extension outbox may redeliver the same final (with its original
  // observedAt) until a receipt lands, and a replay must never log again or
  // restart the handoff clock from a stale timestamp.
  const MAX_SEEN = 256, MAX_HANDOFF_MS = 10 * 60 * 1000;
  function createTracker({ now = () => Date.now(), maxHandoffMs = MAX_HANDOFF_MS } = {}) {
    const seen = new Set();
    let last = null;
    function remember(id) {
      seen.add(id);
      while (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
    }
    function onFinal(msg = {}) {
      const id = String(msg.requestId || '');
      if (id && seen.has(id)) return null;
      if (id) remember(id);
      const observedAt = Number(msg.observedAt) || now();
      const provider = msg.providerName || msg.providerId || 'provider';
      last = { requestId: id || null, provider, at: observedAt };
      const settleMs = Number(msg.detail?.adapterSettleMs), totalMs = Number(msg.detail?.totalResponseMs), firstMs = Number(msg.detail?.timeToFirstResponseMs);
      return `Relay timing: ${provider} final${Number.isFinite(totalMs) ? ` in ${totalMs} ms · first response ${Number.isFinite(firstMs) ? firstMs : '?'} ms` : Number.isFinite(settleMs) ? ` settled in ${settleMs} ms` : ''}.`;
    }
    function onAccepted(msg = {}) {
      if (!last) return null;
      const prior = last;
      last = null;
      if (msg.requestId && prior.requestId && String(msg.requestId) === prior.requestId) return null;
      const acceptedAt = Number(msg.observedAt) || now();
      const handoffMs = acceptedAt - prior.at;
      if (!Number.isFinite(handoffMs) || handoffMs < 0 || handoffMs > maxHandoffMs) return null;
      return `Relay timing: ${prior.provider} → ${msg.providerName || msg.providerId || 'provider'} accepted in ${handoffMs} ms.`;
    }
    return { onFinal, onAccepted, diagnostics: () => ({ seen: seen.size, armed: !!last }) };
  }
  const api = { MAX_SEEN, MAX_HANDOFF_MS, createTracker };
  if (typeof globalThis !== 'undefined') globalThis.BrowserAiBridgeDexRelayTiming = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
