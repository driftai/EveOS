function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function commandKey(command = {}) {
  const action = String(command.action || '').trim().toLowerCase();
  return JSON.stringify(stableValue({ ...command, action }));
}

function bindingMatchesSource(binding = {}, source = {}) {
  if (binding.targetClassId !== source.targetClassId || binding.providerId !== source.providerId) return false;
  if (binding.targetClassId === 'online-origin') {
    if (binding.targetId != null && source.targetId != null && String(binding.targetId) === String(source.targetId)) return true;
    return !!binding.url && !!source.url && binding.url === source.url;
  }
  return String(binding.targetId || '') === String(source.targetId || '');
}

function compactBinding(binding = null) {
  if (!binding) return null;
  return {
    targetClassId: binding.targetClassId || null,
    targetId: binding.targetId ?? null,
    providerId: binding.providerId || null,
    providerName: binding.providerName || null,
    url: binding.url || ''
  };
}

function rememberIntent(room, {
  executorMember, sourceMessage, command, agentMessage, turnRequestId, at
} = {}) {
  if (!room || !executorMember || !command?.action || !agentMessage?.id) return null;
  const originMember = sourceMessage?.senderKind === 'agent'
    ? (room.members || []).find((member) => member.id === sourceMessage.senderId)
    : null;
  const pending = {
    version: 1,
    action: String(command.action).trim().toLowerCase(),
    commandKey: commandKey(command),
    executorMemberId: executorMember.id,
    executorName: executorMember.name || 'Agent',
    executorTarget: compactBinding(executorMember.binding),
    originMessageId: sourceMessage?.id || null,
    originSenderId: sourceMessage?.senderId || null,
    originSenderName: sourceMessage?.senderName || null,
    originTarget: compactBinding(originMember?.binding),
    agentMessageId: agentMessage.id,
    turnRequestId: turnRequestId || null,
    createdAt: at || new Date().toISOString()
  };
  room.pendingProviderControlReceipt = pending;
  return pending;
}

function findIntentInRoom(snapshot, roomId, source, command) {
  const room = (snapshot?.rooms || []).find((entry) => entry.id === roomId);
  const pending = room?.pendingProviderControlReceipt;
  if (!room || !pending || pending.commandKey !== commandKey(command)) return null;
  const executor = (room.members || []).find((member) => member.id === pending.executorMemberId);
  if (!executor || !bindingMatchesSource(executor.binding, source)) return null;
  return { roomId: room.id, roomName: room.name, ...pending };
}

function findIntent(snapshot, source, command) {
  const matches = (snapshot?.rooms || [])
    .map((room) => findIntentInRoom(snapshot, room.id, source, command))
    .filter(Boolean);
  return matches.length === 1 ? matches[0] : null;
}

function activeSourceTurn(snapshot, source) {
  const matches = [];
  for (const room of snapshot?.rooms || []) {
    // A timed-out passive recovery is capture-only, not an active turn.
    const liveRecovery = room?.recovery?.passiveAt ? null : room?.recovery;
    const memberId = liveRecovery?.memberId || room?.relay?.waitingFor || null;
    const member = memberId ? (room.members || []).find((entry) => entry.id === memberId) : null;
    const active = !!liveRecovery || (room?.relay?.active === true && !!room?.relay?.waitingFor);
    if (!active || !member || !bindingMatchesSource(member.binding, source)) continue;
    matches.push({
      roomId: room.id,
      roomName: room.name,
      memberId: member.id,
      requestId: liveRecovery?.requestId || null
    });
  }
  if (!matches.length) return null;
  return matches.length === 1 ? matches[0] : { ambiguous: true, matches };
}

function resultText(origin, result = {}, requestId = '') {
  const status = result.ok ? 'OK' : `ERROR ${result.code || 'DEX_CONTROL_FAILED'}`;
  const data = result.data == null ? '' : `\nData: ${JSON.stringify(result.data).slice(0, 1400)}`;
  return [
    '[DEX CONTROL RECEIPT]',
    `${origin.executorName || 'Agent'} · ${origin.action || 'control'} · ${status}: ${result.message || 'No message.'}`,
    `Origin room: ${origin.roomName || origin.roomId || 'unknown'}`,
    `Control request: ${requestId || 'unknown'}${data}`,
    'This is a completed/failed control receipt only. Do not replay the control action from this receipt.'
  ].join('\n');
}

function applyResult(snapshot, origin, result, requestId, at = new Date().toISOString()) {
  if (!origin?.roomId) return { snapshot, receipt: null };
  const room = (snapshot?.rooms || []).find((entry) => entry.id === origin.roomId);
  const pending = room?.pendingProviderControlReceipt;
  if (!room || !pending || pending.commandKey !== origin.commandKey || pending.agentMessageId !== origin.agentMessageId) {
    return { snapshot, receipt: null };
  }
  const text = resultText(origin, result, requestId);
  room.messages = Array.isArray(room.messages) ? room.messages : [];
  room.messages.push({
    id: `msg-control-receipt-${requestId}`,
    senderKind: 'system',
    senderId: null,
    senderName: 'Dex',
    text,
    at,
    controlReceipt: {
      requestId,
      action: origin.action,
      ok: !!result.ok,
      code: result.code || null,
      executorMemberId: origin.executorMemberId,
      originMessageId: origin.originMessageId || null
    }
  });
  delete room.pendingProviderControlReceipt;
  room.updatedAt = at;
  return {
    snapshot,
    receipt: {
      roomId: room.id,
      roomName: room.name,
      action: origin.action,
      executorName: origin.executorName,
      originTarget: origin.originTarget || null,
      text
    }
  };
}

function pendingCount(snapshot) {
  return (snapshot?.rooms || []).filter((room) => !!room?.pendingProviderControlReceipt).length;
}

module.exports = {
  stableValue, commandKey, bindingMatchesSource, compactBinding,
  rememberIntent, findIntentInRoom, findIntent, activeSourceTurn, resultText, applyResult, pendingCount
};
