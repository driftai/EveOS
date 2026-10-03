'use strict';

const { createPassiveAppWatcher } = require('./passive-watcher');
const appTargetBinding = require('./app-target-binding');
const defaultTerminalRelayStorage = require('../scripts/terminal-relay-storage');

function createAppTargetServerController({
  appTargets,
  safeSend,
  uiSockets,
  getDurability,
  maintenanceBusy = () => false,
  passiveWatcherFactory = createPassiveAppWatcher,
  terminalRelayStorage = defaultTerminalRelayStorage
} = {}) {
  let lastTargets = [];
  let passiveWatcher = null;
  const missedTerminalEvents = new Map(), missedTtlMs = 5 * 60 * 1000, missedLimit = 64;

  function rememberMissed(targetId, payload) {
    if (!payload?.requestId || !['response_final', 'error'].includes(payload.type)) return;
    const now = Date.now();
    for (const [key, entry] of missedTerminalEvents) if (now - entry.at > missedTtlMs) missedTerminalEvents.delete(key);
    missedTerminalEvents.set(`${String(targetId)}\0${String(payload.requestId)}`, { targetId: String(targetId), payload: { ...payload }, at: now });
    while (missedTerminalEvents.size > missedLimit) missedTerminalEvents.delete(missedTerminalEvents.keys().next().value);
  }

  function replayMissed(ws, targetId) {
    const now = Date.now(), wanted = String(targetId);
    for (const [key, entry] of missedTerminalEvents) {
      if (now - entry.at > missedTtlMs) { missedTerminalEvents.delete(key); continue; }
      if (entry.targetId !== wanted) continue;
      if (safeSend(ws, { ...entry.payload, recoveredAfterReconnect: true })) missedTerminalEvents.delete(key);
    }
  }

  function selected(ws) {
    if (!ws?.appTargetId) return null;
    return lastTargets.find((target) => target.id === ws.appTargetId) || null;
  }

  function exactMatch(expected, actual) {
    if (typeof appTargets.exactAppTargetMatch !== 'function') return true;
    return appTargets.exactAppTargetMatch(expected, actual);
  }

  function passivePeers(targetId) {
    return [...uiSockets].filter((peer) =>
      peer.clientKind === 'browser' && peer.appTargetId === targetId);
  }

  function applyBinding(ws, binding, { restored = false } = {}) {
    ws.appTargetId = binding.id;
    ws.appTargetBinding = binding;
    passiveWatcher.watch(binding);
    safeSend(ws, {
      type: 'app_target_selected',
      target: binding,
      bindingIdentity: { ...(binding.concreteTargetIdentity || {}) },
      status: appTargets.getAppTargetStatus(binding.id),
      diagnostics: appTargets.discoveryDiagnostics(),
      restored
    });
    replayMissed(ws, binding.id);
    return binding;
  }

  function restorePersistedSelection(ws) {
    if (!ws || ws.clientKind !== 'browser' || ws.appTargetId) return null;
    try {
      const restored = appTargetBinding.restorePersistedBinding({
        selection: terminalRelayStorage.readTargetSelection?.(),
        liveTargets: lastTargets,
        appTargetsApi: appTargets,
        storage: terminalRelayStorage,
        allowSingleTargetFallback: false
      });
      if (!restored?.binding) return null;
      return applyBinding(ws, restored.binding, { restored: true });
    } catch {
      return null;
    }
  }

  function persistedAdvancedBinding(target) {
    if (!target || typeof appTargets.advanceAppTargetBinding !== 'function') return null;
    const persisted = terminalRelayStorage.readTargetSelection?.()?.target || null;
    if (!persisted || String(persisted.id || '') !== String(target.id || '')
        || String(persisted.providerId || '') !== String(target.providerId || '')) return null;
    try {
      return appTargets.advanceAppTargetBinding(persisted, target) || null;
    } catch {
      return null;
    }
  }

  function requireRebind(targetId, payload = {}) {
    const event = {
      type: 'app_target_rebind_required',
      code: 'APP_TARGET_REBIND_REQUIRED',
      targetClassId: 'app-origin',
      targetId,
      message: 'The native app identity changed; refresh and reconnect it explicitly.',
      ...payload
    };
    terminalRelayStorage.clearTargetSelection(targetId);
    for (const peer of passivePeers(targetId)) {
      peer.appTargetId = null;
      peer.appTargetBinding = null;
      safeSend(peer, event);
    }
    passiveWatcher?.unwatch(targetId);
    return event;
  }

  passiveWatcher = passiveWatcherFactory({
    appTargets,
    hasSubscribers: (targetId) => passivePeers(targetId).length > 0,
    emit(payload) {
      if (payload?.type === 'native_app_turn') {
        // Passive UIA observation proves app activity, not Nexus provenance. Consume it
        // locally so app-authored turns advance continuity without entering Nexus chat.
        Promise.resolve(passiveWatcher?.ack?.({
          targetId: payload.targetId,
          fingerprint: payload.fingerprint
        })).catch(() => {});
        return 1;
      }
      let sent = 0;
      for (const peer of passivePeers(payload.targetId)) if (safeSend(peer, payload)) sent += 1;
      return sent;
    },
    onRebind: (payload) => requireRebind(payload.targetId, payload),
    onIdentity({ targetId, bindingIdentity }) {
      for (const peer of passivePeers(targetId)) {
        if (!peer.appTargetBinding) continue;
        peer.appTargetBinding = {
          ...peer.appTargetBinding,
          concreteTargetIdentity: { ...bindingIdentity }
        };
        safeSend(peer, {
          type: 'app_target_binding_update',
          targetClassId: 'app-origin',
          targetId,
          bindingIdentity: { ...bindingIdentity }
        });
        terminalRelayStorage.refreshTargetSelection?.(peer.appTargetBinding);
      }
    }
  });

  function statusPayload(ws, targetId) {
    return {
      type: 'app_target_status',
      targetId,
      status: appTargets.getAppTargetStatus(targetId),
      diagnostics: appTargets.discoveryDiagnostics(),
      bindingIdentity: ws?.appTargetBinding?.concreteTargetIdentity || null
    };
  }

  function sendStatus(ws, targetId = ws?.appTargetId) {
    if (!targetId) return false;
    return safeSend(ws, statusPayload(ws, targetId));
  }

  function sendEvent(targetId, source, payload) {
    const sourceDelivered = safeSend(source, payload);
    for (const peer of uiSockets) {
      if (peer === source || peer.clientKind === 'dex' || peer.appTargetId !== targetId) continue;
      safeSend(peer, payload);
    }
    if (!sourceDelivered) rememberMissed(targetId, payload);
  }

  function announce(destination = null, { validateSelection = false, refreshing = false } = {}) {
    const destinations = destination ? [destination] : [...uiSockets];
    const diagnostics = appTargets.discoveryDiagnostics();
    const types = appTargets.publicAppTargetTypes();
    for (const ws of destinations) {
      if (validateSelection && !ws.appTargetId) restorePersistedSelection(ws);
      if (validateSelection && ws.appTargetId) {
        const target = lastTargets.find((entry) => entry.id === ws.appTargetId) || null;
        if (!target) {
          const targetId = ws.appTargetId;
          requireRebind(targetId, {
            providerId: ws.appTargetBinding?.providerId || null,
            providerName: ws.appTargetBinding?.providerName || null
          });
        } else if (ws.appTargetBinding) {
          const persistedAdvanced = persistedAdvancedBinding(target);
          const advanced = persistedAdvanced || (typeof appTargets.advanceAppTargetBinding === 'function'
            ? appTargets.advanceAppTargetBinding(ws.appTargetBinding, target)
            : exactMatch(ws.appTargetBinding, target) ? ws.appTargetBinding : null);
          if (!advanced) {
            const targetId = ws.appTargetId;
            requireRebind(targetId, {
              providerId: ws.appTargetBinding?.providerId || target?.providerId || null,
              providerName: ws.appTargetBinding?.providerName || target?.providerName || null
            });
          } else {
            const changedByPersisted = !!persistedAdvanced
              && JSON.stringify(ws.appTargetBinding.concreteTargetIdentity || {})
                !== JSON.stringify(persistedAdvanced.concreteTargetIdentity || {});
            ws.appTargetBinding = advanced;
            terminalRelayStorage.refreshTargetSelection?.(ws.appTargetBinding);
            if (changedByPersisted) {
              safeSend(ws, {
                type: 'app_target_selected',
                target: ws.appTargetBinding,
                bindingIdentity: { ...(ws.appTargetBinding.concreteTargetIdentity || {}) },
                status: appTargets.getAppTargetStatus(ws.appTargetBinding.id),
                diagnostics,
                restored: true,
                source: 'terminal-relay-auto-bind'
              });
            }
          }
        }
      }
      safeSend(ws, {
        type: 'app_targets_update',
        types,
        targets: lastTargets,
        target: selected(ws),
        diagnostics,
        refreshing
      });
      if (ws.appTargetId) sendStatus(ws);
    }
    return lastTargets;
  }

  async function refresh(destination = null, { force = false } = {}) {
    lastTargets = await appTargets.listAppTargets({ force });
    announce(destination, { validateSelection: true, refreshing: false });
    return lastTargets;
  }

  async function handle(ws, msg) {
    const appCommand = msg.type === 'request_app_targets'
      || msg.type === 'select_app_target'
      || msg.type === 'request_app_status'
      || msg.type === 'ack_native_app_turn'
      || (msg.targetClassId === 'app-origin'
        && (msg.type === 'send_prompt' || msg.type === 'capture_latest'));
    if (!appCommand) return false;

    if (ws?.clientKind === 'dex' && !['request_app_targets', 'request_app_status'].includes(msg.type)) {
      safeSend(ws, {
        type: 'error',
        requestId: msg.requestId || null,
        code: 'DEX_SERVER_SCHEDULER_OWNS_TRANSPORT',
        message: 'Localhost scheduler owns Dex App-Origin dispatch; the Dex viewer may only discover/status app targets.'
      });
      return true;
    }

    if (msg.type === 'request_app_targets') {
      await refresh(ws, { force: !!msg.force });
      return true;
    }

    if (msg.type === 'request_app_status') {
      const targetId = String(msg.targetId || ws.appTargetId || '');
      if (!targetId || !sendStatus(ws, targetId)) {
        safeSend(ws, { type: 'error', requestId: msg.requestId || null,
          code: 'APP_TARGET_NOT_SELECTED', message: 'No App-Origin target is selected.' });
      }
      return true;
    }

    if (msg.type === 'ack_native_app_turn') {
      if (ws.clientKind === 'browser' && ws.appTargetId
          && String(ws.appTargetId) === String(msg.targetId || '')) {
        await passiveWatcher.ack({ targetId: ws.appTargetId, fingerprint: msg.fingerprint });
      }
      return true;
    }

    if (msg.type === 'select_app_target') {
      const target = await appTargets.getAppTarget(String(msg.targetId || ''), { force: true });
      if (!target) {
        safeSend(ws, { type: 'error', requestId: msg.requestId || null,
          code: 'APP_TARGET_NOT_FOUND', message: 'That App-Origin target is not available.' });
        return true;
      }
      if (msg.expectedIdentity) {
        const expected = { ...target, concreteTargetIdentity: { ...msg.expectedIdentity } };
        if (!exactMatch(expected, target)) {
          safeSend(ws, {
            type: 'app_target_rebind_required',
            code: 'APP_TARGET_REBIND_REQUIRED',
            targetClassId: 'app-origin',
            targetId: target.id,
            providerId: target.providerId,
            providerName: target.providerName,
            message: 'The native ChatGPT conversation changed while Nexus was reconnecting; reconnect it explicitly.'
          });
          return true;
        }
      }
      try {
        const binding = appTargetBinding.persistBinding(target, {
          expectedIdentity: msg.expectedIdentity || null,
          exactMatch,
          storage: terminalRelayStorage
        });
        applyBinding(ws, binding);
      } catch (error) {
        safeSend(ws, {
          type: 'app_target_rebind_required',
          code: error.code || 'APP_TARGET_REBIND_REQUIRED',
          targetClassId: 'app-origin',
          targetId: target.id,
          providerId: target.providerId,
          providerName: target.providerName,
          message: error.message
        });
      }
      return true;
    }

    const targetId = String(msg.targetId || ws.appTargetId || '');

    if (msg.type === 'capture_latest') {
      try {
        const result = await appTargets.captureAppLatest({ targetId });
        safeSend(ws, {
          type: 'capture_result',
          requestId: msg.requestId || null,
          text: result.text || '',
          targetClassId: 'app-origin',
          targetId,
          providerId: result.target?.providerId,
          providerName: result.target?.providerName
        });
      } catch (error) {
        if (error.code === 'APP_TARGET_REBIND_REQUIRED') requireRebind(targetId);
        safeSend(ws, {
          type: 'error',
          requestId: msg.requestId || null,
          code: error.code || 'APP_CAPTURE_FAILED',
          message: error.message,
          targetClassId: 'app-origin',
          targetId
        });
      }
      return true;
    }

    if (msg.type === 'send_prompt') {
      if (maintenanceBusy()) {
        safeSend(ws, { type: 'error', requestId: msg.requestId || null, code: 'POST_IDLE_LEASE_BUSY',
          message: 'Post-idle maintenance holds the exclusive dispatch lease.' });
        return true;
      }
      const target = await appTargets.getAppTarget(targetId, { force: true });
      if (!target) {
        safeSend(ws, { type: 'error', requestId: msg.requestId || null,
          code: 'APP_TARGET_NOT_FOUND', message: 'Selected App-Origin target is not available.' });
        return true;
      }

      const durability = getDurability();
      const meta = { targetClassId: 'app-origin', targetId, providerId: target.providerId };

      try {
        await appTargets.sendAppPrompt({
          targetId,
          requestId: msg.requestId,
          text: msg.text,
          beforeSend: async () => {
            const gate = await durability.beforeDispatch(msg, meta);
            if (gate.ok) return;
            const error = new Error('Durable turn ledger blocked a duplicate app dispatch.');
            error.code = 'DUPLICATE_DISPATCH_BLOCKED';
            throw error;
          },
          emit: (payload) => {
            durability.observe(payload, meta).catch(() => {});
            sendEvent(targetId, ws, payload);
          }
        });
        sendStatus(ws, targetId);
      } catch (error) {
        await durability.markFailed?.(msg.requestId, error.code || 'APP_TARGET_ERROR', {
          targetClassId: 'app-origin', targetId, providerId: target.providerId
        }).catch?.(() => {});
        sendEvent(targetId, ws, {
          type: 'error',
          requestId: msg.requestId || null,
          code: error.code || 'APP_TARGET_ERROR',
          message: error.message,
          detail: error.detail || null,
          targetClassId: 'app-origin',
          targetId
        });
        sendStatus(ws, targetId);
      }
      return true;
    }

    return false;
  }

  function diagnostics() {
    return {
      targets: lastTargets.length,
      discovery: appTargets.discoveryDiagnostics(),
      passive: passiveWatcher.diagnostics(),
      missedTerminalEvents: missedTerminalEvents.size
    };
  }

  function stop() {
    passiveWatcher.stop();
    appTargets.stopAppTargets();
    lastTargets = [];
  }

  return { handle, refresh, announce, selected, diagnostics, stop,
    targets: () => lastTargets.map((target) => ({ ...target })) };
}

module.exports = { createAppTargetServerController };