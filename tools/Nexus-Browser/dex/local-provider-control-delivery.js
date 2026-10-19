'use strict';

function durableCommand(intent = {}) {
  if (intent.command && typeof intent.command === 'object') return intent.command;
  try {
    const parsed = JSON.parse(String(intent.commandKey || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

function createLocalProviderControlDelivery({ getState, pending, handleRequest } = {}) {
  const flights = new Set();
  async function flush() {
    const snapshot = typeof getState === 'function' ? getState() : null;
    const candidates = [];
    for (const room of snapshot?.rooms || []) {
      const intent = room?.pendingProviderControlReceipt;
      if (intent?.executorTarget?.targetClassId !== 'local-origin') continue;
      const command = durableCommand(intent);
      if (!command?.action || String(command.action).trim().toLowerCase() !== String(intent.action || '').trim().toLowerCase()) continue;
      const requestId = String(intent.controlRequestId || `local-control-${intent.turnRequestId || intent.agentMessageId || room.id}`);
      candidates.push({ roomId: room.id, intent, command, requestId });
    }
    let dispatched = 0, waiting = 0;
    for (const candidate of candidates) {
      const key = `${candidate.roomId}|${candidate.intent.agentMessageId || candidate.requestId}`;
      if (flights.has(key) || pending?.has(candidate.requestId)) { waiting += 1; continue; }
      flights.add(key);
      try {
        await handleRequest(null, { type: 'provider_control_request', requestId: candidate.requestId,
          source: { ...candidate.intent.executorTarget }, command: candidate.command });
        dispatched += 1;
      } finally { flights.delete(key); }
    }
    return { dispatched, waiting, candidates: candidates.length };
  }
  return { flush };
}

module.exports = { durableCommand, createLocalProviderControlDelivery };
