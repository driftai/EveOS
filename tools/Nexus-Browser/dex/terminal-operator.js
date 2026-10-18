'use strict';
// Single-room, local-terminal, user-originating Dex messages. The existing
// Dex scheduler and durable room store retain ownership of execution/delivery.
// No agent impersonation, grant, second scheduler, command replay, or publisher.
const { randomUUID, createHash } = require('node:crypto');
const { addMessage, roomById } = require('./server-scheduler-state');
const { runtimeBusy } = require('./server-state-merge');

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
function summary(room) {
  const tlo = exactTlo(room), space = spaceFor(room);
  return { roomId: room.id, roomName: String(room.name || '').slice(0, 80),
    tloMemberId: tlo?.id || null, machineSpaceId: space?.id || null,
    active: !!room.relay?.active, busy: runtimeBusy(room),
    recoveryPending: !!room.recovery, lastStopReason: String(room.relay?.lastStopReason || '').slice(0, 120),
    messageCount: (room.messages || []).length };
}
function projection(room, { limit = 10 } = {}) {
  const n = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 20)) : 10;
  return { ...summary(room), messages: (room.messages || []).slice(-n).map(m => ({
    id: m.id, at: m.at || null, senderKind: m.senderKind,
    senderName: String(m.senderName || '').slice(0, 60),
    text: String(m.text || '').slice(0, MAX_TEXT),
    ...(m.clientRequestId ? { clientRequestId: m.clientRequestId } : {})
  })) };
}
function stateFor(room, requestId) {
  const messages = room.messages || [];
  const originIndex = messages.findIndex(m => m.senderKind === 'user' && m.clientRequestId === requestId);
  if (originIndex < 0) return failure('DEX_TERMINAL_UNKNOWN_REQUEST', 'No committed message for this exact request ID.');
  const origin = messages[originIndex], member = exactTlo(room);
  // Stop at the next user message: a later unrelated TLO response must never
  // be attributed to an earlier request whose completion was uncertain.
  const nextUser = messages.findIndex((m, i) => i > originIndex && m.senderKind === 'user');
  const segment = messages.slice(originIndex + 1, nextUser < 0 ? undefined : nextUser);
  const response = member && segment.find(m => m.senderKind === 'agent' && m.senderId === member.id);
  const final = response && (room.finalReceipts || []).find(r => r.messageId === response.id);
  return { ok: true, requestId, roomId: room.id, messageId: origin.id,
    status: final ? 'FINAL_RECEIPT_CONFIRMED' : response ? 'REPLY_OBSERVED_NOT_FINAL' : 'AWAITING_REPLY_OR_RECOVERY',
    finalRequestId: final?.requestId || null,
    response: response ? { id: response.id, at: response.at || null, text: String(response.text || '').slice(0, MAX_TEXT) } : null,
    recoveryPending: !!room.recovery, relayActive: !!room.relay?.active,
    lastStopReason: String(room.relay?.lastStopReason || '').slice(0, 120) };
}
function createTerminalOperator({ load, save, scheduler, broadcastState = () => {}, maintenanceBusy = () => false, targetAvailable = () => true, now = () => new Date().toISOString(), uid = randomUUID } = {}) {
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
    const snapshot = load();
    if (action === 'dex_terminal_rooms') return { ok: true, action: 'rooms', rooms: (snapshot?.rooms || []).slice(0, 32).map(summary) };
    const room = exactRoom(snapshot, msg.roomId);
    if (!room) return failure('DEX_TERMINAL_ROOM_REQUIRED', 'Provide an exact existing room ID, not a room name.');
    if (action === 'dex_terminal_inspect') return { ok: true, action: 'inspect', ...projection(room, { limit: msg.limit }) };
    if (action === 'dex_terminal_check') return stateFor(room, String(msg.lookupId || requestId));
    if (action !== 'dex_terminal_send') return failure('DEX_TERMINAL_BAD_ACTION', 'Unsupported terminal operator command.');
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
    if (!exactTlo(room)) return failure('DEX_TERMINAL_TLO_ONLY', 'Require exactly one relay-enabled TLO member in this room.');
    const attachedSpace = spaceFor(room);
    if (!attachedSpace || !attachedSpace.resourceIds.some(id => targetAvailable(id) === true))
      return failure('DEX_TERMINAL_MACHINE_SPACE_REQUIRED', 'Require exactly one Machine Space with a live attached terminal target.');
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
      status: 'MESSAGE_COMMITTED_RELAY_ACCEPTED', agent: 'TLO',
      machineSpaceId: spaceFor(room).id, deliveryConfirmed: false };
  }
  return { handle };
}
module.exports = { TLO_BINDING, MAX_TEXT, exactTlo, spaceFor, summary, projection, stateFor, createTerminalOperator };
