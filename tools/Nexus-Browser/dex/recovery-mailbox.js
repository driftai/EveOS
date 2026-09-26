'use strict';
// Durable FIFO for authenticated new room messages. An incoming send is NEVER
// a replay of an earlier uncertain outbound relay turn.
const { randomUUID, createHash } = require('node:crypto');
const { commandKey } = require('./provider-control-receipt');
const stateApi = require('./server-scheduler-state');
const protocol = require('../public/dex-protocol');
const MAX_QUEUED = 8, MAX_RECEIPTS = 128;
function matchingMember(room, source = {}) {
  return (room?.members || []).find((member) => {
    const b = member.binding || {};
    if (b.targetClassId !== source.targetClassId || b.providerId !== source.providerId) return false;
    if (b.targetClassId === 'local-origin')
      return !!b.targetId && String(b.targetId) === String(source.targetId || '');
    if (b.targetId != null && String(b.targetId) !== String(source.targetId ?? '')) return false;
    if (b.url && b.url !== source.url) return false;
    return b.targetId != null || !!b.url;
  }) || null;
}
function eligibleRoom(snapshot, source, roomRef) {
  const authorized = (snapshot?.rooms || []).filter((room) => matchingMember(room, source));
  if (!roomRef) return authorized.length === 1 ? authorized[0] : null;
  const key = String(roomRef).trim().toLowerCase();
  const matches = authorized.filter((room) => room.id === roomRef
    || String(room.name || '').trim().toLowerCase() === key);
  return matches.length === 1 ? matches[0] : null;
}
function queueSend(snapshot, { source, command, requestId,
  at = new Date().toISOString(), makeId = () => 'msg-' + randomUUID()
} = {}, interruptedOnly = false) {
  if (String(command?.action || '').toLowerCase() !== 'send' || command.relay === false) return null;
  const room = eligibleRoom(snapshot, source || {}, command.room);
  if (!room) return null;
  if (interruptedOnly && (!room.recovery || room.relay?.active
      || room.relay?.waitingFor || room.pendingTurn)) return null;
  if (!requestId || typeof requestId !== 'string' || requestId.length > 128)
    return { snapshot, changed: false, result: { ok: false,
      code: 'DEX_SEND_BAD_ID', message: 'Stable requestId is required for exactly-once admission.' } };
  const digest = createHash('sha256').update(commandKey(command)).digest('hex');
  const previous = (snapshot.rooms || []).flatMap((entry) =>
    [...(entry.messages || []).filter((message) => message.clientRequestId === requestId)
        .map((message) => ({ requestId, roomId: entry.id, messageId: message.id,
          senderId: message.senderId, intentDigest: message.intentDigest,
          phase: (entry.deferredSendReceipts || []).find((receipt) => receipt.requestId === requestId)?.phase
            || 'committed' })),
      ...(entry.deferredSendReceipts || []).map((receipt) => ({ ...receipt, roomId: entry.id }))])
    .find((receipt) => receipt.requestId === requestId);
  if (previous) {
    const member = matchingMember(room, source);
    if (previous.roomId !== room.id || (previous.senderId && previous.senderId !== member?.id)
        || (previous.intentDigest && previous.intentDigest !== digest))
      return { snapshot, changed: false, result: { ok: false,
        code: 'DEX_REQUEST_ID_CONFLICT', message: 'This request ID belongs to a different room, source, or payload; nothing was enqueued.' } };
    return { snapshot, changed: false, result: {
      ok: previous.phase !== 'orphaned', action: 'send',
      message: 'This request ID was already durably admitted; never replaying it.',
      data: { roomId: room.id, messageId: previous.messageId, commitId: previous.messageId,
        commitState: previous.phase === 'orphaned' ? 'unknown' : 'committed',
        deliveryState: previous.phase }
    } };
  }
  const text = String(command.text || '').trim();
  if (!text || text.length > 16000) return { snapshot, changed: false, result: {
    ok: false, code: 'DEX_CONTROL_EMPTY_OR_OVERSIZE', message: 'send text must contain 1–16000 characters.'
  } };
  if (command.contextMessages != null
      && (!Number.isInteger(command.contextMessages) || command.contextMessages < 1 || command.contextMessages > 40))
    return { snapshot, changed: false, result: { ok: false, code: 'DEX_CONTEXT_INVALID',
      message: 'contextMessages must be 1–40 for this one send.' } };
  if (command.turns != null && (!Number.isInteger(command.turns) || command.turns < 1
      || command.turns > 500))
    return { snapshot, changed: false, result: { ok: false, code: 'DEX_BUDGET_INVALID',
      message: 'turns must be an integer between 1 and 500.' } };
  const queue = room.deferredRelays = Array.isArray(room.deferredRelays) ? room.deferredRelays : [];
  if (queue.length >= MAX_QUEUED) return { snapshot, changed: false, result: {
    ok: false, code: interruptedOnly ? 'DEX_RECOVERY_MAILBOX_FULL' : 'DEX_ROOM_INBOX_FULL',
    message: 'Room inbox reached its durable limit; no new message was committed. Inspect room status.' } };
  const member = matchingMember(room, source);
  const message = stateApi.addMessage(room, {
    id: makeId(), at, senderKind: 'agent', senderId: member.id, senderName: member.name, text,
    contextOverride: command.contextMessages
  });
  message.clientRequestId = requestId;
  message.intentDigest = digest;
  const selected = room.members?.[protocol.nextMemberIndex(room, message)];
  queue.push({ requestId, messageId: message.id, targetMemberId: selected?.id || null,
    queuedAt: at, budget: stateApi.safeBudget(command.turns ?? room.settings?.maxTurns, 8) });
  room.deferredSendReceipts = [...(room.deferredSendReceipts || []),
    { requestId, messageId: message.id, senderId: member.id, intentDigest: digest,
      phase: 'queued', at }].slice(-MAX_RECEIPTS);
  return { snapshot, changed: true, result: {
    ok: true, action: 'send',
    message: 'New message committed to the durable FIFO. It will be batched into the next safe relay boundary or started after the previous relay stops. Queued is NOT delivered.',
    data: { roomId: room.id, messageId: message.id,
      commitId: message.id, commitState: 'committed', deliveryState: 'queued',
      queuedMessages: queue.length }
  } };
}
function queueInterruptedSend(snapshot, options = {}) { return queueSend(snapshot, options, true); }
function queueRoomSend(snapshot, options = {}) { return queueSend(snapshot, options, false); }
function updateReceipts(room, entries, phase) {
  const ids = new Set(entries.map((entry) => entry.requestId));
  room.deferredSendReceipts = (room.deferredSendReceipts || []).map((receipt) =>
    ids.has(receipt.requestId) ? { ...receipt, phase } : receipt);
}
function recipientFor(room, entry) {
  const message = stateApi.messageById(room, entry.messageId);
  if (!message || !stateApi.memberById(room, message.senderId)) return null;
  const member = entry.targetMemberId
    ? stateApi.memberById(room, entry.targetMemberId)
    : room.members?.[protocol.nextMemberIndex(room, message)];
  if (!member) return entry.targetMemberId ? null : 'waiting-for-recipient';
  return member.relayEnabled === false ? 'waiting-for-recipient' : member.id;
}
function takeBatch(room, count = MAX_QUEUED, recipientId = null) {
  const queue = room.deferredRelays || [], valid = [], orphaned = [];
  let target = recipientId;
  while (queue.length && valid.length < Math.min(MAX_QUEUED, count)) {
    const next = queue[0], recipient = recipientFor(room, next);
    if (recipient === 'waiting-for-recipient') break;
    if (!recipient) { orphaned.push(queue.shift()); continue; }
    if (target && recipient !== target) break; // Never deliver one agent's report to another.
    target = recipient;
    valid.push(queue.shift());
  }
  updateReceipts(room, orphaned, 'orphaned');
  updateReceipts(room, valid, 'batched');
  return valid;
}
// A currently running relay yields at the NEXT committed-turn boundary, never
// while a provider gesture/terminal command is still in flight.
function stageForPending(room) {
  if (!room?.pendingTurn || !(room.deferredRelays || []).length) return 0;
  const prior = room.pendingTurn.inboxMessageIds || [];
  const batch = takeBatch(room, MAX_QUEUED - prior.length, room.pendingTurn.memberId);
  room.pendingTurn.inboxMessageIds = [...new Set([...prior, ...batch.map((e) => e.messageId)])];
  return batch.length;
}
function activateNext(snapshot, at = new Date().toISOString()) {
  const rooms = (snapshot.rooms || []).filter((room) =>
    !room.recovery && !room.pendingTurn && !room.pendingProviderControlReceipt
    && !room.relay?.active && !room.relay?.waitingFor
    && (room.members || []).some((member) => member.relayEnabled !== false)
    && (room.deferredRelays || []).length > 0
    && recipientFor(room, room.deferredRelays[0]) !== 'waiting-for-recipient');
  rooms.sort((a, b) => Date.parse(a.deferredRelays[0].queuedAt)
    - Date.parse(b.deferredRelays[0].queuedAt));
  const room = rooms[0];
  if (!room) return false;
  const batch = takeBatch(room);
  if (!batch.length) return true; // Commit rejected/orphaned entries, never invent a source.
  const last = batch[batch.length - 1], source = stateApi.messageById(room, last.messageId);
  const budget = batch[0].budget || 8; // The oldest admitted request owns this run's budget.
  room.relay = room.relay || {};
  Object.assign(room.relay, { active: true, remaining: budget,
    turnBudgetTotal: budget, scheduledTurns: 0,
    waitingFor: null, lastStopReason: 'Starting queued incoming message batch' });
  if (!stateApi.enqueueNext(room, source, at)) {
    room.deferredRelays = [...batch, ...(room.deferredRelays || [])];
    updateReceipts(room, batch, 'queued');
    return false;
  }
  room.pendingTurn.inboxMessageIds = batch.slice(0, -1).map((item) => item.messageId);
  updateReceipts(room, batch, 'dispatched'); // Scheduled to a prompt; NOT provider delivery.
  return true;
}
module.exports = { MAX_QUEUED, matchingMember, eligibleRoom, queueInterruptedSend,
  queueRoomSend, stageForPending, activateNext };
