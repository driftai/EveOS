'use strict';
// Dex UI wakes only for control; the localhost scheduler owns ongoing turns.
function createEnsureDexClient({
  dexRouting, sendToExtension, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  return async function ensureDexClient() {
    const existing = dexRouting.dexClient();
    if (existing) return existing;
    sendToExtension({ type: 'ensure_dex_ui' });
    const deadline = now() + 5000;
    while (now() < deadline) {
      const client = dexRouting.dexClient();
      if (client) return client;
      await sleep(100);
    }
    return null;
  };
}
module.exports = { createEnsureDexClient };
