const stateApi = require('./server-scheduler-state');

function createServerLocalRelay({
  localTargets,
  mirrorPrompt = () => {},
  emitEvent = () => {},
  broadcastStatus = () => {}
} = {}) {
  async function sendLocalPrompt({ targetId, requestId, text, emit, correlation = null }) {
    const target = await localTargets.getLocalTarget(targetId);
    if (!target) {
      const error = new Error('Selected Local-Origin target is no longer available.');
      error.code = 'LOCAL_TARGET_NOT_FOUND';
      throw error;
    }

    const exactCorrelation = correlation || stateApi.correlationForRequest(requestId);
    mirrorPrompt(targetId, { requestId, text, ...(exactCorrelation ? { correlation: exactCorrelation } : {}) }, target);
    broadcastStatus(targetId);
    let eventChain = Promise.resolve();
    try {
      await localTargets.sendLocalPrompt({
        targetId,
        requestId,
        text,
        correlation: exactCorrelation,
        emit(payload) {
          eventChain = eventChain
            .then(() => Promise.resolve(emit?.(payload)))
            .then(() => emitEvent(targetId, payload));
        }
      });
      await eventChain;
    } finally {
      await eventChain.catch(() => {});
      stateApi.forgetTurnCorrelation(requestId);
      broadcastStatus(targetId);
    }
  }

  return { sendLocalPrompt };
}

module.exports = { createServerLocalRelay };