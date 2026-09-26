const orchestrationPolicy = require('./provider-orchestration-policy'), controlReceiptApi = require('./provider-control-receipt');
const { createAgentExtensionReload } = require('./agent-extension-reload');
const directSend = require('./provider-control-direct-send');
const { directRoomSend } = require('./direct-room-send-policy');
const roomTools = require('./room-tools');
const POST_IDLE_ACTIONS = new Set(['arm_post_idle','post_idle_status','cancel_post_idle','report_post_idle']);
const { runPostIdleCommand } = require('./post-idle-control');
const doneWatchApi = require('../public/dex-done-watch');
const { randomUUID } = require('node:crypto');
const MUTATING_ACTIONS = new Set([
  'checkpoint', 'create_room', 'rename_room', 'configure_room', 'add_agent', 'spawn_agent', 'despawn_agent',
  'rename_agent', 'set_agent_relay', 'remove_agent', 'rename_self', 'set_self_relay',
  'stop_relay', 'continue_relay', 'set_room_budget', 'clear_chat', 'delete_room', 'send', 'handoff_room', 'reload_extension', 'watch_done', 'unwatch_done',
  'arm_post_idle', 'cancel_post_idle', 'report_post_idle'
]);
const DEDUPE_TTL_MS = 120000, MAX_ORIGIN_WAIT_MS = 4 * 60 * 1000, ORIGIN_POLL_MS = 250;
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}
function sourceFingerprint(source = {}) {
  return [
    source.targetClassId || '',
    source.providerId || '',
    source.url || source.targetId || ''
  ].join('|');
}
function mutationKey(source, command = {}) {
  const action = String(command.action || '').trim().toLowerCase();
  if (!MUTATING_ACTIONS.has(action)) return '';
  return `${sourceFingerprint(source)}|${JSON.stringify(stableValue({ ...command, action }))}`;
}
function createProviderControlRouting({
  uiSockets, safeSend, validateSource, ensureDexClient, getDexClient,
  getState, saveState, broadcastState, spawnTarget, closeTarget, recordIncident, getExtension,
  getMaintenance = () => null, maintenanceBusy = () => false, getScheduler = () => null,
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  const pending = new Map();
  const pendingMutations = new Map();
  const recentMutations = new Map();
  const agentExtensionReload = createAgentExtensionReload({ getState, getExtension, hasPending: () => pending.size > 0, safeSend, recordIncident, now, sleep });
  function dexClient() {
    return typeof getDexClient === 'function'
      ? getDexClient()
      : ([...uiSockets].find((peer) => peer.clientKind === 'dex') || null);
  }
  function pruneRecent() {
    const stamp = now();
    for (const [key, entry] of recentMutations) {
      if (stamp - entry.at > DEDUPE_TTL_MS) recentMutations.delete(key);
    }
  }
  function sendResult(waiter, result, originReceipt = null) {
    if (!waiter?.sourceSocket) return false;
    return safeSend(waiter.sourceSocket, {
      type: 'provider_control_result',
      requestId: waiter.requestId,
      source: waiter.source,
      result,
      ...(originReceipt ? { originReceipt } : {})
    });
  }
  function commitOriginReceipt(origin, result, requestId) {
    if (!origin || typeof getState !== 'function' || typeof saveState !== 'function') return null;
    const applied = controlReceiptApi.applyResult(getState(), origin, result, requestId, new Date(now()).toISOString());
    if (!applied.receipt) return null;
    const saved = saveState(applied.snapshot);
    if (typeof broadcastState === 'function') broadcastState(saved);
    return applied.receipt;
  }
  function finish(requestId, payload) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    clearTimer(entry.timer);
    pending.delete(requestId);
    if (entry.key && pendingMutations.get(entry.key) === requestId) pendingMutations.delete(entry.key);
    const result = payload?.result || { ok: false, code: 'DEX_CONTROL_FAILED', message: 'Dex provider-control returned no result.' };
    if (entry.key && (result.ok || result.code === 'DEX_CONTROL_OUTCOME_UNKNOWN')) {
      recentMutations.set(entry.key, { at: now(), result });
    }
    const originReceipt = commitOriginReceipt(entry.origin, result, requestId);
    sendResult(entry, result, originReceipt);
    for (const waiter of entry.waiters) sendResult(waiter, result);
    return true;
  }
  function fail(sourceSocket, requestId, source, code, message, origin = null) {
    const result = { ok: false, code, message };
    sendResult({ sourceSocket, requestId, source }, result, commitOriginReceipt(origin, result, requestId));
  }
  function orchestrationAuthorization(action, source, command) {
    const snapshot = typeof getState === 'function' ? getState() : {};
    if (action === 'spawn_agent') return orchestrationPolicy.authorizeSpawn(snapshot, source, command);
    if (action === 'despawn_agent') return orchestrationPolicy.authorizeDespawn(snapshot, source, command);
    return null;
  }
  async function settledOrchestrationAuthorization(action, source, command, timeoutMs = 10000) {
    let authorization = orchestrationAuthorization(action, source, command);
    if (!authorization?.waitForSourceTurn) return authorization;
    const deadline = now() + timeoutMs;
    while (authorization?.waitForSourceTurn && now() < deadline) {
      await sleep(100);
      authorization = orchestrationAuthorization(action, source, command);
    }
    return authorization;
  }
  async function settleOrigin(source, command, requestId, timeoutMs = MAX_ORIGIN_WAIT_MS) {
    if (typeof getState !== 'function') return { origin: null };
    let snapshot = getState();
    let origin = controlReceiptApi.findIntent(snapshot, source, command);
    if (origin) return { origin };
    const active = controlReceiptApi.activeSourceTurn(snapshot, source);
    if (!active) return { origin: null };
    if (active.ambiguous) {
      return { error: {
        code: 'DEX_CONTROL_ORIGIN_AMBIGUOUS',
        message: 'Dex found more than one active relay turn for this provider-control source; refusing to execute without a unique origin.'
      } };
    }
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      await sleep(ORIGIN_POLL_MS);
      snapshot = getState();
      origin = controlReceiptApi.findIntentInRoom(snapshot, active.roomId, source, command);
      if (origin) return { origin };
      const current = controlReceiptApi.activeSourceTurn(snapshot, source);
      const sameTurn = current && !current.ambiguous
        && current.roomId === active.roomId
        && (!active.requestId || !current.requestId || current.requestId === active.requestId);
      if (!sameTurn) {
        return { error: {
          code: 'DEX_CONTROL_ORIGIN_UNCORRELATED',
          message: 'The relay turn settled without recording this provider-control command. Dex refused to execute it because the originating turn could not be correlated.'
        } };
      }
    }
    return { error: {
      code: 'DEX_CONTROL_ORIGIN_TIMEOUT',
      message: `The provider-control command arrived before relay turn ${active.requestId || requestId || 'unknown'} finalized. Dex waited for exact origin correlation and refused to execute after timeout.`
    } };
  }
  async function handleRequest(ws, msg) {
    const requestId = String(msg.requestId || '');
    const source = msg.source || {};
    const command = msg.command || {};
    const action = String(command.action || '').trim().toLowerCase();
    if (!requestId || !command || typeof command !== 'object') {
      fail(ws, requestId || null, source, 'DEX_CONTROL_BAD_REQUEST', 'Provider-control request is incomplete.');
      return true;
    }
    if (typeof validateSource === 'function' && !(await validateSource(source, ws))) {
      fail(ws, requestId, source, 'DEX_CONTROL_BAD_SOURCE', 'Provider-control source could not be verified.');
      return true;
    }
    safeSend(ws, { type: 'provider_control_received', requestId, clientActionId: msg.clientActionId || null });
    // New authenticated room sends are admitted to the durable inbox without
    // waiting on a different agent's unfinished or NOTE-stopped relay.
    if (directRoomSend(command) && getState && saveState)
      return directSend.route({ source, command, requestId, ws },
        { getState, saveState, broadcastState, getScheduler, now, sendResult,
          commitOriginReceipt, findOrigin: controlReceiptApi.findIntent });
    if (['room_budget', 'room_log'].includes(action)) return roomTools.route(
      { source, command, requestId, ws, origin: null },
      { getState, saveState, broadcastState, getScheduler, now, sendResult, commitOriginReceipt });
    const settledOrigin = await settleOrigin(source, command, requestId);
    if (settledOrigin.error) {
      fail(ws, requestId, source, settledOrigin.error.code, settledOrigin.error.message);
      return true;
    }
    const origin = settledOrigin.origin;
    if (roomTools.ACTIONS.has(action)) return roomTools.route(
      { source, command, requestId, ws, origin },
      { getState, saveState, broadcastState, getScheduler, now, sendResult, commitOriginReceipt });
    if (POST_IDLE_ACTIONS.has(action)) {
      const result = runPostIdleCommand(getMaintenance(), action, source, command);
      const receipt = commitOriginReceipt(origin, result, requestId);
      sendResult({ sourceSocket: ws, requestId, source }, result, receipt);
      return true;
    }
    if (maintenanceBusy() && MUTATING_ACTIONS.has(action)) {
      fail(ws, requestId, source, 'POST_IDLE_LEASE_BUSY',
        'Post-idle maintenance holds the exclusive local dispatch lease.', origin);
      return true;
    }
    if (action === 'watch_done' || action === 'unwatch_done') {
      const snapshot = typeof getState === 'function' ? getState() : null;
      if (!snapshot || typeof saveState !== 'function') {
        fail(ws, requestId, source, 'DEX_DONE_WATCH_UNAVAILABLE', 'Durable DONE watch storage is unavailable.', origin);
        return true;
      }
      const eligible = (snapshot.rooms || []).filter((room) => (room.members || [])
        .some((member) => controlReceiptApi.bindingMatchesSource(member.binding, source)));
      const reference = String(command.room || '').trim();
      const chosen = reference
        ? eligible.filter((room) => room.id === reference
          || String(room.name || '').toLowerCase() === reference.toLowerCase())
        : eligible;
      if (chosen.length !== 1) {
        fail(ws, requestId, source, 'DEX_DONE_WATCH_ROOM_REQUIRED', 'Specify one exact authorized room for this DONE watch.', origin);
        return true;
      }
      const room = chosen[0];
      const watcher = room.members.find((member) => controlReceiptApi.bindingMatchesSource(member.binding, source));
      if (action === 'unwatch_done') {
        const removed = doneWatchApi.disarm(room, watcher.id);
        const saved = saveState(snapshot); broadcastState?.(saved);
        sendResult({ sourceSocket: ws, requestId, source }, { ok: true, action, message: 'DONE notifications disarmed for this participant.', data: { roomId: room.id, removed: removed.removed } });
        return true;
      }
      const ref = String(command.member || '').trim();
      const targets = ref ? (room.members || []).filter((member) =>
        member.id === ref || String(member.name || '').toLowerCase() === ref.toLowerCase()) : [];
      if (ref && targets.length !== 1) {
        fail(ws, requestId, source, 'DEX_DONE_WATCH_BAD_TARGET', 'Specify a unique other room participant to watch.', origin);
        return true;
      }
      const armed = doneWatchApi.arm(room, {
        watcherMemberId: watcher.id, targetMemberId: targets[0]?.id || null,
        id: `done-watch-${randomUUID()}`
      });
      if (!armed.ok) {
        fail(ws, requestId, source, armed.code, armed.message, origin);
        return true;
      }
      const saved = saveState(snapshot); broadcastState?.(saved);
      sendResult({ sourceSocket: ws, requestId, source }, {
        ok: true, action, message: 'Armed one-shot DONE notification; no extra Dex relay turn will run.',
        data: { roomId: room.id, watchId: armed.watch.id, targetMemberId: armed.watch.targetMemberId, expiresAt: armed.watch.expiresAt }
      });
      return true;
    }
    if (action === 'reload_extension') {
      const outcome = await agentExtensionReload.run({ source, command, requestId, transportRole: ws.role });
      const recipient = outcome.socket || ws;
      const receipt = commitOriginReceipt(origin, outcome.result, requestId);
      sendResult({ sourceSocket: recipient, requestId, source }, outcome.result, receipt);
      return true;
    }
    pruneRecent();
    const key = mutationKey(source, command);
    if (key) {
      const recent = recentMutations.get(key);
      if (recent) {
        sendResult({ sourceSocket: ws, requestId, source }, recent.result, commitOriginReceipt(origin, recent.result, requestId));
        return true;
      }
      const canonicalId = pendingMutations.get(key);
      const canonical = canonicalId ? pending.get(canonicalId) : null;
      if (canonical) {
        if (!canonical.origin && origin) canonical.origin = origin;
        canonical.waiters.push({ sourceSocket: ws, requestId, source });
        return true;
      }
    }
    let dex = dexClient();
    if (!dex && typeof ensureDexClient === 'function') {
      try { await ensureDexClient(); } catch {}
      dex = dexClient();
    }
    if (!dex) {
      fail(ws, requestId, source, 'DEX_UI_OFFLINE', 'Dex Mode UI could not be started automatically. Open Nexus Browser in EveOS once and retry.', origin);
      return true;
    }
    const authorization = await settledOrchestrationAuthorization(action, source, command);
    if (authorization?.ok && action === 'spawn_agent') {
      const snapshot = typeof getState === 'function' ? getState() : {};
      const committed = orchestrationPolicy.managedMembers(snapshot).length;
      const inFlight = [...pending.values()].filter((entry) => entry.action === 'spawn_agent').length;
      if (committed + inFlight >= orchestrationPolicy.MAX_MANAGED_AGENTS) {
        fail(ws, requestId, source, 'DEX_CONTROL_SPAWN_LIMIT', `Dex already has ${committed} managed browser worker(s) and ${inFlight} spawn(s) in flight; the current limit is ${orchestrationPolicy.MAX_MANAGED_AGENTS}.`, origin);
        return true;
      }
    }
    if (authorization && !authorization.ok) {
      fail(ws, requestId, source, authorization.code, authorization.message, origin);
      return true;
    }

    const timer = setTimer(() => {
      finish(requestId, {
        result: key
          ? { ok: false, code: 'DEX_CONTROL_OUTCOME_UNKNOWN', message: 'Dex Mode did not confirm this state-changing provider-control request. Its outcome is unknown; inspect room status before retrying.', data: { commitState: 'unknown', commitId: null } }
          : { ok: false, code: 'DEX_CONTROL_TIMEOUT', message: 'Dex Mode did not answer the provider-control request in time.' }
      });
    }, action === 'spawn_agent' || action === 'despawn_agent' ? 45000 : 15000);

    const entry = {
      sourceSocket: ws, source, requestId, timer, key, waiters: [],
      action, origin, spawnedTarget: null, managedTarget: authorization?.target || null
    };
    pending.set(requestId, entry);
    if (key) pendingMutations.set(key, requestId);

    let routedCommand = command;
    if (action === 'spawn_agent') {
      if (typeof spawnTarget !== 'function') {
        finish(requestId, { result: { ok: false, code: 'DEX_CONTROL_SPAWN_UNAVAILABLE', message: 'Managed browser-agent spawning is unavailable in this runtime.' } });
        return true;
      }
      try {
        const target = await spawnTarget({ requestId, providerId: command.providerId });
        if (!pending.has(requestId)) {
          if (typeof closeTarget === 'function') {
            await closeTarget({ requestId: `${requestId}-late-cleanup`, targetId: target.id, providerId: target.providerId }).catch(() => {});
          }
          return true;
        }
        entry.spawnedTarget = target;
        routedCommand = {
          ...command,
          room: authorization.roomId,
          targetClassId: 'online-origin',
          targetId: target.id,
          providerId: target.providerId,
          spawnedTarget: target
        };
      } catch (error) {
        const code = error.code || 'DEX_CONTROL_SPAWN_FAILED';
        const detail = error.detail || null;
        if (typeof recordIncident === 'function') {
          try {
            recordIncident({
              code,
              message: error.message,
              requestId,
              roomId: authorization?.roomId || null,
              source: 'provider-control-spawn',
              evidence: {
                providerId: command.providerId || null,
                sourceTargetClassId: source.targetClassId || null,
                sourceProviderId: source.providerId || null,
                sourceTargetId: source.targetId ?? null,
                detail
              }
            });
          } catch {}
        }
        finish(requestId, {
          result: {
            ok: false,
            code,
            message: error.message,
            data: detail ? { failureDetail: detail } : undefined
          }
        });
        return true;
      }
    } else if (action === 'despawn_agent') {
      routedCommand = { ...command, room: authorization.roomId, member: authorization.memberId };
    }

    if (!safeSend(dex, { type: 'provider_control_request', requestId, source, command: routedCommand })) {
      if (entry.spawnedTarget && typeof closeTarget === 'function') {
        await closeTarget({ requestId: `${requestId}-route-cleanup`, targetId: entry.spawnedTarget.id, providerId: entry.spawnedTarget.providerId }).catch(() => {});
      }
      finish(requestId, { result: { ok: false, code: 'DEX_UI_OFFLINE', message: 'Dex controller disconnected before the managed worker mutation could be committed.' } });
    }
    return true;
  }

  async function handleResult(ws, msg) {
    if (msg?.type !== 'provider_control_result' || ws?.clientKind !== 'dex' || ws !== dexClient()) return false;
    const requestId = String(msg.requestId || '');
    const entry = pending.get(requestId);
    if (!entry) return false;
    let result = msg.result || { ok: false, code: 'DEX_CONTROL_FAILED', message: 'Dex provider-control returned no result.' };

    if (entry.action === 'spawn_agent' && entry.spawnedTarget && !result.ok && typeof closeTarget === 'function') {
      try {
        await closeTarget({
          requestId: `${requestId}-rollback`,
          targetId: entry.spawnedTarget.id,
          providerId: entry.spawnedTarget.providerId
        });
      } catch (error) {
        result = { ...result, data: { ...(result.data || {}), cleanupWarning: error.message } };
      }
    }

    if (entry.action === 'despawn_agent' && result.ok && entry.managedTarget && typeof closeTarget === 'function') {
      try {
        const cleanup = await closeTarget({
          requestId,
          targetId: entry.managedTarget.targetId,
          providerId: entry.managedTarget.providerId
        });
        result = { ...result, data: { ...(result.data || {}), targetClosed: true, alreadyClosed: !!cleanup?.alreadyClosed } };
      } catch (error) {
        result = { ...result, data: { ...(result.data || {}), targetClosed: false, cleanupWarning: error.message } };
      }
    }

    finish(requestId, { ...msg, result });
    return true;
  }

  async function handle(ws, msg) {
    if (await handleResult(ws, msg)) return true;
    if (msg?.type !== 'provider_control_request') return false;
    const allowedSource = ws?.role === 'provider-control-extension' || ws?.clientKind === 'provider-control';
    if (!allowedSource) return false;
    return handleRequest(ws, msg);
  }

  function dropSocket(ws) {
    agentExtensionReload.dropSocket(ws);
    for (const [requestId, entry] of pending) {
      entry.waiters = entry.waiters.filter((waiter) => waiter.sourceSocket !== ws);
      if (entry.sourceSocket !== ws) continue;
      if (entry.key) {
        entry.sourceSocket = null;
        continue;
      }
      clearTimer(entry.timer);
      pending.delete(requestId);
    }
  }

  return {
    handle, dropSocket, pending, pendingMutations, recentMutations,
    mutationKey: (source, command) => mutationKey(source, command), settleOrigin,
    observeExtension: agentExtensionReload.observeExtension, providerControlConnected: agentExtensionReload.providerControlConnected,
    agentExtensionReload
  };
}

module.exports = {
  MUTATING_ACTIONS, DEDUPE_TTL_MS, MAX_ORIGIN_WAIT_MS, ORIGIN_POLL_MS, stableValue, sourceFingerprint, mutationKey,
  createProviderControlRouting
};
