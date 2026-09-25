const protocol = require('../public/dex-protocol');

function roomById(snapshot, roomId) {
  return (snapshot?.rooms || []).find((room) => room.id === roomId) || null;
}

function memberById(room, memberId) {
  return (room?.members || []).find((member) => member.id === memberId) || null;
}

function messageById(room, messageId) {
  return (room?.messages || []).find((message) => message.id === messageId) || null;
}

function addMessage(room, { id, senderKind, senderId, senderName, text, at }) {
  const message = {
    id, senderKind, senderId, senderName,
    text: protocol.cleanText(text), at
  };
  room.messages = Array.isArray(room.messages) ? room.messages : [];
  room.messages.push(message);
  room.updatedAt = at;
  return message;
}

function requestStop(room, reason, at) {
  room.relay = room.relay || {};
  room.relay.active = false;
  room.relay.remaining = 0;
  room.relay.lastStopReason = reason || 'Stopped';
  room.updatedAt = at;
}

function setStopped(room, reason, at) {
  requestStop(room, reason, at);
  room.relay.waitingFor = null;
  delete room.pendingTurn;
  delete room.recovery;
}

function validPending(room) {
  const pending = room?.pendingTurn;
  return !!pending
    && !!memberById(room, pending.memberId)
    && !!messageById(room, pending.sourceMessageId)
    && room?.relay?.active === true;
}

function queueTurn(room, member, sourceMessage, queuedAt, retryCount = 0, notBefore = null) {
  room.pendingTurn = {
    memberId: member.id,
    sourceMessageId: sourceMessage.id,
    queuedAt,
    retryCount: Math.max(0, Number(retryCount) || 0),
    ...(notBefore ? { notBefore } : {})
  };
  room.relay.waitingFor = member.id;
  room.updatedAt = queuedAt;
  return room.pendingTurn;
}

function enqueueNext(room, sourceMessage, queuedAt) {
  if (!room?.relay?.active || Number(room.relay.remaining || 0) <= 0 || !(room.members || []).length) {
    setStopped(room, room?.members?.length ? 'Relay budget complete' : 'No agents in room', queuedAt);
    return false;
  }
  const index = protocol.nextMemberIndex(room, sourceMessage);
  const member = room.members[index];
  if (!member) {
    setStopped(room, 'No routable agent', queuedAt);
    return false;
  }
  room.relay.remaining = Math.max(0, Number(room.relay.remaining || 0) - 1);
  queueTurn(room, member, sourceMessage, queuedAt, 0);
  return true;
}

function pendingRooms(snapshot) {
  return (snapshot?.rooms || [])
    .filter(validPending)
    .sort((a, b) => Date.parse(a.pendingTurn.queuedAt || '') - Date.parse(b.pendingTurn.queuedAt || ''));
}

function duePendingRooms(snapshot, stamp = Date.now()) {
  return pendingRooms(snapshot).filter((room) => {
    const due = Date.parse(room.pendingTurn?.notBefore || '');
    return !Number.isFinite(due) || due <= stamp;
  });
}

function nextPendingDelay(snapshot, stamp = Date.now()) {
  const delays = pendingRooms(snapshot).map((room) => {
    const due = Date.parse(room.pendingTurn?.notBefore || '');
    return Number.isFinite(due) ? Math.max(0, due - stamp) : 0;
  });
  return delays.length ? Math.min(...delays) : null;
}

// Recovery data belongs to the state layer; the scheduler handles dispatch.
function createRecoveryJournal(current, member, room, at) {
  return {
    requestId: current.requestId,
    memberId: member.id,
    sourceMessageId: current.sourceMessageId,
    targetClassId: member.binding?.targetClassId || 'online-origin',
    providerId: member.binding?.providerId || null,
    relayActive: !!room.relay?.active,
    relayRemaining: Number(room.relay?.remaining || 0),
    retryCount: Number(current.retryCount || 0),
    dispatched: false,
    startedAt: at,
    interruptedAt: null,
    captureRequestId: null,
    candidateText: null,
    candidateAt: 0,
    ensureTargetRequestId: null,
    selectingTargetId: null
  };
}

function resolveOnline(member, tabs = []) {
  const binding = member?.binding || {};
  return tabs.find((tab) => String(tab.id) === String(binding.targetId) && tab.providerId === binding.providerId)
    || tabs.find((tab) => tab.providerId === binding.providerId && binding.url && tab.url === binding.url)
    || null;
}

function resolveLocal(member, targets = []) {
  const binding = member?.binding || {};
  return targets.find((target) => target.id === binding.targetId)
    || (binding.providerId === 'local-antigravity-existing'
      ? targets.find((target) => target.providerId === 'local-antigravity-existing') : null)
    || null;
}

function priorReply(room, member, sourceMessageId) {
  const messages = Array.isArray(room?.messages) ? room.messages : [];
  const sourceIndex = messages.findIndex((message) => message.id === sourceMessageId);
  const before = sourceIndex >= 0 ? messages.slice(0, sourceIndex + 1) : messages;
  return [...before].reverse().find((message) =>
    message.senderKind === 'agent' && message.senderId === member?.id
  ) || null;
}

function safeBudget(value, fallback = 8) {
  const parsed = Number(value);
  return Math.max(1, Math.min(protocol.MAX_RELAY_TURNS, Number.isFinite(parsed) ? parsed : fallback));
}

function providerById(providers = [], providerId) {
  return providers.find((provider) => provider?.id === providerId) || null;
}

function supportsOperation(providers, providerId, operation) {
  return providerById(providers, providerId)?.adapterContract?.operations?.[operation] === true;
}

module.exports = {
  roomById, memberById, messageById, addMessage, requestStop, setStopped,
  validPending, queueTurn, enqueueNext, pendingRooms, duePendingRooms, nextPendingDelay,
  createRecoveryJournal, resolveOnline, resolveLocal, priorReply, safeBudget,
  providerById, supportsOperation
};