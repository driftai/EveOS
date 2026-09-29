(() => {
  const ALLOWED_STATES = new Set(['ready', 'rate_limited', 'conversation_limit', 'auth_required', 'provider_unavailable']);
  const ALLOWED_ACTIONS = new Set(['none', 'wait', 'new_chat', 'reauth', 'retry_later']);
  const byTab = new Map();

  const clean = (value, max = 320) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

  function normalize(health = {}, now = Date.now()) {
    const state = ALLOWED_STATES.has(health.state) ? health.state : 'ready';
    const blocking = state !== 'ready' && health.blocking !== false;
    const action = ALLOWED_ACTIONS.has(health.action) ? health.action : (blocking ? 'retry_later' : 'none');
    const cooldown = Date.parse(health.cooldownUntil || '');
    const detected = Date.parse(health.detectedAt || '');
    return {
      state, blocking, action,
      summary: clean(health.summary, 220) || (blocking ? 'Provider blocked' : 'Ready'),
      detectedAt: new Date(Number.isFinite(detected) ? detected : now).toISOString(),
      cooldownUntil: Number.isFinite(cooldown) ? new Date(cooldown).toISOString() : null,
      resetText: clean(health.resetText, 160) || null,
      evidence: clean(health.evidence, 320) || null,
      source: 'provider-ui'
    };
  }

  function get(tabId) {
    const value = byTab.get(Number(tabId));
    return value ? { ...value } : null;
  }

  function forget(tabId) {
    return byTab.delete(Number(tabId));
  }

  function set(tabId, providerId, health) {
    const next = { ...normalize(health), tabId: Number(tabId), providerId: clean(providerId, 80) };
    const previous = byTab.get(Number(tabId));
    byTab.set(Number(tabId), next);
    return { changed: JSON.stringify(previous || null) !== JSON.stringify(next), health: { ...next } };
  }

  async function snapshot(chromeApi, tabId, providerId) {
    const id = Number(tabId);
    let reply = null;
    try { reply = await chromeApi?.tabs?.sendMessage?.(id, { type: 'provider_health_snapshot' }); } catch {}
    if (!reply?.ok) {
      try {
        const file = globalThis.BrowserAiBridgeExtensionAssets?.path('content/provider-health.js') || 'content/provider-health.js';
        await chromeApi?.scripting?.executeScript?.({ target: { tabId: id }, files: [file] });
        reply = await chromeApi?.tabs?.sendMessage?.(id, { type: 'provider_health_snapshot' });
      } catch {}
    }
    if (reply?.ok && reply.health) return set(id, providerId, reply.health).health;
    return get(id);
  }

  function errorFor(health) {
    if (!health?.blocking) return null;
    const codes = {
      rate_limited: 'PROVIDER_RATE_LIMITED',
      conversation_limit: 'PROVIDER_CONVERSATION_LIMIT',
      auth_required: 'PROVIDER_AUTH_REQUIRED',
      provider_unavailable: 'PROVIDER_UNAVAILABLE'
    };
    const error = new Error(health.summary || 'Provider is not currently available for a new prompt.');
    error.code = codes[health.state] || 'PROVIDER_BLOCKED';
    error.detail = { health: { ...health } };
    return error;
  }

  async function assertSendable(chromeApi, tabId, providerId) {
    const health = await snapshot(chromeApi, tabId, providerId);
    const error = errorFor(health);
    if (error) throw error;
    return health;
  }

  function handle(msg, sender, { providerForUrl, safeSend, scheduleTabPublish }) {
    if (msg?.type !== 'provider_health_update') return false;
    const tabId = Number(sender?.tab?.id);
    const provider = Number.isInteger(tabId) ? providerForUrl?.(String(sender?.tab?.url || sender?.url || '')) : null;
    if (!provider) return true;
    const updated = set(tabId, provider.id, msg.health || {});
    if (updated.changed) {
      safeSend?.({ type: 'provider_health_update', tabId, providerId: provider.id, providerName: provider.name, health: updated.health });
      scheduleTabPublish?.();
    }
    return true;
  }

  const api = { ALLOWED_STATES, ALLOWED_ACTIONS, clean, normalize, get, forget, set, snapshot, errorFor, assertSendable, handle };
  globalThis.BrowserAiBridgeProviderHealthState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
