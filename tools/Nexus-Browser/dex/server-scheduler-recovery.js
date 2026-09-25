const protocol = require('../public/dex-protocol');
const failurePolicy = require('../public/dex-failure-policy');
const stateApi = require('./server-scheduler-state');
const controlReceiptApi = require('./provider-control-receipt');

const RETRY_MS = 10000;
const STABLE_MS = 1200;
const UNCERTAIN_STABLE_MS = 60 * 1000;
const MAX_RECOVERY_MS = 11 * 60 * 1000;

function createServerSchedulerRecovery({
  load, save, uid, nowMs = () => Date.now(),
  getOnlineTargets = () => [], getProviders = () => [], getSelectedOnlineTarget = () => null,
  getLocalTargets = async () => [], isExtensionAvailable = () => true, sendExtension = () => false,
  captureLocalLatest, recordIncident = () => {}, markTimedOut = () => Promise.resolve(),
  addMessage, enqueueNext, setStopped, processSoon, onRecovered = () => {}, onTurnSettled = () => {}
} = {}) {
  let active = null;

  function hasWork(snapshot = load()) {
    return !!active || (snapshot.rooms || []).some((room) => !!room.recovery && !room.recovery.passiveAt);
  }

  function timedOut(recovery) {
    if (recovery?.passiveAt) return false;
    const started = Date.parse(recovery?.interruptedAt || recovery?.startedAt || '');
    return Number.isFinite(started) && nowMs() - started > MAX_RECOVERY_MS;
  }

  function expire(room, recovery) {
    const reason = 'Interrupted turn recovery timed out · awaiting late provider final';
    recovery.passiveAt = new Date(nowMs()).toISOString();
    recovery.captureRequestId = null;
    recovery.ensureTargetRequestId = null;
    recovery.selectingTargetId = null;
    recovery.stopRequested = true;
    recovery.stopReason = reason;
    recovery.relayActive = false;
    recovery.relayRemaining = 0;
    room.relay = room.relay || {};
    Object.assign(room.relay, { active: false, remaining: 0, waitingFor: null, lastStopReason: reason });
    delete room.pendingTurn;
    recordIncident({
      code: 'RECOVERY_TIMEOUT', roomId: room.id,
      memberId: recovery?.memberId || null,
      requestId: recovery?.requestId || null,
      source: 'server-scheduler',
      evidence: { passiveLateFinalWatch: true }
    });
    Promise.resolve(markTimedOut(recovery)).catch(() => {});
  }

  async function resolveLocal(member) {
    const targets = await getLocalTargets(true);
    return stateApi.resolveLocal(member, targets);
  }

  function clearActive() { active = null; }

  function resolvePassive({ roomId, requestId, reason = 'Externally reconciled' } = {}) {
    if (active?.roomId === roomId) return { ok: false, code: 'RECOVERY_ACTIVE', message: 'Recovery worker is still active.' };
    const snapshot = load();
    const room = stateApi.roomById(snapshot, roomId);
    const recovery = room?.recovery;
    if (!room) return { ok: false, code: 'RECOVERY_ROOM_NOT_FOUND', message: 'Dex room not found.' };
    if (!recovery) return { ok: false, code: 'RECOVERY_NOT_FOUND', message: 'That room has no recovery journal.' };
    if (String(recovery.requestId || '') !== String(requestId || '')) {
      return { ok: false, code: 'RECOVERY_REQUEST_MISMATCH', message: 'Recovery request id does not match the room journal.' };
    }
    if (!recovery.passiveAt) {
      return { ok: false, code: 'RECOVERY_NOT_PASSIVE', message: 'Only timed-out passive recovery may be resolved manually.' };
    }
    if (room.relay?.active || room.pendingTurn) {
      return { ok: false, code: 'RECOVERY_ROOM_BUSY', message: 'Room is active or has a pending turn.' };
    }
    const resolved = {
      roomId: room.id, requestId: recovery.requestId,
      memberId: recovery.memberId || null, passiveAt: recovery.passiveAt
    };
    delete room.recovery;
    room.relay = room.relay || {};
    Object.assign(room.relay, {
      active: false, remaining: 0, waitingFor: null,
      lastStopReason: `Passive recovery resolved · ${String(reason || 'Externally reconciled').slice(0, 160)}`
    });
    save(snapshot);
    processSoon(0);
    return { ok: true, code: 'RECOVERY_PASSIVE_RESOLVED', message: 'Passive recovery journal resolved without replay.', data: resolved };
  }

  function transportLost() {
    if (!active) return false;
    const snapshot = load();
    const room = stateApi.roomById(snapshot, active.roomId);
    const recovery = room?.recovery;
    if (recovery) {
      recovery.captureRequestId = null;
      recovery.ensureTargetRequestId = null;
      recovery.selectingTargetId = null;
      save(snapshot);
    }
    clearActive();
    return true;
  }

  async function start(room, recovery) {
    if (recovery?.passiveAt) return false;
    active = {
      roomId: room.id,
      memberId: recovery.memberId,
      sourceMessageId: recovery.sourceMessageId,
      requestId: recovery.requestId
    };
    return capture();
  }

  async function capture() {
    if (!active) return false;
    const snapshot = load();
    const room = stateApi.roomById(snapshot, active.roomId);
    const recovery = room?.recovery;
    const member = stateApi.memberById(room, recovery?.memberId);
    if (!room || !recovery || !member) {
      clearActive();
      return false;
    }
    if (timedOut(recovery)) {
      expire(room, recovery);
      save(snapshot);
      clearActive();
      return false;
    }

    if (recovery.targetClassId === 'local-origin') {
      const target = await resolveLocal(member);
      if (!target) {
        clearActive();
        processSoon(RETRY_MS);
        return false;
      }
      try {
        const result = await captureLocalLatest({ targetId: target.id });
        return finish(result || { text: '' }, true);
      } catch {
        clearActive();
        processSoon(RETRY_MS);
        return false;
      }
    }

    if (!isExtensionAvailable()) {
      clearActive();
      return false;
    }
    const providers = getProviders() || [];
    if (!stateApi.supportsOperation(providers, recovery.providerId, 'recover')
        || !stateApi.supportsOperation(providers, recovery.providerId, 'captureLatest')) {
      setStopped(room, 'Provider recovery contract is unsupported · incident recorded');
      recordIncident({
        code: 'PROVIDER_OPERATION_UNSUPPORTED', roomId: room.id,
        memberId: recovery.memberId, requestId: recovery.requestId,
        source: 'server-scheduler', evidence: { required: ['recover', 'captureLatest'], providerId: recovery.providerId }
      });
      save(snapshot);
      clearActive();
      return false;
    }
    const target = stateApi.resolveOnline(member, getOnlineTargets() || []);
    if (!target) {
      if (!recovery.ensureTargetRequestId && member.binding?.url && member.binding?.providerId) {
        recovery.ensureTargetRequestId = uid('dex-ensure');
        save(snapshot);
        if (!sendExtension({
          type: 'ensure_target',
          requestId: recovery.ensureTargetRequestId,
          providerId: member.binding.providerId,
          url: member.binding.url
        })) {
          recovery.ensureTargetRequestId = null;
          save(snapshot);
          clearActive();
          return false;
        }
        return true;
      }
      clearActive();
      processSoon(RETRY_MS);
      return false;
    }

    const requestId = uid('dex-recover');
    recovery.captureRequestId = requestId;
    const selected = getSelectedOnlineTarget();
    if (selected && String(selected.id) === String(target.id) && selected.providerId === target.providerId) {
      save(snapshot);
      if (!sendExtension({ type: 'capture_latest', requestId, expectedPrompt: recovery.expectedPrompt || '' })) {
        recovery.captureRequestId = null;
        save(snapshot);
        clearActive();
        return false;
      }
    } else {
      recovery.selectingTargetId = String(target.id);
      save(snapshot);
      if (!sendExtension({
        type: 'select_target', requestId,
        tabId: Number(target.id), providerId: target.providerId
      })) {
        recovery.captureRequestId = null;
        recovery.selectingTargetId = null;
        save(snapshot);
        clearActive();
        return false;
      }
    }
    return true;
  }

  function finish(capture, local = false, authoritative = false) {
    if (!active) return false;
    const snapshot = load();
    const room = stateApi.roomById(snapshot, active.roomId);
    const recovery = room?.recovery;
    const member = stateApi.memberById(room, recovery?.memberId);
    if (!room || !recovery || !member) return false;

    const observed = typeof capture === 'string' ? { text: capture } : (capture || {});
    const generationState = observed.generationState
      || (observed.isGenerating === true ? 'active' : observed.isGenerating === false ? 'idle' : 'unknown');
    recovery.lastCaptureObservedAt = observed.observedAt || null;
    recovery.lastCaptureGenerationState = generationState;
    recovery.lastCaptureCompletenessHint = observed.completenessHint || null;

    if (!local && !authoritative && (observed.isGenerating === true || generationState === 'active')) {
      recovery.captureRequestId = null;
      recovery.candidateText = null;
      recovery.candidateAt = 0;
      save(snapshot);
      clearActive();
      processSoon(RETRY_MS);
      return false;
    }

    const parsed = protocol.parseAgentReply(observed.text || '');
    const body = protocol.cleanText(parsed.text);
    if (!body) {
      recovery.captureRequestId = null;
      save(snapshot);
      clearActive();
      processSoon(RETRY_MS);
      return false;
    }

    const hint = String(observed.completenessHint || '').toLowerCase();
    if (!local && !authoritative && hint === 'incomplete') {
      recovery.captureRequestId = null;
      recovery.candidateText = null;
      recovery.candidateAt = 0;
      save(snapshot);
      clearActive();
      processSoon(RETRY_MS);
      return false;
    }

    const prior = stateApi.priorReply(room, member, recovery.sourceMessageId);
    if (prior && protocol.cleanText(prior.text) === body) {
      recovery.captureRequestId = null;
      recovery.candidateText = null;
      recovery.candidateAt = 0;
      save(snapshot);
      clearActive();
      processSoon(RETRY_MS);
      return false;
    }

    if (!local && !authoritative) {
      const stamp = nowMs();
      const requiredStableMs = hint === 'complete' || hint === 'settled' ? STABLE_MS : UNCERTAIN_STABLE_MS;
      if (recovery.candidateText !== body || !recovery.candidateAt) {
        recovery.candidateText = body;
        recovery.candidateAt = stamp;
        recovery.captureRequestId = null;
        save(snapshot);
        clearActive();
        processSoon(1400);
        return false;
      }
      if (stamp - recovery.candidateAt < requiredStableMs) {
        recovery.captureRequestId = null;
        save(snapshot);
        clearActive();
        processSoon(1400);
        return false;
      }
    }

    const repeated = protocol.isRepeatedReply(room.messages, body);
    const requestedStopReason = recovery.stopRequested
      ? (recovery.stopReason || room.relay?.lastStopReason || 'Stopped')
      : null;
    room.relay.active = requestedStopReason ? false : !!recovery.relayActive;
    room.relay.remaining = requestedStopReason ? 0 : Number(recovery.relayRemaining || 0);
    room.relay.waitingFor = null;
    const sourceMessage = stateApi.messageById(room, recovery.sourceMessageId);
    delete room.recovery;
    const message = addMessage(room, {
      senderKind: 'agent', senderId: member.id,
      senderName: member.name, text: body
    });
    if (parsed.providerControlCommand) controlReceiptApi.rememberIntent(room, {
      executorMember: member, sourceMessage, command: parsed.providerControlCommand,
      agentMessage: message, turnRequestId: recovery.requestId, at: new Date(nowMs()).toISOString()
    });
    const disposition = protocol.relayDisposition(parsed, member.name, repeated, room.relay);
    try { onRecovered({ room, member, message, parsed }); } catch {}
    clearActive();
    if (requestedStopReason) setStopped(room, requestedStopReason);
    else if (disposition.action === 'stop') setStopped(room, `Recovered · ${disposition.reason}`);
    else enqueueNext(room, message);
    save(snapshot);
    processSoon(0);
    try { onTurnSettled(); } catch {}
    return true;
  }

  async function resume(durability) {
    if (active) return false;
    const snapshot = load();
    const room = (snapshot.rooms || []).find((entry) => entry.recovery && !entry.recovery.passiveAt);
    const recovery = room?.recovery;
    if (!room || !recovery) return false;
    if (timedOut(recovery)) {
      expire(room, recovery);
      save(snapshot);
      return false;
    }

    const ledger = durability.query(recovery.requestId);
    if (ledger.entry && failurePolicy.dispatchMayHaveOccurred(ledger.entry.state)) {
      recovery.dispatched = true;
      save(snapshot);
      return start(room, recovery);
    }

    if (ledger.reliable === true && !ledger.entry) {
      const member = stateApi.memberById(room, recovery.memberId);
      const source = stateApi.messageById(room, recovery.sourceMessageId);
      if (!member || !source) {
        setStopped(room, 'Interrupted turn recovery metadata is incomplete');
        save(snapshot);
        return false;
      }
      room.relay.active = !!recovery.relayActive;
      room.relay.remaining = Number(recovery.relayRemaining || 0);
      room.relay.waitingFor = member.id;
      const retryCount = Number(recovery.retryCount || 0);
      delete room.recovery;
      stateApi.queueTurn(room, member, source, new Date().toISOString(), retryCount);
      save(snapshot);
      processSoon(0);
      return true;
    }
    setStopped(room, 'Dispatch ledger unavailable or uncertain · no automatic replay');
    recordIncident({
      code: 'TURN_LEDGER_UNCERTAIN',
      roomId: room.id,
      memberId: recovery.memberId,
      requestId: recovery.requestId,
      source: 'server-scheduler'
    });
    save(snapshot);
    return false;
  }
  function handleEvent(msg) {
    const terminalType = ['response', 'final'].join('_');
    if (msg?.type === terminalType) {
      const snapshot = load();
      const room = (snapshot.rooms || []).find((entry) => entry.recovery?.requestId === msg.requestId);
      const journal = room?.recovery;
      const recovering = !!journal?.interruptedAt || active?.roomId === room?.id;
      if (room && journal && recovering && (!active || active.roomId === room.id)) {
        if (!active) active = {
          roomId: room.id,
          memberId: journal.memberId,
          sourceMessageId: journal.sourceMessageId,
          requestId: journal.requestId
        };
        finish({
          text: msg.text || '',
          isGenerating: false,
          generationState: 'idle',
          completenessHint: 'complete',
          observedAt: msg.observedAt || null
        }, false, true);
        return true;
      }
    }
    if (!active) return false;
    const snapshot = load();
    const room = stateApi.roomById(snapshot, active.roomId);
    const recovery = room?.recovery;
    if (!recovery) return false;
    if (msg.type === 'target_ensured' && msg.requestId === recovery.ensureTargetRequestId) {
      recovery.ensureTargetRequestId = null;
      save(snapshot);
      clearActive();
      processSoon(0);
      return true;
    }
    if (msg.type === 'target_selected' && recovery.selectingTargetId
        && String(msg.target?.id) === String(recovery.selectingTargetId)) {
      recovery.selectingTargetId = null;
      save(snapshot);
      if (!sendExtension({ type: 'capture_latest', requestId: recovery.captureRequestId, expectedPrompt: recovery.expectedPrompt || '' })) {
        recovery.captureRequestId = null;
        save(snapshot);
        clearActive();
        return false;
      }
      return true;
    }
    if (msg.requestId !== recovery.captureRequestId) return false;
    if (msg.type === 'capture_result') return finish(msg, false);
    if (msg.type === 'error') {
      recovery.captureRequestId = null;
      save(snapshot);
      clearActive();
      processSoon(RETRY_MS);
      return true;
    }
    return false;
  }
  return { hasWork, resume, handleEvent, capture, transportLost, resolvePassive, diagnostics: () => ({ active: active ? { ...active } : null }) };
}
module.exports = { RETRY_MS, STABLE_MS, UNCERTAIN_STABLE_MS, MAX_RECOVERY_MS, createServerSchedulerRecovery };