'use strict';

const { createHash } = require('node:crypto');
const { createPassiveTurnLedger } = require('./passive-turn-ledger');

const WATCH_MS = Number(process.env.NEXUS_BROWSER_APP_WATCH_MS
  || process.env.BROWSER_AI_BRIDGE_APP_WATCH_MS || 2000);
const IDLE_MS = Number(process.env.NEXUS_BROWSER_APP_WATCH_IDLE_MS
  || process.env.BROWSER_AI_BRIDGE_APP_WATCH_IDLE_MS || 6000);
const RETRY_MS = Number(process.env.NEXUS_BROWSER_APP_WATCH_RETRY_MS
  || process.env.BROWSER_AI_BRIDGE_APP_WATCH_RETRY_MS || 6000);
const SETTLE_MS = Number(process.env.NEXUS_BROWSER_APP_PASSIVE_SETTLE_MS
  || process.env.BROWSER_AI_BRIDGE_APP_PASSIVE_SETTLE_MS || 900);
const SETTLE_RECHECK_MS = Number(process.env.NEXUS_BROWSER_APP_PASSIVE_RECHECK_MS
  || process.env.BROWSER_AI_BRIDGE_APP_PASSIVE_RECHECK_MS || 350);

function hasConversationProof(target = {}) {
  const identity = target.concreteTargetIdentity || {};
  return !!identity.conversationAnchor || !!identity.conversationTitle;
}

