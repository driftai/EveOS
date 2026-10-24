'use strict';

const { TLO_TARGET, TLO_PROVIDER } = require('./tlo-dex-ledger-gate');

const BACKEND_TRANSPORT = 'tlo-backend-owner';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const SCOPE = /^[a-z][a-z0-9_-]{0,63}$/;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function enabled(value) {
  return typeof value === 'function' ? value() === true : value === true;
}

function exactId(value, label) {
  const text = String(value || '').trim();
  if (!ID.test(text)) fail('TLO_BACKEND_CORRELATION_INVALID', `Invalid ${label}.`);
  return text;
}

function sameOwner(expected, actual) {
  return actual?.kind === expected.kind && actual?.id === expected.id
    && actual?.generation === expected.generation;
}

function createTloBackendOwnershipSeam({
  active = false,
  ledgerGate,
  dispatchCapabilities,
  owner,
  scopeId = 'default',
  conversationProof = () => null,
  settleConversation = () => {}
} = {}) {
  if (!ledgerGate || !['reserveAdmitted', 'markBeforeTransport', 'markUncertain',
    'settleAuthoritative', 'readOnlyStatus'].every((key) => typeof ledgerGate[key] === 'function')) {
    throw new TypeError('TLO backend ownership seam requires the durable ledger gate.');
  }
  if (owner?.kind !== 'backend' || !ID.test(String(owner?.id || ''))
      || !Number.isSafeInteger(owner?.generation) || owner.generation <= 0) {
    throw new TypeError('TLO backend ownership seam requires an exact backend owner generation.');
  }
  if (!SCOPE.test(scopeId) || typeof conversationProof !== 'function') {
    throw new TypeError('TLO backend ownership seam requires a valid scope and conversation proof callback.');
  }
  if (!dispatchCapabilities || typeof dispatchCapabilities.issue !== 'function'
      || typeof settleConversation !== 'function') {
    throw new TypeError('TLO backend ownership seam requires dispatch capability and conversation settlement owners.');
  }
  const backendOwner = Object.freeze({ kind: 'backend', id: String(owner.id), generation: owner.generation });

  function argsFor(input = {}) {
    const correlation = input.correlation || {};
    const requestId = exactId(input.requestId, 'request ID');
    if (exactId(correlation.requestId, 'correlated request ID') !== requestId
        || exactId(correlation.turnId, 'turn ID') !== requestId) {
      fail('TLO_BACKEND_CORRELATION_MISMATCH', 'Dex turn and request correlation do not match.');
    }
    return {
      scopeId,
      owner: { ...backendOwner },
      requestId,
      roomId: exactId(correlation.roomId, 'room ID'),
      sourceMessageId: exactId(correlation.sourceMessageId, 'source message ID')
    };
  }

  function requireBackendReady(input, args) {
    if (input.target?.transport !== BACKEND_TRANSPORT) {
      fail('TLO_BACKEND_TRANSPORT_REQUIRED', 'Browser-owned TLO transport cannot be claimed by the backend seam.');
    }
    const status = ledgerGate.readOnlyStatus(scopeId);
    const current = status?.state || status;
    const expected = { ...backendOwner };
    if (!sameOwner(expected, { ...current?.owner, generation: current?.generation })) {
      fail('TLO_BACKEND_OWNER_STALE', 'Durable backend owner identity or generation is stale.');
    }
    if (current?.handoff) fail('TLO_BACKEND_HANDOFF_ACTIVE', 'TLO ownership handoff is not complete.');
    const proof = conversationProof({ ...args, target: input.target });
    if (!proof || proof.ready !== true || proof.durable !== true
        || proof.scopeId !== scopeId || proof.ownerGeneration !== backendOwner.generation
        || !HASH.test(String(proof.digest || ''))) {
      fail('TLO_BACKEND_HISTORY_UNPROVEN', 'Durable conversation continuity is not proven for this owner generation.');
    }
  }

  function markUnknown(context) {
    if (!context || context.closed || context.phase === 'delivery_committed') return false;
    ledgerGate.markUncertain(context.args);
    context.closed = true;
    context.phase = 'unknown';
    return true;
  }

  return Object.freeze({
    async beforeSend(input = {}) {
      if (!enabled(active) || input.target?.id !== TLO_TARGET) return null;
      if (input.target?.providerId !== TLO_PROVIDER) {
        fail('TLO_BACKEND_PROVIDER_MISMATCH', 'Exact TLO target is bound to the wrong provider.');
      }
      const args = argsFor(input);
      requireBackendReady(input, args);
      ledgerGate.reserveAdmitted(args);
      const context = { args, phase: 'admitted', closed: false };
      try {
        ledgerGate.markBeforeTransport(args);
        context.phase = 'dispatched';
        context.dispatchCapability = dispatchCapabilities.issue({
          ...args,
          targetId: input.target.id,
          transport: input.target.transport
        });
        context.dispatchId = context.dispatchCapability.dispatchId;
        return context;
      } catch (error) {
        try { markUnknown(context); } catch (uncertainError) { error.uncertainError = uncertainError; }
        throw error;
      }
    },

    async afterEvent(context, payload = {}) {
      if (!context || context.closed) return false;
      if (String(payload.requestId || '') !== context.args.requestId) {
        fail('TLO_BACKEND_EVENT_MISMATCH', 'Backend transport event does not match the admitted Dex request.');
      }
      if (payload.type === 'response_final') {
        const delivery = ledgerGate.settleAuthoritative(context.args);
        context.phase = 'delivery_committed';
        settleConversation(context, delivery.receipt, payload);
        context.closed = true;
        context.phase = 'settled';
        return true;
      }
      if (payload.type === 'error') return markUnknown(context);
      return false;
    },

    async afterFailure(context) {
      return markUnknown(context);
    },

    async afterReturn(context) {
      if (!context || context.closed) return false;
      markUnknown(context);
      fail('TLO_BACKEND_FINAL_MISSING', 'Backend transport returned without an authoritative final receipt.');
    }
  });
}

module.exports = { BACKEND_TRANSPORT, createTloBackendOwnershipSeam };
