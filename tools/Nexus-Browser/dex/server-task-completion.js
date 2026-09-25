'use strict';
const { createTaskCompletionJournal } = require('./task-completion-journal');
const { createTaskCompletionDelivery } = require('./task-completion-delivery');
function startTaskCompletion({
  dexStateStore, localTargets, safeSend, getSocket, getTabs,
  onError = (error) => console.error('[bridge] task-completion:', error)
} = {}) {
  const journal = createTaskCompletionJournal({
    getState: () => dexStateStore.load(),
    validateLocal: async (source) => {
      const target = await localTargets.getLocalTarget(String(source.targetId || ''));
      return !!target && target.id === source.targetId
        && target.providerId === source.providerId && target.sessionOrigin === 'existing';
    }
  });
  const delivery = createTaskCompletionDelivery({
    journal, getState: () => dexStateStore.load(), getTabs, getSocket, safeSend
  });
  async function handleCommand(ws, message) {
    if (!['task_completion_register', 'task_completion_status'].includes(message?.type)) return false;
    const requestId = String(message.requestId || '').slice(0, 128);
    let result;
    try {
      result = message.type === 'task_completion_register'
        ? await journal.register({ source: message.source, command: message })
        : await journal.status({ source: message.source, command: message });
    } catch (error) {
      result = { ok: false, code: 'TASK_COMPLETION_STORAGE_FAILED',
        message: String(error.message || error).slice(0, 160) };
    }
    safeSend(ws, { type: 'task_completion_result', requestId, result });
    return true;
  }
  const tick = () => { try { journal.scan(); delivery.flush(); } catch (error) { onError(error); } };
  const timer = setInterval(tick, 1000);
  timer.unref?.();
  return { handleCommand, flush: tick, handleAck: delivery.handleAck,
    diagnostics: delivery.diagnostics, journal, delivery };
}
module.exports = { startTaskCompletion };
