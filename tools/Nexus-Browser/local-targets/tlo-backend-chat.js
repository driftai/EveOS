'use strict';

const { targetEvent } = require('./service-chat-common');
const { TLO_TARGET, TLO_PROVIDER } = require('../dex/tlo-dex-ledger-gate');
const { BACKEND_TRANSPORT } = require('../dex/tlo-backend-ownership-seam');

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const MAX_PARTIAL_CHARS = 32_000;
const MAX_PARTIAL_EVENTS = 128;

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function isActive(value) { return typeof value === 'function' ? value() === true : value === true; }

function createTloBackendChatAdapter({
  active = false,
  conversationStore,
  dispatchCapabilities,
  readiness,
  owner,
  scopeId = 'default',
  streamChat
} = {}) {
  if (!conversationStore || !['snapshot', 'beginTurn', 'markDispatched',
    'markUnknown', 'markInferred'].every((key) => typeof conversationStore[key] === 'function')) {
    throw new TypeError('TLO backend chat requires the durable conversation store.');
  }
  if (!dispatchCapabilities || typeof dispatchCapabilities.consume !== 'function'
      || typeof readiness !== 'function') {
    throw new TypeError('TLO backend chat requires dispatch capabilities and unified readiness.');
  }
  if (owner?.kind !== 'backend' || !ID.test(String(owner?.id || ''))
      || !Number.isSafeInteger(owner?.generation) || owner.generation <= 0
      || typeof streamChat !== 'function') {
    throw new TypeError('TLO backend chat requires an exact backend owner and injected stream transport.');
  }
  const backendOwner = Object.freeze({ kind: 'backend', id: String(owner.id), generation: owner.generation });

  function target() {
    return {
      id: TLO_TARGET,
      targetClassId: 'local-origin',
      targetTypeId: 'provider-workspace',
      targetTypeName: 'Eve-OS Bound Chats',
      providerId: TLO_PROVIDER,
      providerName: 'TLO',
      title: 'TLO Chat',
      detail: 'Server-owned durable TLO conversation. Browser attachment does not own inference.',
      transport: BACKEND_TRANSPORT,
      sessionOrigin: 'server-owned-durable-conversation',
      ownerGeneration: backendOwner.generation,
      capabilities: { chat: true, captureLatest: false, activity: false, searchResults: false }
    };
  }

  function ready() {
    return isActive(active) && readiness({ scopeId, owner: backendOwner })?.ready === true;
  }

  async function listTargets() { return ready() ? [target()] : []; }
  function ownsTarget(targetId) { return targetId === TLO_TARGET; }
  function status() {
    const enabled = isActive(active);
    const proof = readiness({ scopeId, owner: backendOwner });
    const record = conversationStore.snapshot(scopeId);
    const reasonState = `backend_${String(proof?.reason || 'unavailable').replace(/-/g, '_')}`;
    const state = !enabled ? 'backend_disabled'
      : proof?.reason === 'uncertain' ? reasonState
        : record?.pending ? `backend_${record.pending.phase}`
          : proof?.ready === true ? 'ready' : reasonState;
    return {
      bound: proof?.ready === true,
      running: proof?.ready === true,
      busy: !!record?.pending,
      state,
      ownerGeneration: backendOwner.generation,
      message: proof?.ready === true ? 'Server-owned durable TLO conversation is ready.'
        : !enabled ? 'Browser-independent TLO is disabled.'
          : `TLO backend is unavailable: ${String(proof?.reason || 'unknown')}.`
    };
  }

  async function sendPrompt({ requestId, text, target: selectedTarget, emit,
    correlation = {}, dispatchCapability = null }) {
    if (!isActive(active)) fail('TLO_BACKEND_DISABLED', 'Browser-independent TLO is disabled.');
    if (selectedTarget?.id !== TLO_TARGET || selectedTarget?.providerId !== TLO_PROVIDER
        || selectedTarget?.transport !== BACKEND_TRANSPORT
        || selectedTarget?.ownerGeneration !== backendOwner.generation) {
      fail('TLO_BACKEND_TARGET_STALE', 'TLO backend target identity or owner generation is stale.');
    }
    const message = String(text || '').trim();
    if (!ID.test(String(requestId || '')) || !message) fail('TLO_BACKEND_REQUEST_INVALID', 'TLO backend request is invalid.');
    if (readiness({ scopeId, owner: backendOwner, requestId })?.ready !== true) {
      fail('TLO_BACKEND_NOT_READY', 'Durable TLO owner and conversation readiness are unavailable.');
    }
    const authorization = dispatchCapabilities.consume(dispatchCapability, {
      scopeId,
      owner: backendOwner,
      requestId,
      roomId: correlation.roomId,
      sourceMessageId: correlation.sourceMessageId,
      targetId: selectedTarget.id,
      transport: selectedTarget.transport
    });
    const input = { scopeId, generation: backendOwner.generation, requestId,
      roomId: authorization.roomId, sourceMessageId: authorization.sourceMessageId,
      dispatchId: authorization.dispatchId, message };
    let journaled = false;
    let partialEvents = 0;
    let lastPartial = '';
    try {
      const begun = conversationStore.beginTurn(input);
      journaled = true;
      conversationStore.markDispatched(input);
      const result = await streamChat({
        scopeId,
        requestId,
        message,
        history: begun.history,
        dispatchBinding: authorization,
        onPartial(partial) {
          const text = String(partial || '').slice(0, MAX_PARTIAL_CHARS);
          if (!text || text === lastPartial || partialEvents >= MAX_PARTIAL_EVENTS) return;
          lastPartial = text;
          partialEvents += 1;
          emit?.(targetEvent(selectedTarget, requestId, 'response_partial', { text }));
        }
      });
      const response = String(result?.text || '').trim();
      if (!response) fail('TLO_BACKEND_FINAL_MISSING', 'TLO backend stream ended without a final response.');
      conversationStore.markInferred({ ...input, response });
      emit?.(targetEvent(selectedTarget, requestId, 'response_final', {
        text: response,
        ...(result?.capabilityContext ? { capabilityContext: result.capabilityContext } : {})
      }));
      return response;
    } catch (error) {
      if (journaled) {
        try { conversationStore.markUnknown(input); }
        catch (unknownError) {
          if (unknownError.code !== 'TLO_HISTORY_TURN_STALE') error.historyError = unknownError;
        }
      }
      throw error;
    }
  }

  return Object.freeze({ listTargets, ownsTarget, status, sendPrompt });
}

module.exports = { MAX_PARTIAL_CHARS, MAX_PARTIAL_EVENTS, createTloBackendChatAdapter };
