'use strict';

function createChildHealthProbe({
  timeoutMs = 750,
  timers = globalThis,
  now = () => Date.now()
} = {}) {
  let sequence = 0;
  const pending = new Map();

  function finish(nonce, value) {
    const entry = pending.get(nonce);
    if (!entry) return false;
    pending.delete(nonce);
    try { timers.clearTimeout(entry.timer); } catch {}
    entry.resolve(value);
    return true;
  }

  function handle(child, message = {}) {
    if (message.type !== 'supervisor_health_ack' || !message.nonce) return false;
    const nonce = String(message.nonce);
    const entry = pending.get(nonce);
    if (!entry || entry.child !== child) return false;
    return finish(nonce, {
      ok: true,
      listening: message.listening === true,
      sessionId: String(message.sessionId || ''),
      address: message.address || null
    });
  }

  function probe(child) {
    if (!child || child.killed || child.connected === false || typeof child.send !== 'function') {
      return Promise.resolve({ ok: false, listening: false, reason: 'ipc-unavailable' });
    }
    const nonce = 'health-' + process.pid + '-' + (++sequence) + '-' + now();
    return new Promise((resolve) => {
      const timer = timers.setTimeout(() => {
        finish(nonce, { ok: false, listening: false, reason: 'ipc-timeout' });
      }, timeoutMs);
      pending.set(nonce, { child, timer, resolve });
      try {
        child.send({ type: 'supervisor_health_probe', nonce });
      } catch (error) {
        finish(nonce, { ok: false, listening: false, reason: error?.code || 'ipc-send-failed' });
      }
    });
  }

  function clearChild(child) {
    for (const [nonce, entry] of pending) {
      if (entry.child === child) {
        finish(nonce, { ok: false, listening: false, reason: 'child-exited' });
      }
    }
  }

  return { probe, handle, clearChild, pendingCount: () => pending.size };
}

module.exports = { createChildHealthProbe };
