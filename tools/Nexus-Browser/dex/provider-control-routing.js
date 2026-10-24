const orchestrationPolicy = require('./provider-orchestration-policy'), controlReceiptApi = require('./provider-control-receipt');
const { createAgentExtensionReload } = require('./agent-extension-reload'), directSend = require('./provider-control-direct-send');
const { directRoomSend } = require('./direct-room-send-policy'), { routeDoneWatch } = require('./provider-control-done-watch');
const roomTools = require('./room-tools'), provenance = require('./provider-control-provenance');
const { createLocalProviderControlDelivery } = require('./local-provider-control-delivery'), { createServerProviderControl } = require('./server-provider-control');
const serverControlDispatch = require('./server-provider-control-dispatch'), { runPostIdleCommand } = require('./post-idle-control');
const { createProviderControlUiFallback } = require('./provider-control-ui-fallback');
const POST_IDLE_ACTIONS = new Set(['arm_post_idle','post_idle_status','cancel_post_idle','report_post_idle']);
const MUTATING_ACTIONS = new Set([
  'checkpoint', 'create_room', 'rename_room', 'configure_room', 'add_agent', 'spawn_agent', 'despawn_agent', 'rename_agent', 'set_agent_relay', 'remove_agent', 'rename_self', 'set_self_relay',
  'stop_relay', 'continue_relay', 'set_room_budget', 'clear_chat', 'delete_room', 'send', 'handoff_room', 'reload_extension', 'watch_done', 'unwatch_done', 'arm_post_idle', 'cancel_post_idle', 'report_post_idle',
  'workspace_ensure', 'terminal_exec', 'job_prepare', 'playwright_prepare', 'governor_prepare', 'quorum_presence', 'quorum_open', 'quorum_vote', 'quorum_close'
]);
const DEDUPE_TTL_MS = 120000, MAX_ORIGIN_WAIT_MS = 4 * 60 * 1000, ORIGIN_POLL_MS = 250, LATE_ORIGIN_GRACE_MS = 5000;
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}
function sourceFingerprint(source = {}) {
  return [
    source.targetClassId || '',
    source.providerId || '',
    source.targetId == null ? '' : String(source.targetId),
    source.url || ''
  ].join('|');
}
function mutationKey(source, command = {}, roomId = '') {
  const action = String(command.action || '').trim().toLowerCase();
  if (!MUTATING_ACTIONS.has(action)) return '';
  return `${sourceFingerprint(source)}|${String(roomId || '')}|${JSON.stringify(stableValue({ ...command, action }))}`;
}
function createProviderControlRouting({
  uiSockets, safeSend, validateSource, ensureDexClient, getDexClient,
  getState, saveState, broadcastState, spawnTarget, closeTarget, machineCommandRouter, recordIncident, getExtension, getRuntimeState = () => ({}),
  getMaintenance = () => null, maintenanceBusy = () => false, getScheduler = () => null,
  issueUiAuthorization = () => null, revokeUiAuthorization = () => false,
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  const pending = new Map();
  const pendingMutations = new Map();
  const recentMutations = new Map();
  let admissionLane = Promise.resolve();
  const serverControl = typeof getState === 'function' && typeof saveState === 'function'
    ? createServerProviderControl({ getState, saveState, broadcastState, getScheduler, getRuntimeState,
      now: () => new Date(now()).toISOString() })
    : { owns: () => false };
  const uiFallback = createProviderControlUiFallback({ uiSockets, safeSend, ensureDexClient, getDexClient, getState,
    spawnTarget, closeTarget, recordIncident, issueUiAuthorization, revokeUiAuthorization, now, setTimer, clearTimer,
    orchestrationPolicy, settledOrchestrationAuthorization, mutationKey, pruneRecent, recentMutations, sendResult,
    commitOriginReceipt, fail, mutatingActions: MUTATING_ACTIONS, pending, pendingMutations });
  const agentExtensionReload = createAgentExtensionReload({ getState, getExtension, hasPending: () => pending.size > 0, safeSend, recordIncident, now, sleep });
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
  function routeServerOwned(ws, requestId, source, command, action, origin, roomId) {
    const run = admissionLane.then(() => serverControlDispatch.execute({ ws, requestId, source, command, action, origin, roomId },
      { serverControl, orchestrationPolicy, getState, spawnTarget, closeTarget, recentMutations, pruneRecent,
        mutationKey, now, settledOrchestrationAuthorization, sendResult, commitOriginReceipt }));
    admissionLane = run.catch(() => {});
    return run.catch(() => {
      const mutation = MUTATING_ACTIONS.has(action);
      fail(ws, requestId, source, mutation ? 'DEX_CONTROL_OUTCOME_UNKNOWN' : 'DEX_CONTROL_FAILED', mutation
        ? 'Server-owned Dex control did not confirm its durable outcome. Inspect state before retrying.'
        : 'Server-owned Dex control failed before producing a result.', origin);
      return true;
    });
  }
  async function settleOrigin(source, command, requestId, timeoutMs = MAX_ORIGIN_WAIT_MS, roomIdHint = null) {
    if (typeof getState !== 'function') return { origin: null };
    const action = String(command?.action || '').trim().toLowerCase();
    const onlineMutation = String(source?.targetClassId || '').trim().toLowerCase() === 'online-origin'
      && MUTATING_ACTIONS.has(action);
    const findExactIntent = (snapshot) => roomIdHint
      ? controlReceiptApi.findIntentInRoom(snapshot, roomIdHint, source, command)
      : controlReceiptApi.findIntent(snapshot, source, command);
    let snapshot = getState();
    let origin = findExactIntent(snapshot);
    if (origin) return { origin };
    let active = controlReceiptApi.activeSourceTurn(snapshot, source);
    if (active?.ambiguous) {
      return { error: {
        code: 'DEX_CONTROL_ORIGIN_AMBIGUOUS',
        message: 'Dex found more than one active relay turn for this provider-control source; refusing to execute without a unique origin.'
      } };
    }
    if (!active && onlineMutation && roomIdHint) {
      const graceDeadline = now() + Math.min(timeoutMs, LATE_ORIGIN_GRACE_MS);
      while (now() < graceDeadline) {
        await sleep(ORIGIN_POLL_MS);
        snapshot = getState();
        origin = controlReceiptApi.findIntentInRoom(snapshot, roomIdHint, source, command);
        if (origin) return { origin };
        const candidate = controlReceiptApi.activeSourceTurn(snapshot, source);
        if (candidate?.ambiguous) {
          return { error: {
            code: 'DEX_CONTROL_ORIGIN_AMBIGUOUS',
            message: 'Dex found more than one active relay turn for this provider-control source; refusing to execute without a unique origin.'
          } };
        }
        if (candidate) { active = candidate; break; }
      }
    }
    if (!active) return { origin: null };
    if (roomIdHint && active.roomId !== roomIdHint) {
      return { error: {
        code: 'DEX_CONTROL_ORIGIN_UNCORRELATED',
        message: 'The active relay turn does not match the exact authorized room for this provider-control source.'
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
  async function handleRequest(ws, msg, trustedProvenance = null) {
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
    let admission;
    try { admission = provenance.authorize({ snapshot: getState?.(), source, command, requestId, trusted: trustedProvenance }); }
    catch { admission = { ok: false, code: 'DEX_ENTRY_STATE_UNAVAILABLE', message: 'Room state unavailable; no command executed.' }; }
    if (!admission?.ok) { fail(ws, requestId, source, admission?.code || 'DEX_ENTRY_STATE_UNAVAILABLE', admission?.message || 'Room state unavailable; no command executed.', admission?.origin); return true; }
    const { entry: entryGate, roomId: boundRoomId, origin: trustedOrigin } = admission;
    let routedCommand = admission.routedCommand;
    if (directRoomSend(routedCommand) && getState && saveState) {
      let origin = trustedOrigin;
      if (String(source.targetClassId || '').trim().toLowerCase() === 'online-origin') {
        const settledOrigin = await settleOrigin(source, command, requestId, MAX_ORIGIN_WAIT_MS, entryGate.roomId || null);
        if (settledOrigin.error) {
          fail(ws, requestId, source, settledOrigin.error.code, settledOrigin.error.message);
          return true;
        }
        origin = settledOrigin.origin;
        if (!origin) {
          fail(ws, requestId, source, 'DEX_CONTROL_ORIGIN_REQUIRED',
            'Online-Origin state-changing provider-control requires an exact durable control origin; no mutation was executed.');
          return true;
        }
      }
      const run = admissionLane.then(() => directSend.route({ source, command: routedCommand, requestId, ws, origin },
        { getState, saveState, broadcastState, getScheduler, now, sendResult, commitOriginReceipt }));
      admissionLane = run.catch(() => {});
      return run.catch(() => (fail(ws, requestId, source, 'DEX_SEND_ADMISSION_UNCERTAIN',
        'Storage error: the outcome may be uncertain. Inspect the same request ID; do not create a new send.'), true));
    }
    if (['room_budget', 'room_log', 'tool_result_status'].includes(action)) return roomTools.route(
      { source, command: routedCommand, requestId, ws, origin: trustedOrigin },
      { getState, saveState, broadcastState, getScheduler, now, sendResult, commitOriginReceipt });
    const settledOrigin = trustedOrigin ? { origin: trustedOrigin } : await settleOrigin(source, command, requestId, MAX_ORIGIN_WAIT_MS, boundRoomId);
    if (settledOrigin.error) {
      fail(ws, requestId, source, settledOrigin.error.code, settledOrigin.error.message);
      return true;
    }
    const origin = settledOrigin.origin;
    if (String(source.targetClassId || '').trim().toLowerCase() === 'online-origin'
      && MUTATING_ACTIONS.has(action) && !origin) {
      fail(ws, requestId, source, 'DEX_CONTROL_ORIGIN_REQUIRED',
        'Online-Origin state-changing provider-control requires an exact durable control origin; no mutation was executed.');
      return true;
    }
    if (machineCommandRouter?.owns(action)) return machineCommandRouter.route({ source, command: routedCommand, requestId, ws, origin, boundRoomId }, { sendResult, commitOriginReceipt });
    if (roomTools.ACTIONS.has(action)) return roomTools.route(
      { source, command: routedCommand, requestId, ws, origin },
      { getState, saveState, broadcastState, getScheduler, now, sendResult, commitOriginReceipt });
    if (POST_IDLE_ACTIONS.has(action)) {
      const result = runPostIdleCommand(getMaintenance(), action, source, routedCommand);
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
      return routeDoneWatch(
        { action, source, command: routedCommand, requestId, ws, origin },
        { getState, saveState, broadcastState, sendResult, fail, commitOriginReceipt }
      );
    }
    if (action === 'reload_extension') {
      const outcome = await agentExtensionReload.run({ source, command: routedCommand, requestId, transportRole: ws?.role || 'local-origin' });
      const recipient = outcome.socket || ws;
      const receipt = commitOriginReceipt(origin, outcome.result, requestId);
      sendResult({ sourceSocket: recipient, requestId, source }, outcome.result, receipt);
      return true;
    }
    if (serverControl.owns(action)) {
      return routeServerOwned(ws, requestId, source, routedCommand, action, origin,
        boundRoomId || origin?.roomId || null);
    }
    return uiFallback.route({ ws, requestId, source, command: routedCommand, action, origin, roomId: boundRoomId });
  }
  const localDelivery = createLocalProviderControlDelivery({ getState, pending, handleRequest });
  async function handle(ws, msg) {
    if (await uiFallback.handleResult(ws, msg)) return true;
    if (msg?.type !== 'provider_control_request') return false;
    const allowedSource = ws?.role === 'provider-control-extension' || ws?.clientKind === 'provider-control';
    if (!allowedSource) return false;
    return handleRequest(ws, msg);
  }
  function dropSocket(ws) {
    agentExtensionReload.dropSocket(ws);
    uiFallback.dropSocket(ws);
  }
  return {
    handle, dropSocket, pending, pendingMutations, recentMutations,
    mutationKey: (source, command, roomId) => mutationKey(source, command, roomId), settleOrigin,
    flushLocalIntents: localDelivery.flush,
    observeExtension: agentExtensionReload.observeExtension, providerControlConnected: agentExtensionReload.providerControlConnected,
    agentExtensionReload
  };
}
module.exports = {
  MUTATING_ACTIONS, DEDUPE_TTL_MS, MAX_ORIGIN_WAIT_MS, ORIGIN_POLL_MS, LATE_ORIGIN_GRACE_MS, stableValue, sourceFingerprint, mutationKey,
  createProviderControlRouting
};
