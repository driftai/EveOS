const protocol = require('../public/dex-protocol');

const TURN_CORRELATION_TTL_MS = 10 * 60 * 1000;
const TURN_CORRELATION_MAX = 128;
const turnCorrelations = new Map();

function cleanTurnCorrelations(stamp = Date.now()) {
  for (const [requestId, entry] of turnCorrelations) {
    if (!entry || stamp - Number(entry.registeredAt || 0) > TURN_CORRELATION_TTL_MS) turnCorrelations.delete(requestId);
  }
  while (turnCorrelations.size > TURN_CORRELATION_MAX) {
    const oldest = turnCorrelations.keys().next().value;
    if (oldest == null) break;
    turnCorrelations.delete(oldest);
  }
}

function rememberTurnCorrelation(current, room) {
  const requestId = String(current?.requestId || '').trim();
  if (!requestId || !room?.id || !current?.sourceMessageId) return null;
  cleanTurnCorrelations();
  const correlation = {
    roomId: String(room.id),
    turnId: requestId,
    requestId,
    sourceMessageId: String(current.sourceMessageId)
  };
  turnCorrelations.delete(requestId);
  turnCorrelations.set(requestId, { ...correlation, registeredAt: Date.now() });
  return correlation;
}

function correlationForRequest(requestId) {
  cleanTurnCorrelations();
  const entry = turnCorrelations.get(String(requestId || '').trim());
  if (!entry) return null;
  const { registeredAt, ...correlation } = entry;
  return { ...correlation };
}

function forgetTurnCorrelation(requestId) {
  return turnCorrelations.delete(String(requestId || '').trim());
}

function roomById(snapshot, roomId) {
  return (snapshot?.rooms || []).find((room) => room.id === roomId) || null;
}

function memberById(room, memberId) {
  return (room?.members || []).find((member) => member.id === memberId) || null;
}

function messageById(room, messageId) {
  return (room?.messages || []).find((message) => message.id === messageId) || null;
}

function addMessage(room, { id, senderKind, senderId, senderName, text, at, contextOverride }) {
  const message = {
    id, senderKind, senderId, senderName,
    text: protocol.cleanText(text), at,
    ...(Number.isInteger(contextOverride) && contextOverride >= 1 && contextOverride <= 40 ? { contextOverride } : {})
  };
  room.messages = Array.isArray(room.messages) ? room.messages : [];
  room.messages.push(message);
  room.updatedAt = at;
  return message;
}

function rememberFinalReceipt(room, requestId, messageId, at = new Date().toISOString()) {
  if (!requestId || !messageId) return false;
  room.finalReceipts = Array.isArray(room.finalReceipts) ? room.finalReceipts : [];
  if (room.finalReceipts.some((entry) => entry.requestId === requestId)) return false;
  room.finalReceipts.push({ requestId, messageId, committedAt: at });
  room.finalReceipts = room.finalReceipts.slice(-128);
  return true;
}
function findFinalReceipt(snapshot, requestId) {
  for (const room of snapshot?.rooms || []) {
    const receipt = (room.finalReceipts || []).find((entry) => entry.requestId === requestId);
    // The receipt was committed after the message; later transcript cleanup
    // must not make an already-committed result look undelivered.
    if (receipt) return { roomId: room.id, ...receipt };
  }
  return null;
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
  room.relay.scheduledTurns = Math.max(0, Number(room.relay.scheduledTurns || 0)) + 1;
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
  if (member.binding?.targetClassId === 'local-origin') rememberTurnCorrelation(current, room);
  return {
    requestId: current.requestId,
    memberId: member.id,
    sourceMessageId: current.sourceMessageId,
    inboxMessageIds: (current.inboxMessageIds || []).slice(0, 8),
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

function appConversationMatches(expected = {}, actual = {}) {
  const titleMatches = !!expected.conversationTitle
    && String(expected.conversationTitle) === String(actual.conversationTitle || '');
  if (expected.conversationAnchor) {
    const liveAnchors = Array.isArray(actual.conversationAnchors)
      ? actual.conversationAnchors.map(String)
      : actual.conversationAnchor ? [String(actual.conversationAnchor)] : [];
    if (liveAnchors.includes(String(expected.conversationAnchor))) return true;
    if (liveAnchors.length) return false;
    return titleMatches;
  }
  return titleMatches;
}

function resolveLocal(member, targets = []) {
  const binding = member?.binding || {};
  if (binding.targetClassId !== 'local-origin' || !binding.providerId || !binding.targetId
    || !Array.isArray(targets)) return null;
  const matches = targets.filter((target) => target && String(target.id) === String(binding.targetId));
  // Same-provider fallback can silently dispatch to a DIFFERENT Antigravity PID.
  // Leave the room pending until an independently authenticated rebind is committed.
  return matches.length === 1 && matches[0].providerId === binding.providerId
    && (!matches[0].targetClassId || matches[0].targetClassId === 'local-origin')
    ? matches[0] : null;
}

function resolveApp(member, targets = []) {
  const binding = member?.binding || {};
  if (binding.targetClassId !== 'app-origin' || !binding.providerId || !binding.targetId
    || !Array.isArray(targets)) return null;
  const matches = targets.filter((target) => target && String(target.id) === String(binding.targetId)
    && target.providerId === binding.providerId);
  if (matches.length !== 1) return null;
  const target = matches[0], expected = binding.concreteTargetIdentity || {};
  const actual = target.concreteTargetIdentity || {};
  if (binding.providerId === 'chatgpt-desktop' && !appConversationMatches(expected, actual)) return null;
  if (expected.processId && String(expected.processId) !== String(actual.processId || '')) return null;
  if (expected.windowHandle && String(expected.windowHandle) !== String(actual.windowHandle || '')) return null;
  return (!target.targetClassId || target.targetClassId === 'app-origin') ? target : null;
}

function priorReply(room, member, sourceMessageId) {
  const messages = Array.isArray(room?.messages) ? room.messages : [];
  const sourceIndex = messages.findIndex((message) => message.id === sourceMessageId);
  const before = sourceIndex >= 0 ? messages.slice(0, sourceIndex + 1) : messages;
  return [...before].reverse().find((message) =>
    message.senderKind === 'agent' && message.senderId === member?.id
  ) || null;
}

function extendBudget(room, parsed = {}) {
  if (!room?.relay?.active || !Number.isInteger(parsed.budgetIncrease)
      || parsed.done || parsed.needsUser || parsed.note || parsed.providerCommand
      || parsed.malformedCommand) return 0;
  const relay = room.relay;
  const used = Math.max(0, Number(relay.scheduledTurns || 0));
  const total = Number(relay.turnBudgetTotal || used + Number(relay.remaining || 0));
  const added = Math.min(parsed.budgetIncrease, Math.max(0, protocol.MAX_RELAY_TURNS - total));
  relay.turnBudgetTotal = total + added;
  relay.remaining = Math.max(0, Number(relay.remaining || 0)) + added;
  relay.lastBudgetExtension = { requested: parsed.budgetIncrease, applied: added };
  return added;
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
  TURN_CORRELATION_TTL_MS, TURN_CORRELATION_MAX,
  rememberTurnCorrelation, correlationForRequest, forgetTurnCorrelation,
  roomById, memberById, messageById, addMessage, rememberFinalReceipt, findFinalReceipt, requestStop, setStopped,
  validPending, queueTurn, enqueueNext, pendingRooms, duePendingRooms, nextPendingDelay,
  createRecoveryJournal, resolveOnline, resolveLocal, resolveApp, appConversationMatches, priorReply, safeBudget, extendBudget,
  providerById, supportsOperation
};