const { randomUUID } = require('node:crypto');
const protocol = require('../public/dex-protocol');
const healthApi = require('../public/dex-provider-health');
const failurePolicy = require('../public/dex-failure-policy');
const stateApi = require('./server-scheduler-state'), controlReceiptApi = require('./provider-control-receipt'), doneWatchApi = require('../public/dex-done-watch');
const { createServerSchedulerRecovery } = require('./server-scheduler-recovery');
const { TURN_TIMEOUT_MS, TURN_IDLE_TIMEOUT_MS, TURN_ABSOLUTE_TIMEOUT_MS,
  activityFromTransport, createServerTurnLease } = require('./server-turn-lease');

function createDexServerScheduler({
  stateStore,
  durability,
  getOnlineTargets = () => [], getProviders = () => [],
  getSelectedOnlineTarget = () => null,
  getLocalTargets = async () => [], isExtensionAvailable = () => true,
  sendExtension = () => false,
  sendLocalPrompt,
  captureLocalLatest,
  broadcastState = () => {},
  broadcastEvent = () => {}, onTurnSettled = () => {},
  recordIncident = (input) => durability?.recordIncident?.(input),
  now = () => new Date().toISOString(), nowMs = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let current = null, retryTimer = null;
  let processing = false;
  const uid = (prefix = 'dex') => `${prefix}-${randomUUID()}`;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const load = () => stateStore?.load?.() || { version: 1, rooms: [], activeRoomId: null, savedAt: now() };
  const save = (snapshot) => { const value = stateStore.save(snapshot); broadcastState(clone(value)); return value; };
  const addMessage = (room, input) => stateApi.addMessage(room, { id: uid('msg'), at: now(), ...input });
  const setStopped = (room, reason) => stateApi.setStopped(room, reason, now());
  const enqueueNext = (room, source) => stateApi.enqueueNext(room, source, now());
  function clearCurrent() { lease.clear(); current = null; }
  function processSoon(delay = 0) {
    if (retryTimer) clearTimer(retryTimer);
    retryTimer = setTimer(() => { retryTimer = null; process().catch((error) => failCurrent(error.message)); }, Math.max(0, delay));
  }

  const recovery = createServerSchedulerRecovery({
    load, save, uid,
    getOnlineTargets, getProviders, getSelectedOnlineTarget, getLocalTargets,
    isExtensionAvailable, sendExtension, captureLocalLatest, recordIncident,
    markTimedOut: (journal) => durability?.markFailed?.(
      journal?.requestId, 'RECOVERY_TIMEOUT',
      { targetClassId: journal?.targetClassId || null, providerId: journal?.providerId || null }),
    addMessage, enqueueNext, setStopped, processSoon,
    onRecovered: ({ room, member, message, parsed }) => {
      if (parsed.done) doneWatchApi.consume(room, { completedMemberId: member.id, message, at: now() });
      if (parsed.headsUpTarget || parsed.headsUpInvalid) doneWatchApi.emitHeadsUp(room, { senderMemberId: member.id, targetRef: parsed.headsUpTarget, invalid: parsed.headsUpInvalid, done: parsed.done, message, at: now() });
    }, onTurnSettled
  });
  const lease = createServerTurnLease({ load, save, roomById: stateApi.roomById,
    getCurrent: () => current, onTimeout: handleTurnError, now, nowMs, setTimer, clearTimer });

  async function localTarget(member) { return stateApi.resolveLocal(member, await getLocalTargets(true)); }
  function writeRecovery(snapshot, room, member) {
    room.recovery = stateApi.createRecoveryJournal(current, member, room, now());
    save(snapshot);
  }
  function markDispatched() {
    if (!current || current.dispatched) return;
    const snapshot = load();
    const room = stateApi.roomById(snapshot, current.roomId);
    if (room?.recovery && !room.recovery.dispatched) {
      room.recovery.dispatched = true;
      save(snapshot); current.dispatched = true;
    }
  }
  async function dispatchOnline(target) {
    if (!current) return false;
    if (!isExtensionAvailable()) return parkCurrent('Extension bridge offline before dispatch.');
    const gate = await durability.beforeDispatch(
      { type: 'send_prompt', requestId: current.requestId },
      { targetClassId: 'online-origin', targetId: target.id, providerId: target.providerId }
    );
    if (!gate.ok) return failCurrent('Durable turn ledger blocked a duplicate online dispatch.', 'Duplicate dispatch blocked');
    markDispatched();
    current.phase = 'waiting';
    current.targetId = target.id;
    lease.begin();
    if (!sendExtension({
      type: 'send_prompt',
      requestId: current.requestId,
      text: current.prompt,
      targetClassId: 'online-origin'
    })) return parkCurrent('Extension bridge disconnected at the dispatch boundary.');
    broadcastEvent({ type: 'dex_scheduler_event', event: 'dispatch', requestId: current.requestId, roomId: current.roomId, memberId: current.memberId });
    return true;
  }

  async function dispatchLocal(target) {
    if (!current) return false;
    const turn = { ...current };
    const gate = await durability.beforeDispatch(
      { type: 'send_prompt', requestId: turn.requestId },
      { targetClassId: 'local-origin', targetId: target.id, providerId: target.providerId }
    );
    if (!gate.ok) return failCurrent('Durable turn ledger blocked a duplicate local dispatch.', 'Duplicate dispatch blocked');
    markDispatched();
    current.phase = 'waiting';
    current.targetId = target.id;
    lease.begin();
    try {
      await sendLocalPrompt({
        targetId: target.id,
        requestId: turn.requestId,
        text: turn.prompt,
        emit: async (payload) => {
          await durability.observe(payload, {
            targetClassId: 'local-origin', targetId: target.id, providerId: target.providerId
          }).catch(() => {});
          await handleTransportEvent(payload);
          broadcastEvent(payload);
        }
      });
    } catch (error) {
      const payload = { type: 'error', requestId: turn.requestId, code: error.code || 'LOCAL_TARGET_ERROR', message: error.message };
      await durability.observe?.(payload, { targetClassId: 'local-origin', targetId: target.id, providerId: target.providerId }).catch(() => {});
      await handleTransportEvent(payload);
    }
    return true;
  }

  async function routeCurrent() {
    if (!current) return false;
    const snapshot = load();
    const room = stateApi.roomById(snapshot, current.roomId);
    const member = stateApi.memberById(room, current.memberId);
    const source = stateApi.messageById(room, current.sourceMessageId);
    if (!room || !member || !source || !room.relay?.active) {
      clearCurrent();
      processSoon(0);
      return false;
    }

    current.prompt = protocol.buildRelayPrompt({
      room, member, recipient: member, sourceMessage: source,
      requestId: current.requestId,
      providerHealth: healthApi.roomContext(room, getOnlineTargets() || [])
    }); if (room.recovery) { room.recovery.expectedPrompt = current.prompt; save(snapshot); }

    if (member.binding?.targetClassId === 'local-origin') {
      const target = await localTarget(member);
      if (!target) return handleTurnError({ code: 'LOCAL_TARGET_NOT_FOUND', message: 'Local agent target is unavailable.' });
      return dispatchLocal(target);
    }

    if (!stateApi.supportsOperation(getProviders() || [], member.binding?.providerId, 'send')) {
      return handleTurnError({ code: 'PROVIDER_OPERATION_UNSUPPORTED', message: 'Bound provider does not declare send support in the active adapter contract.' });
    }
    const target = stateApi.resolveOnline(member, getOnlineTargets() || []);
    if (!target) {
      if (!member.binding?.providerId || !member.binding?.url) {
        return failCurrent('Online chat binding is incomplete and cannot be restored automatically.');
      }
      if (!isExtensionAvailable()) return parkCurrent('Extension bridge offline while restoring target.');
      current.phase = 'ensuring-online';
      if (!sendExtension({
        type: 'ensure_target', requestId: current.requestId,
        providerId: member.binding.providerId, url: member.binding.url
      })) return parkCurrent('Extension bridge disconnected while restoring target.');
      return true;
    }

    if (healthApi.blocking(target.health)) return failCurrent(healthApi.blockMessage(member, target.health), healthApi.stopReason(target.health));

    current.targetId = target.id;
    const selected = getSelectedOnlineTarget();
    if (selected && String(selected.id) === String(target.id) && selected.providerId === target.providerId) {
      return dispatchOnline(target);
    }

    if (!room.relay.restoreTarget && selected) {
      room.relay.restoreTarget = { id: selected.id, providerId: selected.providerId, url: selected.url || '' };
    }
    if (!isExtensionAvailable()) return parkCurrent('Extension bridge offline while selecting target.');
    current.phase = 'selecting';
    save(snapshot);
    if (!sendExtension({
      type: 'select_target', requestId: current.requestId,
      tabId: Number(target.id), providerId: target.providerId
    })) return parkCurrent('Extension bridge disconnected while selecting target.');
    return true;
  }

  async function process() {
    if (processing || current) return false;
    processing = true;
    try {
      const snapshot = load();
      if (recovery.hasWork(snapshot)) return recovery.resume(durability);
      const room = stateApi.duePendingRooms(snapshot, nowMs())[0];
      if (!room) {
        const delay = stateApi.nextPendingDelay(snapshot, nowMs());
        return delay == null ? maybeRestoreTarget(snapshot) : (processSoon(delay), false);
      }

      const pending = { ...room.pendingTurn };
      const member = stateApi.memberById(room, pending.memberId);
      const source = stateApi.messageById(room, pending.sourceMessageId);
      if (!member || !source) {
        delete room.pendingTurn;
        setStopped(room, 'Queued relay metadata is incomplete');
        save(snapshot);
        return false;
      }

      delete room.pendingTurn;
      current = {
        roomId: room.id, memberId: member.id,
        sourceMessageId: source.id, requestId: uid('dex-turn'),
        retryCount: Number(pending.retryCount || 0),
        phase: 'ready', targetId: null, prompt: ''
      };
      writeRecovery(snapshot, room, member);
      return routeCurrent();
    } finally {
      processing = false;
    }
  }

  function startRelay({ roomId, sourceMessageId, budget = null } = {}) {
    const snapshot = load();
    const room = stateApi.roomById(snapshot, roomId);
    const source = stateApi.messageById(room, sourceMessageId);
    if (!room || !source) return { ok: false, code: 'DEX_RELAY_SOURCE_NOT_FOUND', message: 'Relay source message is unavailable.' };
    if (current?.roomId === room.id || room.recovery || room.pendingTurn || room.relay?.waitingFor) {
      return { ok: false, code: 'DEX_RELAY_BUSY', message: 'That Dex room already has pending or active work.' };
    }
    if (!(room.members || []).some((member) => member.relayEnabled !== false)) {
      return { ok: false, code: 'DEX_RELAY_NO_AGENT', message: 'Add at least one participating agent before starting the room.' };
    }
    room.relay = room.relay || {};
    room.relay.active = true;
    room.relay.remaining = stateApi.safeBudget(budget ?? room.settings?.maxTurns, 8);
    room.relay.lastStopReason = 'Running';
    enqueueNext(room, source);
    save(snapshot);
    processSoon(0);
    return { ok: true, roomId };
  }

  function stopRelay({ roomId, reason = 'Stopped' } = {}) {
    const snapshot = load(), room = stateApi.roomById(snapshot, roomId);
    if (!room) return { ok: false, code: 'DEX_ROOM_NOT_FOUND', message: 'Dex room not found.' };
    const inFlight = current?.roomId === room.id && (current.phase === 'waiting' || !!room.recovery?.dispatched);
    if (inFlight) {
      if (room.recovery) Object.assign(room.recovery, { stopRequested: true, stopReason: reason, relayActive: false, relayRemaining: 0 });
      stateApi.requestStop(room, reason, now()); save(snapshot);
      return { ok: true, roomId, inFlight: true };
    }
    if (current?.roomId === room.id) clearCurrent();
    setStopped(room, reason); save(snapshot); processSoon(0);
    return { ok: true, roomId, inFlight: false };
  }
  function continueRelay({ roomId, budget = null } = {}) {
    const room = stateApi.roomById(load(), roomId), source = (room?.messages || []).at(-1);
    return !room || !source
      ? { ok: false, code: 'DEX_RELAY_NO_MESSAGES', message: 'Continue relay requires a room message.' }
      : startRelay({ roomId, sourceMessageId: source.id, budget });
  }

  async function handleTurnError(msg = {}) {
    if (!current) return false;
    const snapshot = load();
    const room = stateApi.roomById(snapshot, current.roomId);
    const member = stateApi.memberById(room, current.memberId);
    const source = stateApi.messageById(room, current.sourceMessageId);
    if (!room || !member || !source) return false;
    const decision = failurePolicy.decision(msg.code, {
      dispatched: !!room.recovery?.dispatched,
      retryCount: Number(current.retryCount || 0)
    });
    if (decision.retry && !room.recovery?.dispatched) {
      const retryCount = Number(current.retryCount || 0) + 1, delayMs = Number(decision.delayMs || 0);
      clearCurrent(); delete room.recovery;
      room.relay.lastStopReason = `Transient ${msg.code} · retry ${retryCount}/${decision.maxAttempts}`;
      stateApi.queueTurn(room, member, source, now(), retryCount, new Date(nowMs() + delayMs).toISOString());
      save(snapshot); processSoon(delayMs); return true;
    }
    if (decision.action === 'recover') {
      parkCurrent(`${msg.code || 'RELAY_ERROR'} requires capture recovery.`);
      processSoon(decision.delayMs || 0);
      return true;
    }
    if (decision.action === 'incident') recordIncident({
      code: msg.code || 'RELAY_ERROR', message: msg.message || '', roomId: room.id,
      memberId: member.id, requestId: current.requestId, source: 'server-scheduler',
      evidence: { phase: current.phase, retryCount: current.retryCount }
    });
    return failCurrent(
      `${msg.code || 'ERROR'}: ${msg.message || 'Unknown error'}`,
      decision.action === 'pause' ? 'Provider or transport action required' : 'Relay error'
    );
  }

  function failCurrent(message, stopReason = 'Relay error') {
    if (!current) return false;
    const snapshot = load();
    const room = stateApi.roomById(snapshot, current.roomId);
    const member = stateApi.memberById(room, current.memberId);
    if (room) {
      addMessage(room, {
        senderKind: 'system', senderId: null,
        senderName: 'Dex', text: `${member?.name || 'Agent'}: ${message}`
      });
      setStopped(room, stopReason);
      save(snapshot);
    }
    clearCurrent();
    processSoon(0);
    return false;
  }

  function completeTurn(text) {
    if (!current) return false;
    const snapshot = load();
    const room = stateApi.roomById(snapshot, current.roomId);
    const member = stateApi.memberById(room, current.memberId);
    if (!room || !member) return false;
    const parsed = protocol.parseAgentReply(text);
    const repeated = protocol.isRepeatedReply(room.messages, parsed.text);
    const sourceMessage = stateApi.messageById(room, current.sourceMessageId);
    const message = addMessage(room, {
      senderKind: 'agent', senderId: member.id,
      senderName: member.name, text: parsed.text || '(No textual response.)'
    });
    if (parsed.providerControlCommand) controlReceiptApi.rememberIntent(room, { executorMember: member, sourceMessage, command: parsed.providerControlCommand, agentMessage: message, turnRequestId: current.requestId, at: now() });
    delete room.recovery;
    room.relay.waitingFor = null;
    const disposition = protocol.relayDisposition(parsed, member.name, repeated, room.relay);
    if (parsed.returnRequestId && parsed.returnRequestId !== current.requestId) return false;
    if (parsed.done) doneWatchApi.consume(room, { completedMemberId: member.id, message, at: now() });
    if (parsed.headsUpTarget || parsed.headsUpInvalid) doneWatchApi.emitHeadsUp(room, { senderMemberId: member.id, targetRef: parsed.headsUpTarget, invalid: parsed.headsUpInvalid, done: parsed.done, message, at: now() });
    stateApi.rememberFinalReceipt(room, current.requestId, message.id, now());
    clearCurrent();
    if (disposition.action === 'stop') setStopped(room, disposition.reason);
    else enqueueNext(room, message);
    save(snapshot);
    processSoon(0);
    try { onTurnSettled(); } catch {}
    return true;
  }

  async function handleTransportEvent(msg = {}) {
    if (recovery.handleEvent(msg)) return true;
    if (msg.type === 'provider_health_update' && current) {
      const snapshot = load();
      const room = stateApi.roomById(snapshot, current.roomId);
      const member = stateApi.memberById(room, current.memberId);
      if (String(current.targetId) === String(msg.tabId) && healthApi.blocking(msg.health)) {
        return failCurrent(healthApi.blockMessage(member, msg.health), healthApi.stopReason(msg.health));
      }
    }
    if (!current || msg.requestId !== current.requestId) return false;
    if (msg.type === 'target_ensured' && current.phase === 'ensuring-online') {
      if (!msg.target?.id) return failCurrent('Restored provider target did not include a usable tab.');
      current.targetId = msg.target.id;
      return dispatchOnline(msg.target);
    }
    if (msg.type === 'target_selected' && current.phase === 'selecting'
        && String(msg.target?.id) === String(current.targetId)) {
      return dispatchOnline(msg.target);
    }
    const activity = activityFromTransport(msg);
    if (activity) {
      markDispatched();
      lease.touch(activity);
      return true;
    }
    if (msg.type === 'response_final') return completeTurn(msg.text || '');
    if (msg.type === 'error') return handleTurnError(msg);
    return false;
  }

  async function maybeRestoreTarget(snapshot = load()) {
    if (current || recovery.hasWork(snapshot) || stateApi.pendingRooms(snapshot).length
        || (snapshot.rooms || []).some((room) => room.relay?.active)) return false;
    const room = (snapshot.rooms || []).find((entry) => entry.relay?.restoreTarget);
    const restore = room?.relay?.restoreTarget;
    if (!room || !restore) return false;
    delete room.relay.restoreTarget;
    save(snapshot);
    const tabs = getOnlineTargets() || [];
    const target = tabs.find((tab) => String(tab.id) === String(restore.id) && tab.providerId === restore.providerId)
      || tabs.find((tab) => tab.providerId === restore.providerId && restore.url && tab.url === restore.url);
    if (!target) return false;
    return sendExtension({
      type: 'select_target', requestId: uid('dex-restore'),
      tabId: Number(target.id), providerId: target.providerId
    });
  }

  function onStateChanged() { if (!current) processSoon(0); }

  function parkCurrent(reason = 'Provider transport interrupted.') {
    if (!current) return false;
    const snapshot = load(), room = stateApi.roomById(snapshot, current.roomId);
    if (room?.recovery) {
      room.recovery.interruptedAt = now();
      Object.assign(room.relay, { active: false, waitingFor: null, remaining: 0 });
      room.relay.lastStopReason = room.recovery.dispatched
        ? `recovering interrupted turn · ${reason}`
        : `reconciling durable dispatch ledger · ${reason}`;
      save(snapshot);
    }
    clearCurrent();
    broadcastEvent({ type: 'dex_scheduler_event', event: 'parked', roomId: room?.id || null, reason });
    return true;
  }

  function transportLost() { recovery.transportLost(); return current ? parkCurrent('Provider transport disconnected.') : true; }

  function resume() { processSoon(0); }

  function diagnostics() {
    const snapshot = load();
    const activeRoom = current ? stateApi.roomById(snapshot, current.roomId) : null;
    const active = current ? {
      roomId: current.roomId, memberId: current.memberId, requestId: current.requestId,
      phase: current.phase, retryCount: current.retryCount || 0,
      targetId: current.targetId || null,
      ...(lease.diagnostics() || {}),
      dispatched: !!activeRoom?.recovery?.dispatched,
      recoveryPending: !!activeRoom?.recovery
    } : null;
    return { owner: 'localhost', current: active,
      pendingRooms: stateApi.pendingRooms(snapshot).map((room) => room.id),
      recoveryRooms: (snapshot.rooms || []).filter((room) => !!room.recovery).map((room) => room.id),
      recovery: recovery.diagnostics() };
  }

  return {
    startRelay, stopRelay, continueRelay,
    handleTransportEvent, onStateChanged, transportLost, resume, process, resolvePassiveRecovery: (input) => recovery.resolvePassive(input), diagnostics
  };
}
module.exports = { TURN_TIMEOUT_MS, TURN_IDLE_TIMEOUT_MS, TURN_ABSOLUTE_TIMEOUT_MS, createDexServerScheduler };