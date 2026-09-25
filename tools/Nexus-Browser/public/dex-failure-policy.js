(() => {
  const TABLE = Object.freeze({
    EXTENSION_OFFLINE: { action: 'retry', maxAttempts: 6, delays: [500, 800, 1300, 2100, 3400, 5000] },
    LOCAL_EXISTING_BUSY: { action: 'retry', maxAttempts: 6, delays: [600, 900, 1300, 1900, 2800, 4000] },
    LOCAL_EXISTING_NOT_READY: { action: 'retry', maxAttempts: 6, delays: [800, 1200, 1800, 2600, 3800, 5000] },
    LOCAL_EXISTING_TIMEOUT: { action: 'recover', maxAttempts: 0, delays: [] },
    LOCAL_TARGET_NOT_FOUND: { action: 'refresh_target', maxAttempts: 4, delays: [500, 900, 1500, 2500] },
    COMMAND_FAILED: { action: 'recover', maxAttempts: 4, delays: [900, 1400, 2200, 3500] },
    PROMPT_SEND_FAILED: { action: 'recover', maxAttempts: 0, delays: [] },
    PROVIDER_CONNECTION_INTERRUPTED: { action: 'recover', maxAttempts: 0, delays: [] },
    RESPONSE_TIMEOUT: { action: 'recover', maxAttempts: 0, delays: [] },
    RESPONSE_TIMEOUT_ACTIVE: { action: 'recover', maxAttempts: 0, delays: [] },
    RESPONSE_TIMEOUT_ABSOLUTE: { action: 'recover', maxAttempts: 0, delays: [] },
    HOST_ACCESS_REQUIRED: { action: 'pause', maxAttempts: 0, delays: [] },
    DEX_CONTROL_NOT_BOUND: { action: 'pause', maxAttempts: 0, delays: [] },
    PROVIDER_RATE_LIMITED: { action: 'pause', maxAttempts: 0, delays: [] },
    PROVIDER_CONVERSATION_LIMIT: { action: 'pause', maxAttempts: 0, delays: [] },
    PROVIDER_AUTH_REQUIRED: { action: 'pause', maxAttempts: 0, delays: [] },
    PROVIDER_UNAVAILABLE: { action: 'pause', maxAttempts: 0, delays: [] }
  });

  function canonicalCode(code) {
    const raw = String(code || '').trim().toUpperCase();
    if (/_CONNECTION_INTERRUPTED$/.test(raw)) return 'PROVIDER_CONNECTION_INTERRUPTED';
    return raw;
  }

  function policyFor(code) {
    return TABLE[canonicalCode(code)] || { action: 'incident', maxAttempts: 0, delays: [] };
  }

  function decision(code, { dispatched = false, retryCount = 0 } = {}) {
    const policy = policyFor(code);
    if (dispatched && ['retry', 'refresh_target'].includes(policy.action)) {
      return { ...policy, action: 'recover', retry: false, delayMs: 0, reason: 'dispatch-may-have-occurred' };
    }
    const attempt = Math.max(0, Number(retryCount) || 0);
    const retry = ['retry', 'refresh_target'].includes(policy.action) && attempt < policy.maxAttempts;
    const index = Math.min(attempt, Math.max(0, policy.delays.length - 1));
    return {
      ...policy,
      retry,
      delayMs: retry ? Number(policy.delays[index] || 0) : 0,
      attempt: attempt + 1
    };
  }

  function dispatchMayHaveOccurred(state) {
    return new Set(['dispatching', 'accepted', 'responding', 'completed', 'failed']).has(String(state || ''));
  }

  const api = { TABLE, canonicalCode, policyFor, decision, dispatchMayHaveOccurred };
  globalThis.BrowserAiBridgeDexFailurePolicy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
