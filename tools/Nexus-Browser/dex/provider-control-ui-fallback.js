'use strict';

function createProviderControlUiFallback(deps) {
  const {
    uiSockets, safeSend, ensureDexClient, getDexClient, getState, spawnTarget, closeTarget, recordIncident,
    issueUiAuthorization, revokeUiAuthorization, now, setTimer, clearTimer, orchestrationPolicy,
    settledOrchestrationAuthorization, mutationKey, pruneRecent, recentMutations,
    sendResult, commitOriginReceipt, fail
  } = deps;
  const pending = deps.pending || new Map(), pendingMutations = deps.pendingMutations || new Map();
  const dexClient = () => typeof getDexClient === 'function' ? getDexClient()
    : ([...uiSockets].find((peer) => peer.clientKind === 'dex') || null);
  function finish(requestId, payload) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    revokeUiAuthorization(entry.uiAuthorization); clearTimer(entry.timer); pending.delete(requestId);
    if (entry.key && pendingMutations.get(entry.key) === requestId) pendingMutations.delete(entry.key);
    const result = payload?.result || { ok: false, code: 'DEX_CONTROL_FAILED', message: 'Dex provider-control returned no result.' };
    if (entry.key && (result.ok || result.code === 'DEX_CONTROL_OUTCOME_UNKNOWN')) recentMutations.set(entry.key, { at: now(), result });
    sendResult(entry, result, commitOriginReceipt(entry.origin, result, requestId));
    for (const waiter of entry.waiters) sendResult(waiter, result);
    return true;
  }
  async function route({ ws, requestId, source, command: initialCommand, action, origin, roomId }) {
    let command = initialCommand;
    pruneRecent();
    const key = mutationKey(source, command, roomId);
    if (key) {
      const recent = recentMutations.get(key);
      if (recent) { sendResult({ sourceSocket: ws, requestId, source }, recent.result,
        commitOriginReceipt(origin, recent.result, requestId)); return true; }
      const canonical = pending.get(pendingMutations.get(key));
      if (canonical) { if (!canonical.origin && origin) canonical.origin = origin;
        canonical.waiters.push({ sourceSocket: ws, requestId, source }); return true; }
    }
    let dex = dexClient();
    if (!dex && typeof ensureDexClient === 'function') { try { await ensureDexClient(); } catch {} dex = dexClient(); }
    if (!dex) { fail(ws, requestId, source, 'DEX_UI_OFFLINE',
      'Dex Mode UI could not be started automatically. Open Nexus Browser in EveOS once and retry.', origin); return true; }
    const authorization = await settledOrchestrationAuthorization(action, source, command);
    if (authorization?.ok && action === 'spawn_agent') {
      const committed = orchestrationPolicy.managedMembers(getState?.() || {}).length;
      const inFlight = [...pending.values()].filter((entry) => entry.action === 'spawn_agent').length;
      if (committed + inFlight >= orchestrationPolicy.MAX_MANAGED_AGENTS) {
        fail(ws, requestId, source, 'DEX_CONTROL_SPAWN_LIMIT', `Dex already has ${committed} managed browser worker(s) and ${inFlight} spawn(s) in flight; the current limit is ${orchestrationPolicy.MAX_MANAGED_AGENTS}.`, origin);
        return true;
      }
    }
    if (authorization && !authorization.ok) { fail(ws, requestId, source, authorization.code, authorization.message, origin); return true; }
    const timer = setTimer(() => finish(requestId, { result: key
      ? { ok: false, code: 'DEX_CONTROL_OUTCOME_UNKNOWN', message: 'Dex Mode did not confirm this state-changing provider-control request. Its outcome is unknown; inspect room status before retrying.', data: { commitState: 'unknown', commitId: null } }
      : { ok: false, code: 'DEX_CONTROL_TIMEOUT', message: 'Dex Mode did not answer the provider-control request in time.' }
    }), action === 'spawn_agent' || action === 'despawn_agent' ? 45000 : 15000);
    const uiAuthorization = deps.mutatingActions.has(action) ? issueUiAuthorization({ ws: dex, requestId, action,
      roomId: authorization?.roomId || roomId || origin?.roomId || null }) : null;
    const entry = { sourceSocket: ws, source, requestId, timer, key, waiters: [], action, origin,
      roomId: authorization?.roomId || roomId || origin?.roomId || null, uiAuthorization,
      spawnedTarget: null, managedTarget: authorization?.target || null };
    pending.set(requestId, entry); if (key) pendingMutations.set(key, requestId);
    if (action === 'spawn_agent') {
      if (typeof spawnTarget !== 'function') { finish(requestId, { result: { ok: false,
        code: 'DEX_CONTROL_SPAWN_UNAVAILABLE', message: 'Managed browser-agent spawning is unavailable in this runtime.' } }); return true; }
      try {
        const target = await spawnTarget({ requestId, providerId: command.providerId });
        if (!pending.has(requestId)) { await closeTarget?.({ requestId: `${requestId}-late-cleanup`, targetId: target.id, providerId: target.providerId }).catch(() => {}); return true; }
        entry.spawnedTarget = target;
        command = { ...command, room: authorization.roomId, targetClassId: 'online-origin', targetId: target.id,
          providerId: target.providerId, spawnedTarget: target };
      } catch (error) {
        try { recordIncident?.({ code: error.code || 'DEX_CONTROL_SPAWN_FAILED', message: error.message, requestId,
          roomId: authorization?.roomId || null, source: 'provider-control-spawn', evidence: { detail: error.detail || null } }); } catch {}
        finish(requestId, { result: { ok: false, code: error.code || 'DEX_CONTROL_SPAWN_FAILED', message: error.message,
          ...(error.detail ? { data: { failureDetail: error.detail } } : {}) } }); return true;
      }
    } else if (action === 'despawn_agent') command = { ...command, room: authorization.roomId, member: authorization.memberId };
    if (!safeSend(dex, { type: 'provider_control_request', requestId, source, command,
      ...(uiAuthorization ? { authorization: uiAuthorization } : {}) })) {
      if (entry.spawnedTarget && typeof closeTarget === 'function') await closeTarget({ requestId: `${requestId}-route-cleanup`,
        targetId: entry.spawnedTarget.id, providerId: entry.spawnedTarget.providerId }).catch(() => {});
      finish(requestId, { result: { ok: false, code: 'DEX_UI_OFFLINE', message: 'Dex controller disconnected before the managed worker mutation could be committed.' } });
    }
    return true;
  }
  async function handleResult(ws, msg) {
    if (msg?.type !== 'provider_control_result' || ws?.clientKind !== 'dex' || ws !== dexClient()) return false;
    const entry = pending.get(String(msg.requestId || ''));
    if (!entry) return false;
    let result = msg.result || { ok: false, code: 'DEX_CONTROL_FAILED', message: 'Dex provider-control returned no result.' };
    if (entry.action === 'spawn_agent' && entry.spawnedTarget && !result.ok && typeof closeTarget === 'function') {
      try { await closeTarget({ requestId: `${entry.requestId}-rollback`, targetId: entry.spawnedTarget.id, providerId: entry.spawnedTarget.providerId }); }
      catch (error) { result = { ...result, data: { ...(result.data || {}), cleanupWarning: error.message } }; }
    }
    if (entry.action === 'despawn_agent' && result.ok && entry.managedTarget && typeof closeTarget === 'function') {
      try { const cleanup = await closeTarget({ requestId: entry.requestId, targetId: entry.managedTarget.targetId,
        providerId: entry.managedTarget.providerId }); result = { ...result, data: { ...(result.data || {}), targetClosed: true, alreadyClosed: !!cleanup?.alreadyClosed } }; }
      catch (error) { result = { ...result, data: { ...(result.data || {}), targetClosed: false, cleanupWarning: error.message } }; }
    }
    finish(entry.requestId, { ...msg, result }); return true;
  }
  function dropSocket(ws) {
    for (const [requestId, entry] of pending) {
      entry.waiters = entry.waiters.filter((waiter) => waiter.sourceSocket !== ws);
      if (entry.sourceSocket !== ws) continue;
      if (entry.key) { entry.sourceSocket = null; continue; }
      clearTimer(entry.timer); pending.delete(requestId);
    }
  }
  return { pending, pendingMutations, route, handleResult, dropSocket };
}

module.exports = { createProviderControlUiFallback };
