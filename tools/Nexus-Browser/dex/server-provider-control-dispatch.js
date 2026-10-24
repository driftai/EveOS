'use strict';

async function execute(input, deps) {
  const { ws, requestId, source, command, action, origin, roomId } = input;
  const {
    serverControl, orchestrationPolicy, getState, spawnTarget, closeTarget,
    recentMutations, pruneRecent, mutationKey, now,
    settledOrchestrationAuthorization, sendResult, commitOriginReceipt
  } = deps;
  pruneRecent();
  const key = mutationKey(source, command, roomId);
  const recent = key ? recentMutations.get(key) : null;
  if (recent) {
    sendResult({ sourceSocket: ws, requestId, source }, recent.result,
      commitOriginReceipt(origin, recent.result, requestId));
    return true;
  }
  let routed = command, spawned = null, managedTarget = null;
  const authorization = await settledOrchestrationAuthorization(action, source, routed);
  let result = authorization && !authorization.ok ? authorization : null;
  if (!result && action === 'spawn_agent') {
    const committed = orchestrationPolicy.managedMembers(getState?.() || {}).length;
    if (committed >= orchestrationPolicy.MAX_MANAGED_AGENTS) {
      result = { ok: false, code: 'DEX_CONTROL_SPAWN_LIMIT',
        message: `Dex already has ${committed} managed browser worker(s); the current limit is ${orchestrationPolicy.MAX_MANAGED_AGENTS}.` };
    } else if (typeof spawnTarget !== 'function') {
      result = { ok: false, code: 'DEX_CONTROL_SPAWN_UNAVAILABLE', message: 'Managed browser-agent spawning is unavailable in this runtime.' };
    } else {
      try {
        spawned = await spawnTarget({ requestId, providerId: routed.providerId });
        routed = { ...routed, room: authorization.roomId, targetClassId: 'online-origin',
          targetId: spawned.id, providerId: spawned.providerId, spawnedTarget: spawned };
      } catch (error) {
        result = { ok: false, code: error.code || 'DEX_CONTROL_SPAWN_FAILED', message: error.message,
          ...(error.detail ? { data: { failureDetail: error.detail } } : {}) };
      }
    }
  } else if (!result && action === 'despawn_agent') {
    managedTarget = authorization?.target || null;
    routed = { ...routed, room: authorization.roomId, member: authorization.memberId };
  }
  if (!result) result = serverControl.execute({ source, command: routed, origin });
  if (action === 'spawn_agent' && spawned && !result.ok && typeof closeTarget === 'function') {
    try { await closeTarget({ requestId: `${requestId}-rollback`, targetId: spawned.id, providerId: spawned.providerId }); }
    catch (error) { result = { ...result, data: { ...(result.data || {}), cleanupWarning: error.message } }; }
  }
  if (action === 'despawn_agent' && result.ok && managedTarget && typeof closeTarget === 'function') {
    try {
      const cleanup = await closeTarget({ requestId, targetId: managedTarget.targetId, providerId: managedTarget.providerId });
      result = { ...result, data: { ...(result.data || {}), targetClosed: true, alreadyClosed: !!cleanup?.alreadyClosed } };
    } catch (error) {
      result = { ...result, data: { ...(result.data || {}), targetClosed: false, cleanupWarning: error.message } };
    }
  }
  if (key && (result.ok || result.code === 'DEX_CONTROL_OUTCOME_UNKNOWN')) {
    recentMutations.set(key, { at: now(), result });
  }
  sendResult({ sourceSocket: ws, requestId, source }, result,
    commitOriginReceipt(origin, result, requestId));
  return true;
}

module.exports = { execute };
