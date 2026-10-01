'use strict';

const { createHash } = require('node:crypto');
const { createPassiveTurnLedger } = require('./passive-turn-ledger');

const WATCH_MS = Number(process.env.NEXUS_BROWSER_APP_WATCH_MS
  || process.env.BROWSER_AI_BRIDGE_APP_WATCH_MS || 2000);
const IDLE_MS = Number(process.env.NEXUS_BROWSER_APP_WATCH_IDLE_MS
  || process.env.BROWSER_AI_BRIDGE_APP_WATCH_IDLE_MS || 6000);
const RETRY_MS = Number(process.env.NEXUS_BROWSER_APP_WATCH_RETRY_MS
  || process.env.BROWSER_AI_BRIDGE_APP_WATCH_RETRY_MS || 6000);

function hasConversationProof(target = {}) {
  const identity = target.concreteTargetIdentity || {};
  return !!identity.conversationAnchor || !!identity.conversationTitle;
}

function bindingScope(target = {}) {
  const identity = target.concreteTargetIdentity || {};
  const proof = String(identity.conversationAnchor || identity.conversationTitle || '');
  return createHash('sha256')
    .update('eveos-app-origin-binding-scope-v1\0')
    .update(String(target.providerId || '')).update('\0')
    .update(String(target.id || '')).update('\0')
    .update(String(identity.processId || '')).update('\0')
    .update(String(identity.windowHandle || '')).update('\0')
    .update(proof).digest('hex');
}

function deliveryFingerprint(target, nativeFingerprint) {
  return createHash('sha256')
    .update('eveos-app-origin-delivery-v1\0')
    .update(bindingScope(target)).update('\0')
    .update(String(nativeFingerprint || '')).digest('hex');
}

function liveTargetFromSnapshot(bound, identity = {}) {
  const prior = bound.concreteTargetIdentity || {};
  return {
    ...bound,
    concreteTargetIdentity: {
      kind: prior.kind || 'windows-app-window',
      ...(prior.app ? { app: prior.app } : {}),
      ...(prior.processId ? { processId: prior.processId } : {}),
      ...(prior.windowHandle ? { windowHandle: prior.windowHandle } : {}),
      ...(identity.conversationTitle ? { conversationTitle: identity.conversationTitle } : {}),
      ...(identity.conversationAnchor ? { conversationAnchor: identity.conversationAnchor } : {}),
      ...(identity.conversationAnchors?.length ? { conversationAnchors: identity.conversationAnchors } : {})
    }
  };
}

function defaultTimer(fn, ms) {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
}

