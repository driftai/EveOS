(() => {
  'use strict';
  let authorization = null;
  function enabled() { return !!authorization; }
  function authorize(payload = {}) {
    return authorization ? { ...payload, machineAuthorization: authorization } : payload;
  }
  function publish(detail = {}) {
    authorization = detail.enabled === true && detail.authorization ? Object.freeze({ ...detail.authorization }) : null;
    globalThis.dispatchEvent?.(new CustomEvent('machine-human-gate-change', {
      detail: { enabled: enabled(), roomId: authorization?.roomId || null }
    }));
  }
  globalThis.addEventListener?.('machine-human-input-state', (event) => publish(event.detail));
  globalThis.addEventListener?.('pagehide', () => publish({ enabled: false }), { once: true });
  globalThis.BrowserAiBridgeMachineHumanGate = Object.freeze({ enabled, authorize });
})();
