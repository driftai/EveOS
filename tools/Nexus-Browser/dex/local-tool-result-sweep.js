'use strict';
// Pure scheduler for queued Local-Origin tool-result notifications. This is
// deliberately NOT wired to the live server: Windows owner attestation and an
// exclusive native dispatch lease must be supplied before enabling it.
const MAX_PER_SWEEP = 4, MIN_COOLDOWN_MS = 5000;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
function available(room) {
  return !!room && !room.recovery && !room.pendingTurn
    && !room.pendingProviderControlReceipt
    && !(room.deferredRelays || []).length
    && !room.relay?.active && !room.relay?.waitingFor;
}
function uniqueOwner(room, result) {
  if (result?.state !== 'queued' || !ID.test(String(result.requestId || ''))
    || !ID.test(String(result.memberId || ''))
    || !ID.test(String(result.targetId || ''))
    || !ID.test(String(result.providerId || ''))) return false;
  return (room.members || []).filter(member => member?.id === result.memberId
    && member.binding?.targetClassId === 'local-origin'
    && member.binding?.targetId === result.targetId
    && member.binding?.providerId === result.providerId).length === 1;
}
function createLocalResultSweep({
  load, deliverOne, canWork = () => false, now = Date.now,
  cooldownMs = 30000, maxPerSweep = 2, onStatus = () => {}
} = {}) {
  if (typeof load !== 'function' || typeof deliverOne !== 'function')
    throw new TypeError('Trusted snapshot loader and one-shot delivery service are required.');
  if (!Number.isInteger(maxPerSweep) || maxPerSweep < 1 || maxPerSweep > MAX_PER_SWEEP
    || !Number.isSafeInteger(cooldownMs) || cooldownMs < MIN_COOLDOWN_MS)
    throw new TypeError('Receipt sweep must have bounded cadence and concurrency.');
  const attempted = new Map(), recentTargets = new Map();
  let running = null;
  async function once() {
    if (canWork() !== true) return { ok: false, code: 'DEX_LOCAL_RESULT_SWEEP_DISABLED' };
    if (running) return { ok: false, code: 'DEX_LOCAL_RESULT_SWEEP_IN_FLIGHT' };
    const stamp = now();
    if (!Number.isFinite(stamp)) return { ok: false, code: 'DEX_LOCAL_RESULT_SWEEP_BAD_CLOCK' };
    const work = (async () => {
      const snapshot = load(), rooms = snapshot?.rooms || [];
      if (!Array.isArray(rooms) || rooms.length > 128)
        return { ok: false, code: 'DEX_LOCAL_RESULT_SWEEP_BAD_STATE' };
      for (const map of [attempted, recentTargets]) {
        for (const [key, at] of map) if (stamp - at >= cooldownMs * 2) map.delete(key);
      }
      let visited = 0, attempts = 0, submitted = 0, unknown = 0;
      for (const room of rooms) {
        if (!available(room)) continue;
        const queued = Array.isArray(room.localToolResults) ? room.localToolResults : [];
        for (const entry of queued) {
          if (attempts >= maxPerSweep) break;
          if (!uniqueOwner(room, entry)) continue;
          const key = room.id + ':' + entry.requestId;
          const targetKey = entry.providerId + ':' + entry.targetId;
          visited++;
          if (stamp - (attempted.get(key) ?? -Infinity) < cooldownMs
            || stamp - (recentTargets.get(targetKey) ?? -Infinity) < cooldownMs) continue;
          if (canWork() !== true) return { ok: false, code: 'DEX_LOCAL_RESULT_SWEEP_LEASE_LOST',
            visited, attempts, submitted, unknown };
          // The underlying delivery service reattests after each await, makes
          // the durable claim BEFORE console I/O and never retries a claimed ID.
          attempted.set(key, stamp);
          recentTargets.set(targetKey, stamp);
          attempts++;
          let result;
          try { result = await deliverOne({ roomId: room.id, requestId: entry.requestId }); }
          catch { result = { ok: false, code: 'DEX_LOCAL_RESULT_SWEEP_OUTCOME_UNKNOWN' }; }
          if (result?.state === 'submitted-not-read') submitted++;
          if (result?.state === 'outcome-unknown' ||
            result?.code === 'DEX_LOCAL_RESULT_SWEEP_OUTCOME_UNKNOWN') unknown++;
          try { onStatus({ roomId: room.id, requestId: entry.requestId,
            code: String(result?.code || 'DEX_LOCAL_RESULT_UNKNOWN').slice(0, 96),
            state: result?.state || null }); } catch {}
        }
        if (attempts >= maxPerSweep) break;
      }
      return { ok: true, visited, attempts, submitted, unknown };
    })();
    running = work;
    try { return await work; }
    finally { running = null; }
  }
  return { once };
}
module.exports = { MAX_PER_SWEEP, MIN_COOLDOWN_MS, available,
  uniqueOwner, createLocalResultSweep };
