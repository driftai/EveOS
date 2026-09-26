'use strict';
const { randomUUID } = require('node:crypto');
const stateApi = require('./server-scheduler-state');
const MAX_QUEUED = 8, MAX_RECEIPTS = 128;
function matchingMember(room, source) {
  return (room.members || []).find((member) => {
    const b = member.binding || {};
    if (b.targetClassId !== source.targetClassId || b.providerId !== source.providerId) return false;
    if (b.targetClassId === 'local-origin')
      return String(b.targetId || '') === String(source.targetId || '');
    if (b.url && source.url && b.url === source.url) return true;
    return b.targetId != null && source.targetId != null
      && String(b.targetId) === String(source.targetId);
  }) || null;
}
function eligibleRoom(snapshot, source, roomRef) {
  const authorized = (snapshot.rooms || []).filter((room) => matchingMember(room, source));
  if (roomRef) {
    const key = String(roomRef).trim().toLowerCase();
    return authorized.find((room) => room.id === roomRef
      || String(room.name || '').trim().toLowerCase() === key) || null;
  }
  return authorized.length === 1 ? authorized[0] : null;
}
function queueInterruptedSend(snapshot, { source, command, requestId, at = new Date().toISOString(),
  makeId = () => 'msg-' + randomUUID() } = {}) {
  if (command?.action !== 'send' || command.relay === false) return null;
  const room = eligibleRoom(snapshot, source || {}, command.room);
  if (!room || !room.recovery || room.relay?.active || room.relay?.waitingFor || room.pendingTurn)
    return null;
  const existing = (room.deferredSendReceipts || []).find((r) => r.requestId === requestId);
  if (existing) return { snapshot, result: {
    ok: true, action: 'send', silent: false,
    message: existing.phase === 'queued' ? 'Dex previously queued this exact send; not duplicated.'
      : 'Dex previously dispatched this exact queued send; not duplicated.',
    data: { roomId: room.id, messageId: existing.messageId,
      commitId: existing.messageId, commitState: 'committed', deliveryState: existing.phase }
  }, changed: false };
  const text = String(command.text || '').trim().slice(0, 16000);
  if (!text) return { snapshot, changed: false, result: {
    ok: false, code: 'DEX_CONTROL_EMPTY_MESSAGE', message: 'send requires non-empty text.'
  } };
  const queue = room.deferredRelays = Array.isArray(room.deferredRelays) ? room.deferredRelays : [];
  if (queue.length >= MAX_QUEUED) return { snapshot, changed: false, result: {
    ok: false, code: 'DEX_RECOVERY_MAILBOX_FULL',
    message: 'Interrupted-room mailbox is full. No message was committed; inspect room status.'
  } };
  const member = matchingMember(room, source);
  const message = stateApi.addMessage(room, {
    id: makeId(), at, senderKind: 'agent', senderId: member.id, senderName: member.name, text
  });
  queue.push({ requestId, messageId: message.id, queuedAt: at,
    budget: stateApi.safeBudget(command.turns ?? room.settings?.maxTurns, 8) });
  room.deferredSendReceipts = [...(room.deferredSendReceipts || []),
    { requestId, messageId: message.id, phase: 'queued', at }].slice(-MAX_RECEIPTS);
  return { snapshot, changed: true, result: {
    ok: true, action: 'send', silent: false,
    message: 'Message durably queued for this interrupted room; it has NOT been delivered. Dex will start one relay only after recovery is safely reconciled.',
    data: { roomId: room.id, messageId: message.id,
      commitId: message.id, commitState: 'committed', deliveryState: 'queued' }
  } };
}
function activateNext(snapshot, at = new Date().toISOString()) {
  const rooms = (snapshot.rooms || []).filter((room) =>
    !room.recovery && !room.pendingTurn && !room.relay?.active && !room.relay?.waitingFor
    && (room.deferredRelays || []).length > 0);
  rooms.sort((a, b) => Date.parse(a.deferredRelays[0].queuedAt)
    - Date.parse(b.deferredRelays[0].queuedAt));
  const room = rooms[0];
  if (!room) return false;
  const item = room.deferredRelays.shift();
  const message = stateApi.messageById(room, item.messageId);
  const member = stateApi.memberById(room, message?.senderId);
  if (!message || !member) {
    room.deferredSendReceipts = (room.deferredSendReceipts || []).map((r) =>
      r.requestId === item.requestId ? { ...r, phase: 'orphaned' } : r);
    return true; // Persist the removal; never guess another source or silently replay.
  }
  room.relay = room.relay || {};
  Object.assign(room.relay, { active: true, remaining: item.budget || 8,
    waitingFor: null, lastStopReason: 'Starting deferred send after recovery' });
  stateApi.enqueueNext(room, message, at);
  room.deferredSendReceipts = (room.deferredSendReceipts || []).map((r) =>
    r.requestId === item.requestId ? { ...r, phase: 'dispatched' } : r);
  return true;
}
module.exports = { MAX_QUEUED, matchingMember, eligibleRoom, queueInterruptedSend, activateNext };
