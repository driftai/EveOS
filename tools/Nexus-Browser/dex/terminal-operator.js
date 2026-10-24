'use strict';
// Single-room, local-terminal, user-originating Dex messages. The existing
// Dex scheduler and durable room store retain ownership of execution/delivery.
// No agent impersonation, grant, second scheduler, command replay, or publisher.
const { randomUUID, createHash } = require('node:crypto');
const { addMessage, roomById } = require('./server-scheduler-state');
const { runtimeBusy } = require('./server-state-merge');
const { bootstrap, proofRoom } = require('./terminal-provision');
const { stateFor } = require('./terminal-turn-outcome');

const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/;
const ROOM_ID = /^room-[A-Za-z0-9_-]{6,125}$/;
const TLO_BINDING = Object.freeze({ targetClassId: 'local-origin', targetId: 'local:tlo-chat:default', providerId: 'tlo-chat' });
const MAX_TEXT = 1800;
function failure(code, message) { return { ok: false, code, message }; }
function exactTlo(room) {
  const enabled = (room?.members || []).filter(m => m.relayEnabled !== false);
  if (enabled.length !== 1) return null;
  const m = enabled[0], b = m.binding || {};
  return b.targetClassId === TLO_BINDING.targetClassId && b.targetId === TLO_BINDING.targetId && b.providerId === TLO_BINDING.providerId ? m : null;
}
function spaceFor(room) {
  const candidates = room?.machineSpaces?.spaces || [];
  const attached = candidates.filter(s => s && s.archived !== true && Array.isArray(s.resourceIds) && s.resourceIds.length);
  return attached.length === 1 ? attached[0] : null;
}
function summary(room, targetAvailable = () => true) {
  const tlo = exactTlo(room), space = spaceFor(room);
  const machineSpaceLive = !!space?.resourceIds?.some(id => targetAvailable(id) === true);
  return { roomId: room.id, roomName: String(room.name || '').slice(0, 80),
    userName: String(room.userName || 'User').slice(0, 48),
    tloMemberId: tlo?.id || null, machineSpaceId: space?.id || null,
    machineSpaceLive,
    active: !!room.relay?.active, busy: runtimeBusy(room),
    recoveryPending: !!room.recovery, lastStopReason: String(room.relay?.lastStopReason || '').slice(0, 120),
    engineeringIncidentCount: (room.engineeringIncidentReceipts || []).length,
    messageCount: (room.messages || []).length };
}
function engineeringEvidence(message) {
  const verification = message?.engineeringVerification;
  const completion = message?.engineeringCompletion;
  return {
    ...(verification?.schema === 'eveos.machine-spaces.engineering-verification.v1' ? { engineeringVerification: {
      schema: verification.schema, jobId: String(verification.jobId || '').slice(0, 160),
      state: String(verification.state || '').slice(0, 32), exitCode: Number(verification.exitCode),
      outputId: String(verification.outputId || '').slice(0, 160), outcome: String(verification.outcome || '').slice(0, 32),
      receipt: String(verification.receipt || '').slice(0, 300)
    } } : {}),
    ...(typeof completion?.ok === 'boolean' ? { engineeringCompletion: {
      ok: completion.ok, code: String(completion.code || '').slice(0, 80),
      jobId: String(completion.jobId || '').slice(0, 160), outputId: String(completion.outputId || '').slice(0, 160),
      receipt: String(completion.receipt || '').slice(0, 300)
    } } : {})
  };
}
function projection(room, { limit = 10, targetAvailable } = {}) {
  const n = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 20)) : 10;
  return { ...summary(room, targetAvailable), engineeringIncidents: (room.engineeringIncidentReceipts || []).slice(-10).map(entry => ({
    jobId: entry.jobId, requestId: entry.requestId, state: entry.state, classification: entry.classification,
    middleAgentMemberId: entry.middleAgentMemberId, dispatch: entry.dispatch, createdAt: entry.createdAt
  })), messages: (room.messages || []).slice(-n).map(m => ({
    id: m.id, at: m.at || null, senderKind: m.senderKind,
    senderName: String(m.senderName || '').slice(0, 60),
    text: String(m.text || '').slice(0, MAX_TEXT),
    ...(m.clientRequestId ? { clientRequestId: m.clientRequestId } : {}),
    ...engineeringEvidence(m)
  })) };
}
function createTerminalOperator({ load, save, scheduler, broadcastState = () => {}, maintenanceBusy = () => false, targetAvailable = () => true, machineBroker = null, viewerLease = null, repoRoot = null, now = () => new Date().toISOString(), uid = randomUUID } = {}) {
  if (typeof load !== 'function' || typeof save !== 'function' || !scheduler?.startRelay)
    throw new TypeError('terminal operator requires the existing Dex state store and scheduler');
  function exactRoom(snapshot, roomId) {
    if (typeof roomId !== 'string' || !ROOM_ID.test(roomId)) return null;
    return roomById(snapshot, roomId);
  }
  function handle(msg = {}) {
    const action = String(msg.type || '');
    const requestId = String(msg.requestId || '');
    if (!ID.test(requestId)) return failure('DEX_TERMINAL_BAD_ID', 'Use one stable opaque request ID (8-128 characters).');
    if (action === 'dex_terminal_viewer_standby') {
      if (!viewerLease?.begin) return failure('DEX_VIEWER_LEASE_UNAVAILABLE', 'The server-owned Dex viewer lease is unavailable.');
      return viewerLease.begin({ requestId, durationSeconds: msg.durationSeconds });
    }
    const snapshot = load();
    if (action === 'dex_terminal_bootstrap') return bootstrap({ requestId, roomName: Object.hasOwn(msg, 'roomName') ? msg.roomName : undefined,
      load, save, broker: machineBroker, repoRoot, broadcastState, now });
    if (action === 'dex_terminal_rooms') return { ok: true, action: 'rooms', rooms: (snapshot?.rooms || []).slice(0, 32).map(room => summary(room, targetAvailable)) };
    const room = exactRoom(snapshot, msg.roomId);
    if (!room) return failure('DEX_TERMINAL_ROOM_REQUIRED', 'Provide an exact existing room ID, not a room name.');
    if (action === 'dex_terminal_inspect') return { ok: true, action: 'inspect', ...projection(room, { limit: msg.limit, targetAvailable }) };
    if (action === 'dex_terminal_check') return stateFor(room, String(msg.lookupId || requestId), scheduler.terminalLiveState?.(room.id));
    if (!['dex_terminal_send', 'dex_terminal_room_send'].includes(action)) return failure('DEX_TERMINAL_BAD_ACTION', 'Unsupported terminal operator command.');
    const text = msg.text;
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
      return failure('DEX_TERMINAL_BAD_TEXT', 'Provide bounded plain-text mission content.');
    // Durable dedupe is based on the exact committed user message, not in-memory state.
    const previous = (room.messages || []).filter(m => m.clientRequestId === requestId);
    if (previous.length) {
      if (previous.length !== 1 || previous[0].senderKind !== 'user' || previous[0].text !== text.trim())
        return failure('DEX_TERMINAL_REQUEST_CONFLICT', 'Request ID already owns different content.');
      return { ...stateFor(room, requestId), deduplicated: true };
    }
    if (maintenanceBusy()) return failure('DEX_TERMINAL_MAINTENANCE_BUSY', 'Maintenance owns the dispatch lease.');
    if (runtimeBusy(room)) return failure('DEX_TERMINAL_ROOM_BUSY', 'Room has pending work; never dispatch over uncertain work.');
    const tlo = exactTlo(room);
    if (action === 'dex_terminal_send' || room.terminalBootstrap) {
      if (!tlo) return failure('DEX_TERMINAL_TLO_ONLY', 'Require exactly one relay-enabled TLO member in this proof room.');
    }
    if (action === 'dex_terminal_room_send' && !(room.members || []).some(m => m.relayEnabled !== false))
      return failure('DEX_TERMINAL_NO_AGENT', 'The selected room has no enabled participants.');
    // Do not bypass the TLO proof-room attachment rule through the general chat route.
    if (tlo) {
      let attachedSpace = spaceFor(room);
      if ((!attachedSpace || !attachedSpace.resourceIds.some(id => targetAvailable(id) === true))
          && proofRoom(room) && machineBroker?.createSession && repoRoot) {
        attachedSpace = (room.machineSpaces?.spaces || []).find(space => space?.id === room.terminalBootstrap.spaceId && space.archived !== true) || null;
        if (attachedSpace) {
          try {
            const target = machineBroker.createSession({ type: 'powershell', cwd: repoRoot, label: 'TLO Proof (no grants)' });
            attachedSpace.resourceIds = [target.id];
            room.terminalBootstrap.targetId = target.id;
          } catch {}
        }
      }
      if (!attachedSpace || !attachedSpace.resourceIds.some(id => targetAvailable(id) === true))
        return failure('DEX_TERMINAL_MACHINE_SPACE_REQUIRED', 'Require a Machine Space with a live attached terminal target.');
    }
    const at = now();
    const message = addMessage(room, { id: `msg-${uid()}`, senderKind: 'user', senderId: 'user',
      senderName: String(room.userName || 'Local operator').slice(0, 48), text, at });
    message.clientRequestId = requestId;
    // State is persisted before starting the existing scheduler. An uncertain
    // ACK means inspect this same requestId: never resend under a new ID.
    const committed = save(snapshot);
    broadcastState(committed);
    const result = scheduler.startRelay({ roomId: room.id, sourceMessageId: message.id, budget: 1 });
    if (!result?.ok) return { ...failure('DEX_TERMINAL_RELAY_NOT_STARTED', result?.message || 'Relay admission failed.'),
      messageCommitted: true, messageId: message.id, requestId, retryForbidden: true };
    return { ok: true, requestId, roomId: room.id, messageId: message.id,
      status: 'MESSAGE_COMMITTED_RELAY_ACCEPTED', agent: tlo ? 'TLO' : 'Dex room',
      machineSpaceId: spaceFor(room)?.id || null, deliveryConfirmed: false };
  }
  return { handle };
}
module.exports = { TLO_BINDING, MAX_TEXT, exactTlo, spaceFor, summary, projection, stateFor, createTerminalOperator };