function bindingScope(target = {}) {
  const identity = target.concreteTargetIdentity || {};
  if (/^[a-f0-9]{64}$/i.test(String(identity.deliveryScope || ''))) {
    return String(identity.deliveryScope).toLowerCase();
  }
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
      ...(prior.deliveryScope ? { deliveryScope: prior.deliveryScope } : {}),
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
  onIdentity = () => {},
  hasSubscribers = () => false,
  setTimer = defaultTimer,
  clearTimer = clearTimeout,
  intervalMs = WATCH_MS,
  idleMs = IDLE_MS,
  retryMs = RETRY_MS,
  settleMs = SETTLE_MS,
  settleRecheckMs = SETTLE_RECHECK_MS,
  now = () => Date.now()
} = {}) {
  const bindings = new Map();
  let stopped = false;

  function rememberTurn(state, fingerprint) {
    const value = String(fingerprint || '');
    if (!value) return;
    state.continuityTurns.delete(value);
    state.continuityTurns.add(value);
    while (state.continuityTurns.size > 64) state.continuityTurns.delete(state.continuityTurns.values().next().value);
  }

  async function observedActive({ target, turn, source } = {}) {
    if (!turn?.fingerprint || !target?.id) return null;
    const state = bindings.get(target.id);
    if (!state) return null;
    rememberTurn(state, turn.fingerprint);
    const fingerprint = deliveryFingerprint(state.target, turn.fingerprint);
    state.lastSent.delete(fingerprint);
    await ledger.seed(fingerprint, {
      targetId: target.id, providerId: target.providerId, source: source || 'active',
      scope: state.scope, nativeFingerprint: turn.fingerprint
    });
    await ledger.setCursor(state.scope, turn.fingerprint, {
      targetId: target.id, providerId: target.providerId, source: source || 'active'
    });
    return fingerprint;
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
      continuityIdentity: { ...(target.concreteTargetIdentity || {}) },
      scope: bindingScope(target),
      primed: false,
      visibleTurnOrder: new Map(),
      continuityTurns: new Set(),
      timer: null,
      running: false,
      lastSent: new Map(),
      settleSignature: '',
      settleSince: 0,
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
      targetId: state.target.id, providerId: state.target.providerId, source: 'passive',
      scope: state.scope, nativeFingerprint: turn.fingerprint
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
      const observedTurns = adapter.completedTurns(capture.snapshot, { limit: 64 });
      const turns = observedTurns.filter((turn) => turn.completeHint !== false);
      if (!identity?.conversationAnchor && !identity?.conversationTitle) {
        state.lastError = 'APP_CONVERSATION_IDENTITY_UNAVAILABLE';
        nextDelay = idleMs;
        return { ok: false, code: state.lastError };
      }
      const expectedTarget = liveTargetFromSnapshot(state.target, state.continuityIdentity);
      const liveTarget = liveTargetFromSnapshot(state.target, identity);
      let advanced = typeof appTargets.advanceAppTargetBinding === 'function'
        ? appTargets.advanceAppTargetBinding(expectedTarget, liveTarget)
        : appTargets.exactAppTargetMatch?.(expectedTarget, liveTarget) ? liveTarget : null;
      const turnContinuity = observedTurns.some((turn) => state.continuityTurns.has(String(turn.fingerprint || '')));
      if (!advanced && turnContinuity) {
        const prior = state.continuityIdentity || {}, live = liveTarget.concreteTargetIdentity || {};
        advanced = { ...liveTarget, concreteTargetIdentity: {
          ...prior, ...live,
          ...(prior.deliveryScope ? { deliveryScope: prior.deliveryScope } : {}),
          conversationAnchors: [...new Set([
            ...(Array.isArray(prior.conversationAnchors) ? prior.conversationAnchors : []),
            ...(Array.isArray(live.conversationAnchors) ? live.conversationAnchors : [])
          ])].slice(-16)
        } };
      }
      if (!advanced) {
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
      const nextIdentity = { ...(advanced.concreteTargetIdentity || identity) };
      const identityChanged = JSON.stringify(nextIdentity) !== JSON.stringify(state.continuityIdentity);
      state.continuityIdentity = nextIdentity;
      if (identityChanged) {
        onIdentity({
          targetId: state.target.id,
          providerId: state.target.providerId,
          bindingIdentity: { ...state.continuityIdentity }
        });
      }

      for (const turn of turns) rememberTurn(state, turn.fingerprint);
      state.visibleTurnOrder = new Map(turns.map((turn, index) => [turn.fingerprint, index]));
      if (!state.primed) {
        const cursor = ledger.cursor(state.scope);
        const cursorIndex = cursor
          ? turns.findIndex((turn) => turn.fingerprint === cursor.nativeFingerprint)
          : -1;
        if (!cursor || cursorIndex < 0) {
          for (const turn of turns) {
            await ledger.seed(deliveryFingerprint(state.target, turn.fingerprint), {
              targetId: state.target.id, providerId: state.target.providerId,
              source: cursor ? 'baseline-resync' : 'baseline',
              scope: state.scope, nativeFingerprint: turn.fingerprint
            });
          }
          if (turns.length) {
            await ledger.setCursor(state.scope, turns.at(-1).fingerprint, {
              targetId: state.target.id, providerId: state.target.providerId,
              source: cursor ? 'baseline-resync' : 'baseline'
            });
          }
          state.primed = true;
          state.lastError = null;
          return { ok: true, primed: true, baseline: turns.length, resynced: !!cursor };
        }
        for (let index = 0; index <= cursorIndex; index += 1) {
          const turn = turns[index];
          const fingerprint = deliveryFingerprint(state.target, turn.fingerprint);
          if (!ledger.entry(fingerprint)) {
            await ledger.seed(fingerprint, {
              targetId: state.target.id, providerId: state.target.providerId, source: 'baseline-gap',
              scope: state.scope, nativeFingerprint: turn.fingerprint
            });
          }
        }
        state.primed = true;
      }

      const cursor = ledger.cursor(state.scope);
      const cursorIndex = cursor
        ? turns.findIndex((turn) => turn.fingerprint === cursor.nativeFingerprint)
        : -1;
      if (!cursor || cursorIndex < 0) {
        for (const turn of turns) {
          await ledger.seed(deliveryFingerprint(state.target, turn.fingerprint), {
            targetId: state.target.id, providerId: state.target.providerId,
            source: cursor ? 'steady-resync' : 'steady-baseline',
            scope: state.scope, nativeFingerprint: turn.fingerprint
          });
        }
        if (turns.length) {
          await ledger.setCursor(state.scope, turns.at(-1).fingerprint, {
            targetId: state.target.id, providerId: state.target.providerId,
            source: cursor ? 'steady-resync' : 'steady-baseline'
          });
        }
        state.lastError = null;
        return { ok: true, turns: turns.length, resynced: true };
      }

      const pendingTurns = turns.slice(cursorIndex + 1);
      if (!pendingTurns.length) {
        state.settleSignature = '';
        state.settleSince = 0;
        state.lastError = null;
        return { ok: true, turns: turns.length, cursorIndex };
      }

      if (settleMs > 0) {
        const signature = pendingTurns.map((turn) => turn.fingerprint).join(':');
        const observedAt = now();
        if (signature !== state.settleSignature) {
          state.settleSignature = signature;
          state.settleSince = observedAt;
          nextDelay = Math.min(nextDelay, settleRecheckMs);
          return { ok: true, turns: turns.length, cursorIndex, settling: true };
        }
        if (observedAt - state.settleSince < settleMs) {
          nextDelay = Math.min(nextDelay, settleRecheckMs);
          return { ok: true, turns: turns.length, cursorIndex, settling: true };
        }
      }

      for (const turn of pendingTurns) await emitTurn(state, turn);
      state.settleSignature = '';
      state.settleSince = 0;
      state.lastError = null;
      return { ok: true, turns: turns.length, cursorIndex, settled: true };
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

  async function ack({ targetId, fingerprint } = {}) {
    const entry = ledger.entry(fingerprint);
    if (!entry || (entry.targetId && String(entry.targetId) !== String(targetId || ''))) return false;
    const state = bindings.get(String(targetId || ''));
    state?.lastSent.delete(fingerprint);
    await ledger.ack(fingerprint, {
      targetId, providerId: entry.providerId, source: 'ui-ack',
      scope: entry.scope, nativeFingerprint: entry.nativeFingerprint
    });
    if (state && entry.nativeFingerprint) {
      const current = ledger.cursor(state.scope)?.nativeFingerprint;
      const currentIndex = state.visibleTurnOrder.get(current);
      const nextIndex = state.visibleTurnOrder.get(entry.nativeFingerprint);
      if (nextIndex != null && (currentIndex == null || nextIndex >= currentIndex)) {
        await ledger.setCursor(state.scope, entry.nativeFingerprint, {
          targetId, providerId: entry.providerId, source: 'ui-ack'
        });
      }
    }
    return true;
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
  WATCH_MS, IDLE_MS, RETRY_MS, SETTLE_MS, SETTLE_RECHECK_MS, hasConversationProof, bindingScope,
  deliveryFingerprint, liveTargetFromSnapshot, createPassiveAppWatcher
};
