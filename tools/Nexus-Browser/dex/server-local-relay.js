const stateApi = require('./server-scheduler-state');

function createServerLocalRelay({
  localTargets,
  mirrorPrompt = () => {},
  emitEvent = () => {},
  broadcastStatus = () => {},
  tloBackendOwnership = null
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
    let ownershipContext = null;
    try {
      ownershipContext = await tloBackendOwnership?.beforeSend?.({
        target, requestId, correlation: exactCorrelation
      });
      await localTargets.sendLocalPrompt({
        targetId,
        requestId,
        text,
        correlation: exactCorrelation,
        dispatchCapability: ownershipContext?.dispatchCapability || null,
        emit(payload) {
          eventChain = eventChain
            .then(() => Promise.resolve(emit?.(payload)))
            .then(() => emitEvent(targetId, payload))
            .then(() => tloBackendOwnership?.afterEvent?.(ownershipContext, payload));
        }
      });
      await eventChain;
      await tloBackendOwnership?.afterReturn?.(ownershipContext);
    } catch (error) {
      try { await tloBackendOwnership?.afterFailure?.(ownershipContext, error); }
      catch (ownershipError) { error.ownershipError = ownershipError; }
      throw error;
    } finally {
      await eventChain.catch(() => {});
      stateApi.forgetTurnCorrelation(requestId);
      broadcastStatus(targetId);
    }
  }

  return { sendLocalPrompt };
}

module.exports = { createServerLocalRelay };
