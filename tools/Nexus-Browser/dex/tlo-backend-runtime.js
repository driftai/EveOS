'use strict';

const { createTloOwnershipFence } = require('./tlo-ownership-fence');
const { createTloDexLedgerGate } = require('./tlo-dex-ledger-gate');
const { createTloDexStateAuthority } = require('./tlo-dex-state-authority');
const { createTloBackendOwnershipSeam } = require('./tlo-backend-ownership-seam');
const { createTloBackendChatAdapter } = require('../local-targets/tlo-backend-chat');
const { createTloDispatchCapabilityBroker } = require('./tlo-dispatch-capability');

function createTloBackendRuntime({
  active = false,
  owner,
  scopeId = 'default',
  ownershipStore,
  conversationStore,
  durability,
  stateStore,
  streamChat
} = {}) {
  if (!ownershipStore || typeof ownershipStore.read !== 'function'
      || typeof ownershipStore.compareAndSwap !== 'function'
      || !durability || typeof durability.query !== 'function') {
    throw new TypeError('TLO backend runtime requires the durable ownership store and Dex durability owner.');
  }
  const ownerFence = createTloOwnershipFence(ownershipStore);
  const dispatchCapabilities = createTloDispatchCapabilityBroker();
  const authority = createTloDexStateAuthority({ stateStore });
  const ledgerGate = createTloDexLedgerGate({
    ownerFence,
    queryDexLedger: (requestId) => durability.query(requestId),
    validateDexSource: authority.validateDexSource,
    verifyDexFinalReceipt: authority.verifyDexFinalReceipt
  });
  function readiness({ requestId = null } = {}) {
    const state = ownerFence.snapshot(scopeId).state;
    if (state.handoff) return { ready: false, reason: 'transferring', ownerGeneration: state.generation };
    if (state.turn?.phase === 'unknown') return { ready: false, reason: 'uncertain', ownerGeneration: state.generation };
    if (state.owner?.kind === 'browser') return { ready: false, reason: 'browser-owned', ownerGeneration: state.generation };
    if (state.owner?.kind !== owner?.kind || state.owner?.id !== owner?.id
        || state.generation !== owner?.generation) {
      return { ready: false, reason: 'owner-unavailable', ownerGeneration: state.generation };
    }
    const enabled = typeof active === 'function' ? active() === true : active === true;
    if (!enabled) return { ready: false, reason: 'disabled', ownerGeneration: state.generation };
    if (state.turn && state.turn.requestId !== requestId) {
      return { ready: false, reason: 'busy', ownerGeneration: state.generation };
    }
    const proof = conversationStore.proof(scopeId, owner.generation);
    return proof ? { ...proof, ready: true, reason: 'backend-owned' }
      : { ready: false, reason: 'conversation-unavailable', ownerGeneration: state.generation };
  }

  function settleConversation(context, receipt) {
    const pending = conversationStore.snapshot(scopeId)?.pending;
    if (!pending || pending.phase !== 'inferred'
        || pending.requestId !== context.args.requestId
        || pending.dispatchId !== context.dispatchId) {
      throw Object.assign(new Error('Inferred conversation evidence is unavailable for delivery settlement.'),
        { code: 'TLO_HISTORY_TURN_STALE' });
    }
    return conversationStore.settleDelivered({
      scopeId,
      generation: owner.generation,
      requestId: pending.requestId,
      roomId: pending.roomId,
      sourceMessageId: pending.sourceMessageId,
      dispatchId: pending.dispatchId,
      responseDigest: pending.responseDigest,
      deliveryReceipt: receipt
    });
  }

  const ownershipSeam = createTloBackendOwnershipSeam({
    active,
    ledgerGate,
    dispatchCapabilities,
    owner,
    scopeId,
    conversationProof: () => readiness(),
    settleConversation
  });
  const targetAdapter = createTloBackendChatAdapter({
    active,
    conversationStore,
    dispatchCapabilities,
    readiness,
    owner,
    scopeId,
    streamChat
  });

  function fenceRestart() {
    const ownership = ownerFence.fenceRestart({ scopeId });
    const conversation = conversationStore.fenceRestart(scopeId);
    return { ownership, conversation };
  }

  function reconcileInferred() {
    const pending = conversationStore.snapshot(scopeId)?.pending;
    if (!pending || pending.phase !== 'inferred') return { reconciled: false, reason: 'no-inferred-turn' };
    const args = {
      scopeId,
      owner,
      requestId: pending.requestId,
      roomId: pending.roomId,
      sourceMessageId: pending.sourceMessageId
    };
    const state = ownerFence.snapshot(scopeId).state;
    let delivery;
    if (state.turn?.requestId === pending.requestId && state.turn.phase === 'dispatched') {
      delivery = ledgerGate.settleAuthoritative(args);
    } else if (state.turn?.requestId === pending.requestId && state.turn.phase === 'unknown') {
      delivery = ledgerGate.reconcileAuthoritative(args);
    } else if (!state.turn) {
      const ledger = durability.query(pending.requestId);
      const evidence = authority.verifyDexFinalReceipt(args);
      if (!ledger?.reliable || ledger.entry?.state !== 'completed' || !evidence?.confirmed) {
        return { reconciled: false, reason: 'receipt-unavailable' };
      }
      delivery = { receipt: { source: 'dex-durable-ledger', confirmed: true,
        requestId: pending.requestId, roomId: pending.roomId,
        sourceMessageId: pending.sourceMessageId,
        finalRequestId: evidence.finalRequestId,
        responseMessageId: evidence.responseMessageId } };
    } else {
      return { reconciled: false, reason: 'ownership-mismatch' };
    }
    settleConversation({ args, dispatchId: pending.dispatchId }, delivery.receipt);
    return { reconciled: true, requestId: pending.requestId };
  }

  function status() {
    const readinessReport = readiness();
    return {
      active: typeof active === 'function' ? active() === true : active === true,
      owner: ownerFence.snapshot(scopeId).state,
      readiness: readinessReport,
      conversation: targetAdapter.status()
    };
  }

  return Object.freeze({ ownerFence, authority, ledgerGate, ownershipSeam,
    targetAdapter, fenceRestart, reconcileInferred, status });
}

module.exports = { createTloBackendRuntime };