function createPassiveAppWatcher({
  appTargets,
  ledger = createPassiveTurnLedger(),
  emit = () => 0,
  onRebind = () => {},
  hasSubscribers = () => false,
  setTimer = defaultTimer,
  clearTimer = clearTimeout,
  intervalMs = WATCH_MS,
  idleMs = IDLE_MS,
  retryMs = RETRY_MS,
  now = () => Date.now()
} = {}) {
  const bindings = new Map();
  let stopped = false;

  function observedActive({ target, turn, source } = {}) {
    if (!turn?.fingerprint || !target?.id) return null;
    const state = bindings.get(target.id);
    if (!state) return null;
    const fingerprint = deliveryFingerprint(state.target, turn.fingerprint);
    state.lastSent.delete(fingerprint);
    return ledger.seed(fingerprint, {
      targetId: target.id, providerId: target.providerId, source: source || 'active'
    });
  }
  const unsubscribe = typeof appTargets?.onAppTurnFinal === 'function'
    ? appTargets.onAppTurnFinal(observedActive) : () => {};

  function schedule(state, delay = intervalMs) {
    if (stopped || !bindings.has(state.target.id)) return;
    if (state.timer) clearTimer(state.timer);
    state.timer = setTimer(() => {
      state.timer = null;
      scanNow(state.target.id).catch(() => {});
    }, Math.max(0, delay));
  }

  function watch(target) {
    if (stopped || !target?.id || !hasConversationProof(target)
        || typeof appTargets?.adapterForTarget !== 'function') return false;
    const current = bindings.get(target.id);
    if (current && appTargets.exactAppTargetMatch?.(current.target, target)) {
      schedule(current, 0);
      return true;
    }
    if (current?.timer) clearTimer(current.timer);
    const state = {
      target: { ...target, concreteTargetIdentity: { ...(target.concreteTargetIdentity || {}) } },
      primed: false,
      timer: null,
      running: false,
      lastSent: new Map(),
      scans: 0,
      emitted: 0,
      lastScanAt: 0,
      lastError: null
    };
    bindings.set(target.id, state);
    schedule(state, 0);
    return true;
  }

  function unwatch(targetId) {
    const state = bindings.get(String(targetId || ''));
    if (!state) return false;
    if (state.timer) clearTimer(state.timer);
    bindings.delete(state.target.id);
    return true;
  }

  async function emitTurn(state, turn) {
    const fingerprint = deliveryFingerprint(state.target, turn.fingerprint);
    let entry = ledger.entry(fingerprint);
    if (entry?.state === 'delivered') return false;
    if (!entry) entry = await ledger.discover(fingerprint, {
      targetId: state.target.id, providerId: state.target.providerId, source: 'passive'
    });
    if (entry?.state === 'delivered') return false;
    const lastSent = Number(state.lastSent.get(fingerprint) || 0);
    if (lastSent && now() - lastSent < retryMs) return false;
    const sent = Number(emit({
      type: 'native_app_turn',
      fingerprint,
      text: turn.text,
      observedAt: now(),
      targetClassId: 'app-origin',
      targetId: state.target.id,
      providerId: state.target.providerId,
      providerName: state.target.providerName,
      source: 'passive'
    }) || 0);
    if (sent > 0) {
      state.lastSent.set(fingerprint, now());
      state.emitted += 1;
      return true;
    }
    return false;
  }

  async function scanNow(targetId) {
    const state = bindings.get(String(targetId || ''));
    if (!state || stopped || state.running) return { ok: false, skipped: true };
    state.running = true;
    let nextDelay = intervalMs;
    try {
      if (!hasSubscribers(state.target.id)) {
        nextDelay = idleMs;
        return { ok: true, idle: true };
      }
      if (appTargets.appTargetBusy?.(state.target.id)) return { ok: true, busy: true };
      const adapter = appTargets.adapterForTarget(state.target.id);
      if (!adapter?.captureLatest || !adapter?.completedTurns || !adapter?.conversationIdentity) {
        state.lastError = 'APP_PASSIVE_WATCH_UNSUPPORTED';
        nextDelay = idleMs;
        return { ok: false, code: state.lastError };
      }

      const capture = await adapter.captureLatest({ target: state.target });
      state.scans += 1;
      state.lastScanAt = now();
      if (capture?.isGenerating || capture?.snapshot?.generating) return { ok: true, generating: true };

      const identity = adapter.conversationIdentity(capture.snapshot);
      if (!identity?.conversationAnchor && !identity?.conversationTitle) {
        state.lastError = 'APP_CONVERSATION_IDENTITY_UNAVAILABLE';
        nextDelay = idleMs;
        return { ok: false, code: state.lastError };
      }
      const liveTarget = liveTargetFromSnapshot(state.target, identity);
      if (!appTargets.exactAppTargetMatch?.(state.target, liveTarget)) {
        const payload = {
          type: 'app_target_rebind_required',
          code: 'APP_TARGET_REBIND_REQUIRED',
          targetClassId: 'app-origin',
          targetId: state.target.id,
          providerId: state.target.providerId,
          providerName: state.target.providerName,
          message: 'The native ChatGPT conversation changed; explicit rebind is required.'
        };
        state.lastError = payload.code;
        unwatch(state.target.id);
        onRebind(payload);
        return { ok: false, code: payload.code };
      }

      const turns = adapter.completedTurns(capture.snapshot, { limit: 64 });
      if (!state.primed) {
        let lastKnown = -1;
        for (let index = 0; index < turns.length; index += 1) {
          if (ledger.entry(deliveryFingerprint(state.target, turns[index].fingerprint))) lastKnown = index;
        }
        if (lastKnown < 0) {
          for (const turn of turns) {
            await ledger.seed(deliveryFingerprint(state.target, turn.fingerprint), {
              targetId: state.target.id, providerId: state.target.providerId, source: 'baseline'
            });
          }
          state.primed = true;
          state.lastError = null;
          return { ok: true, primed: true, baseline: turns.length };
        }
        for (let index = 0; index <= lastKnown; index += 1) {
          const turn = turns[index];
          const fingerprint = deliveryFingerprint(state.target, turn.fingerprint);
          if (!ledger.entry(fingerprint)) {
            await ledger.seed(fingerprint, {
              targetId: state.target.id, providerId: state.target.providerId, source: 'baseline-gap'
            });
          }
        }
        state.primed = true;
      }

      for (const turn of turns) await emitTurn(state, turn);
      state.lastError = null;
      return { ok: true, turns: turns.length };
    } catch (error) {
      state.lastError = error?.code || error?.message || 'APP_PASSIVE_WATCH_FAILED';
      nextDelay = idleMs;
      if (['APP_TARGET_NOT_FOUND', 'APP_TARGET_REBIND_REQUIRED'].includes(error?.code)) {
        const payload = {
          type: 'app_target_rebind_required',
          code: 'APP_TARGET_REBIND_REQUIRED',
          targetClassId: 'app-origin',
          targetId: state.target.id,
          providerId: state.target.providerId,
          providerName: state.target.providerName,
          message: 'The bound ChatGPT app process/window changed; explicit rebind is required.'
        };
        unwatch(state.target.id);
        onRebind(payload);
      }
      return { ok: false, code: state.lastError };
    } finally {
      state.running = false;
      if (bindings.get(state.target.id) === state) schedule(state, nextDelay);
    }
  }

  function ack({ targetId, fingerprint } = {}) {
    const entry = ledger.entry(fingerprint);
    if (!entry || (entry.targetId && String(entry.targetId) !== String(targetId || ''))) return Promise.resolve(false);
    const state = bindings.get(String(targetId || ''));
    state?.lastSent.delete(fingerprint);
    return ledger.ack(fingerprint, { targetId, providerId: entry.providerId, source: 'ui-ack' }).then(() => true);
  }

  function diagnostics() {
    return {
      watchMs: intervalMs,
      bindings: [...bindings.values()].map((state) => ({
        targetId: state.target.id, primed: state.primed, scans: state.scans,
        emitted: state.emitted, lastScanAt: state.lastScanAt, lastError: state.lastError
      })),
      ledger: ledger.stats()
    };
  }

  function stop() {
    stopped = true;
    unsubscribe();
    for (const state of bindings.values()) if (state.timer) clearTimer(state.timer);
    bindings.clear();
  }

  return { watch, unwatch, scanNow, ack, diagnostics, stop };
}

module.exports = {
  WATCH_MS, IDLE_MS, RETRY_MS, hasConversationProof, bindingScope,
  deliveryFingerprint, liveTargetFromSnapshot, createPassiveAppWatcher
};
