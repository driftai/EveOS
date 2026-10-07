'use strict';

function createExtensionSessionArbiter({
  isOpen = () => true,
  now = () => Date.now(),
  maxTransitions = 24,
  emptyGraceMs = 2500,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onAuthoritySettled = () => {}
} = {}) {
  const sessions = new Map();
  const recentTransitions = [];
  let primary = null;
  let nextSessionId = 1;
  let connectionEpoch = 0;
  let lastPublished = null;
  let pendingEmpty = null;
  let settledEmptySocket = null;

  const sessionId = (socket) => sessions.get(socket)?.sessionId || null;
  function record(type, detail = {}) {
    recentTransitions.push({ at: now(), type, ...detail });
    while (recentTransitions.length > maxTransitions) recentTransitions.shift();
  }
  function cancelPending() {
    if (pendingEmpty?.timer != null) clearTimer(pendingEmpty.timer);
    pendingEmpty = null;
  }
  function setPrimary(socket, reason) {
    if (socket === primary) return false;
    const previousSessionId = sessionId(primary);
    primary = socket || null;
    cancelPending();
    settledEmptySocket = null;
    record('primary-changed', { reason, previousSessionId, nextSessionId: sessionId(primary) });
    return true;
  }
  function liveEntries(exclude = null) {
    return [...sessions.entries()].filter(([socket]) => socket !== exclude && isOpen(socket));
  }
  function providerIds(state) {
    return new Set(
      (state?.providers || [])
        .map((provider) => String(provider?.id || '').trim())
        .filter(Boolean)
    );
  }
  function providerCount(state) {
    return providerIds(state).size;
  }
  function hasStrictProviderSuperset(candidate, incumbent) {
    const candidateIds = providerIds(candidate);
    const incumbentIds = providerIds(incumbent);
    if (candidateIds.size <= incumbentIds.size) return false;
    for (const id of incumbentIds) {
      if (!candidateIds.has(id)) return false;
    }
    return true;
  }
  function best(exclude = null, { requireTabs = false } = {}) {
    const candidates = liveEntries(exclude)
      .filter(([, state]) => state.hasSnapshot && (!requireTabs || state.tabs.length > 0))
      .sort((a, b) => (b[1].tabs.length - a[1].tabs.length)
        || (providerCount(b[1]) - providerCount(a[1]))
        || (b[1].updatedAt - a[1].updatedAt));
    if (candidates.length) return candidates[0][0];
    return requireTabs ? null : liveEntries(exclude)[0]?.[0] || null;
  }
  function ensurePrimary(reason = 'primary-unavailable') {
    if (primary && isOpen(primary) && sessions.has(primary)) return primary;
    setPrimary(best(), reason);
    return primary;
  }
  function startEmptyGrace(socket) {
    if (pendingEmpty?.socket === socket) return;
    cancelPending();
    const entry = { socket, startedAt: now(), timer: null };
    pendingEmpty = entry;
    record('empty-grace-started', { sessionId: sessionId(socket), graceMs: emptyGraceMs });
    entry.timer = setTimer(() => {
      if (pendingEmpty !== entry) return;
      // A timer may be delayed or replaced. Only an actually authoritative empty
      // primary can publish zero, and only after the bounded grace expires.
      if (now() - entry.startedAt < emptyGraceMs) {
        entry.timer = setTimer(() => { if (pendingEmpty === entry) settleEmpty(entry); }, emptyGraceMs - (now() - entry.startedAt));
        entry.timer?.unref?.();
        return;
      }
      settleEmpty(entry);
    }, emptyGraceMs);
    entry.timer?.unref?.();
  }
  function settleEmpty(entry) {
    if (pendingEmpty !== entry || primary !== entry.socket || now() - entry.startedAt < emptyGraceMs) return;
    const state = sessions.get(primary);
    if (!state?.hasSnapshot || state.tabs.length || !isOpen(primary)) return;
    if (best(primary, { requireTabs: true })) {
      setPrimary(best(primary, { requireTabs: true }), 'richer-populated-during-grace');
      return;
    }
    settledEmptySocket = primary;
    cancelPending();
    lastPublished = { tabs: [], providers: state.providers, target: null };
    record('empty-authority-settled', { sessionId: state.sessionId });
    onAuthoritySettled(current());
  }
  function snapshotOf(state) {
    return { tabs: state.tabs, providers: state.providers, target: state.tabs.length ? state.target : null };
  }
  function current() {
    ensurePrimary();
    let state = primary ? sessions.get(primary) : null;
    if (state?.hasSnapshot && state.tabs.length === 0) {
      const richer = best(primary, { requireTabs: true });
      if (richer) {
        setPrimary(richer, 'primary-empty-richer-standby');
        state = sessions.get(primary);
      }
    }
    let ready = false;
    if (state?.hasSnapshot && state.tabs.length) {
      cancelPending();
      settledEmptySocket = null;
      lastPublished = snapshotOf(state);
      ready = true;
    } else if (state?.hasSnapshot && state.tabs.length === 0) {
      if (settledEmptySocket === primary) {
        lastPublished = { tabs: [], providers: state.providers, target: null };
        ready = true;
      } else {
        startEmptyGrace(primary);
      }
    } else if (!primary) {
      cancelPending();
      lastPublished = null;
    }
    return {
      socket: primary,
      snapshot: ready ? snapshotOf(state) : lastPublished,
      ready,
      pendingEmpty: !!pendingEmpty,
      sessionCount: liveEntries().length,
      primarySessionId: state?.sessionId || null,
      primaryConnectionEpoch: state?.connectionEpoch || null
    };
  }
  function register(socket) {
    if (!sessions.has(socket)) {
      const state = {
        sessionId: `extension-${nextSessionId++}`, connectionEpoch: ++connectionEpoch,
        hasSnapshot: false, tabs: [], providers: [], target: null,
        connectedAt: now(), updatedAt: 0, snapshotCount: 0
      };
      sessions.set(socket, state);
      record('connected', { sessionId: state.sessionId, connectionEpoch: state.connectionEpoch });
    }
    if (!ensurePrimary('first-live-session')) setPrimary(socket, 'first-live-session');
    return current();
  }
  function update(socket, snapshot = {}) {
    register(socket);
    const state = sessions.get(socket);
    const tabsBefore = state.tabs.length;
    const providersBefore = state.providers.map((provider) => provider.id).filter(Boolean).sort();
    state.hasSnapshot = true;
    state.tabs = Array.isArray(snapshot.tabs) ? snapshot.tabs : [];
    state.providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
    state.target = snapshot.target || null;
    state.updatedAt = now();
    state.snapshotCount += 1;
    const providersAfter = state.providers.map((provider) => provider.id).filter(Boolean).sort();
    if (tabsBefore !== state.tabs.length || providersBefore.join('|') !== providersAfter.join('|')) {
      record('snapshot-changed', {
        sessionId: state.sessionId, connectionEpoch: state.connectionEpoch,
        tabsBefore, tabsAfter: state.tabs.length, providersBefore, providersAfter
      });
    }
    ensurePrimary();
    const primaryState = sessions.get(primary);
    const hasMoreTabs = !!primaryState?.hasSnapshot && state.tabs.length > primaryState.tabs.length;
    const hasSameTabsAndRicherProviders = !!primaryState?.hasSnapshot
      && state.tabs.length === primaryState.tabs.length
      && hasStrictProviderSuperset(state, primaryState);
    if (socket === primary && !state.tabs.length) {
      const replacement = best(socket, { requireTabs: true });
      if (replacement) setPrimary(replacement, 'primary-empty-richer-standby');
    } else if (socket !== primary && state.tabs.length
        && (!primaryState?.hasSnapshot || hasMoreTabs || hasSameTabsAndRicherProviders)) {
      const reason = !primaryState?.hasSnapshot
        ? 'first-ready-session'
        : hasMoreTabs
          ? 'richer-populated-session'
          : 'richer-provider-session';
      setPrimary(socket, reason);
    }
    return current();
  }
  function drop(socket, { closeCode = null, closeReason = '' } = {}) {
    const wasPrimary = socket === primary;
    const state = sessions.get(socket);
    record('disconnected', {
      sessionId: state?.sessionId || null, connectionEpoch: state?.connectionEpoch || null,
      closeCode, closeReason: String(closeReason || ''), wasPrimary
    });
    sessions.delete(socket);
    if (pendingEmpty?.socket === socket) cancelPending();
    if (wasPrimary) setPrimary(null, 'primary-disconnected');
    ensurePrimary('promote-after-disconnect');
    return { ...current(), wasPrimary };
  }
  function isPrimary(socket) {
    ensurePrimary();
    return socket === primary;
  }
  function diagnostics() {
    const authority = current();
    const state = primary ? sessions.get(primary) : null;
    return {
      connected: liveEntries().length,
      primaryReady: authority.ready,
      pendingEmpty: authority.pendingEmpty,
      primaryTabs: state?.hasSnapshot ? state.tabs.length : null,
      primaryProviders: state?.hasSnapshot ? providerCount(state) : null,
      primarySessionId: state?.sessionId || null,
      primaryConnectionEpoch: state?.connectionEpoch || null,
      standby: liveEntries(primary).map(([, item]) => ({
        sessionId: item.sessionId, connectionEpoch: item.connectionEpoch,
        ready: item.hasSnapshot,
        tabs: item.hasSnapshot ? item.tabs.length : null,
        providers: item.hasSnapshot ? providerCount(item) : null
      })),
      recentTransitions: recentTransitions.map((entry) => ({ ...entry }))
    };
  }
  return { register, update, drop, current, isPrimary, diagnostics };
}

module.exports = { createExtensionSessionArbiter };
