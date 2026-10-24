'use strict';
// Phase 3D-B2: inert adapter proving the existing Dex journal admitted a TLO
// turn before a separate owner fence can advance it. Not a second dispatcher.
// Production wiring must supply authenticated, server-owned callbacks.
const REQUEST = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const TLO_TARGET = 'local:tlo-chat:default';
const TLO_PROVIDER = 'tlo-chat';
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail('TLO_LEDGER_BAD_ID', `Invalid ${label}.`);
  return value;
}
function sourceParams(input = {}) {
  return {
    scopeId: input.scopeId || 'default',
    owner: input.owner,
    requestId: id(input.requestId, 'turn request ID'),
    roomId: id(input.roomId, 'Dex room ID'),
    sourceMessageId: id(input.sourceMessageId, 'Dex source message ID')
  };
}
function createTloDexLedgerGate({
  ownerFence,
  queryDexLedger,
  validateDexSource,
  verifyDexFinalReceipt
} = {}) {
  if (!ownerFence || !['snapshot','reserveTurn','markDispatched','markUncertain',
    'settleWithReceipt','reconcileUncertainWithReceipt'].every(k => typeof ownerFence[k] === 'function')
      || typeof queryDexLedger !== 'function' || typeof validateDexSource !== 'function'
      || typeof verifyDexFinalReceipt !== 'function') {
    throw new TypeError('TLO ledger gate requires owner fence and trusted Dex readback/validation adapters.');
  }

  function ledger(requestId, expectedStates) {
    const report = queryDexLedger(requestId);
    if (!report || report.reliable !== true) fail('TLO_LEDGER_UNRELIABLE', 'Durable Dex dispatch journal is not reliable.');
    const entry = report.entry;
    if (!entry || entry.requestId !== requestId ||
        entry.targetClassId !== 'local-origin' || entry.targetId !== TLO_TARGET ||
        entry.providerId !== TLO_PROVIDER || entry.dispatchAttempts !== 1) {
      fail('TLO_LEDGER_NOT_PROVEN', 'Exactly one authorized Dex TLO dispatch must exist before owner-fence progress.');
    }
    if (!expectedStates.includes(entry.state)) {
      fail('TLO_LEDGER_BAD_STATE', `Unexpected Dex ledger state ${String(entry.state || '')}.`);
    }
    return entry;
  }
  function validate(input) {
    const args = sourceParams(input);
    // This callback must consult the original, durable Dex room state under its
    // existing authorization/dispatch boundary. Never accept client proof flags.
    if (validateDexSource(args) !== true) {
      fail('TLO_LEDGER_SOURCE_UNVERIFIED', 'No authenticated original Dex source-message binding.');
    }
    return args;
  }
  function authoritativeReceipt(args) {
    ledger(args.requestId, ['completed']);
    const evidence = verifyDexFinalReceipt(args);
    if (!evidence || evidence.confirmed !== true
        || evidence.requestId !== args.requestId || evidence.roomId !== args.roomId
        || evidence.sourceMessageId !== args.sourceMessageId
        || typeof evidence.finalRequestId !== 'string' || !ID.test(evidence.finalRequestId)
        || typeof evidence.responseMessageId !== 'string' || !ID.test(evidence.responseMessageId)) {
      fail('TLO_LEDGER_RECEIPT_UNVERIFIED', 'Missing authoritative source-correlated Dex final receipt.');
    }
    return { source: 'dex-durable-ledger', requestId: args.requestId,
      roomId: args.roomId, sourceMessageId: args.sourceMessageId, confirmed: true,
      finalRequestId: evidence.finalRequestId, responseMessageId: evidence.responseMessageId };
  }
  return Object.freeze({
    // Must be called only AFTER the EXISTING Dex beforeDispatch() succeeds and
    // BEFORE any provider-side transport or inference. Never calls beforeDispatch.
    reserveAdmitted(input) {
      const args = validate(input);
      ledger(args.requestId, ['dispatching']);
      return ownerFence.reserveTurn({ scopeId: args.scopeId, owner: args.owner, requestId: args.requestId });
    },
    // Called by the same trusted server dispatch owner immediately before
    // transport. It never invokes transport itself.
    markBeforeTransport(input) {
      const args = validate(input);
      ledger(args.requestId, ['dispatching']);
      return ownerFence.markDispatched({ scopeId: args.scopeId, owner: args.owner, requestId: args.requestId });
    },
    // A transport failure cannot be interpreted as safe to retry.
    markUncertain(input) {
      const args = validate(input);
      return ownerFence.markUncertain({ scopeId: args.scopeId, requestId: args.requestId });
    },
    // Both the durable dispatch journal and the server-owned exact source/final
    // receipt must match. Neither a UI message nor a caller-supplied boolean is
    // an acceptable final receipt.
    settleAuthoritative(input) {
      const args = validate(input);
      const receipt = authoritativeReceipt(args);
      const ownership = ownerFence.settleWithReceipt({ scopeId: args.scopeId, owner: args.owner,
        requestId: args.requestId,
        finalReceipt: receipt });
      return { ownership, receipt };
    },
    reconcileAuthoritative(input) {
      const args = validate(input);
      const receipt = authoritativeReceipt(args);
      const ownership = ownerFence.reconcileUncertainWithReceipt({
        scopeId: args.scopeId,
        owner: args.owner,
        requestId: args.requestId,
        finalReceipt: receipt
      });
      return { ownership, receipt };
    },
    readOnlyStatus(scopeId = 'default') { return ownerFence.snapshot(scopeId); }
  });
}
module.exports = { TLO_TARGET, TLO_PROVIDER, createTloDexLedgerGate };
