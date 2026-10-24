'use strict';
// Phase 3D-A source-only ownership fence. This module deliberately never invokes
// TLO, creates a scheduler, opens a socket, or owns a conversation transcript.
// Consumers MUST supply an authoritative durable CAS store and authenticate
// owner/handoff claims before calling these methods.
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const SCHEMA = 'eveos.tlo-ownership-fence.v1';
const SCOPE = /^[a-z][a-z0-9_-]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const KINDS = new Set(['browser', 'backend']);
const HASH = /^[a-f0-9]{64}$/;
const HANDOFF_TTL_MS = 60_000;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}
function valid(value, pattern, field) {
  if (typeof value !== 'string' || !pattern.test(value)) fail('TLO_OWNER_INVALID', `Invalid ${field}.`);
  return value;
}
function identity(kind, id) {
  if (!KINDS.has(kind)) fail('TLO_OWNER_INVALID', 'Invalid TLO host kind.');
  valid(id, ID, 'host identity');
  return { kind, id };
}
function digest(value, field) {
  if (typeof value !== 'string' || !HASH.test(value)) fail('TLO_OWNER_INVALID', `Invalid ${field}.`);
  return value;
}
function tokenHash(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 512) {
    fail('TLO_HANDOFF_AUTH_INVALID', 'Handoff acknowledgement secret is invalid.');
  }
  return createHash('sha256').update(value).digest('hex');
}
function sameHash(left, right) {
  const a = Buffer.from(left, 'hex'), b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
function empty(scopeId) {
  return { schema: SCHEMA, scopeId, generation: 0, owner: null, handoff: null, turn: null };
}
function checked(scopeId, state) {
  if (state == null) return empty(scopeId);
  if (state.schema !== SCHEMA || state.scopeId !== scopeId ||
      !Number.isSafeInteger(state.generation) || state.generation < 0 ||
      (state.owner !== null && (!KINDS.has(state.owner?.kind) || !ID.test(state.owner?.id || ''))) ||
      (state.handoff != null && (!ID.test(state.handoff.id || '') ||
        !['prepared', 'acknowledged'].includes(state.handoff.status) ||
        !KINDS.has(state.handoff.from?.kind) || !ID.test(state.handoff.from?.id || '') ||
        !Number.isSafeInteger(state.handoff.from?.generation) ||
        !KINDS.has(state.handoff.to?.kind) || !ID.test(state.handoff.to?.id || '') ||
        state.handoff.toGeneration !== state.handoff.from.generation + 1 ||
        !Number.isFinite(state.handoff.at) || state.handoff.expiresAt !== state.handoff.at + HANDOFF_TTL_MS ||
        !HASH.test(state.handoff.conversationDigest || '') ||
        !ID.test(state.handoff.sourceWorkspaceId || '') ||
        (state.handoff.status === 'prepared' && !HASH.test(state.handoff.tokenHash || '')) ||
        (state.handoff.status === 'acknowledged' && (state.handoff.tokenHash !== null ||
          state.handoff.acknowledgedBy?.kind !== state.handoff.to.kind ||
          state.handoff.acknowledgedBy?.id !== state.handoff.to.id)))) ||
      (state.turn != null && (!ID.test(state.turn.requestId || '') ||
        !['admitted', 'dispatched', 'unknown'].includes(state.turn.phase)))) {
    fail('TLO_OWNER_STATE_CORRUPT', 'TLO ownership state is invalid; stop without repairing it automatically.');
  }
  return structuredClone(state);
}
function createTloOwnershipFence({ read, compareAndSwap, uid = randomUUID, now = Date.now } = {}) {
  if (typeof read !== 'function' || typeof compareAndSwap !== 'function') {
    throw new TypeError('TLO owner fence requires a durable read and atomic compareAndSwap adapter.');
  }
  function snapshot(scopeId = 'default') {
    valid(scopeId, SCOPE, 'scope');
    const record = read(scopeId);
    if (record == null) return { revision: null, state: empty(scopeId) };
    if (!Object.hasOwn(record, 'revision')) fail('TLO_OWNER_STATE_CORRUPT', 'Missing store revision.');
    return { revision: record.revision, state: checked(scopeId, record.state) };
  }
  function change(scopeId, transform) {
    const before = snapshot(scopeId);
    const next = transform(before.state);
    if (compareAndSwap(scopeId, before.revision, next) !== true) {
      fail('TLO_OWNER_RACE', 'Concurrent ownership change; reread and stop, never retry a dispatch.');
    }
    return structuredClone(next);
  }
  function ensureOwner(s, owner) {
    if (!s.owner || s.owner.kind !== owner.kind || s.owner.id !== owner.id ||
        s.generation !== owner.generation) {
      fail('TLO_OWNER_STALE', 'Owner identity or generation is stale.');
    }
  }
  function ownerArgs(kind, id, generation) {
    identity(kind, id);
    if (!Number.isSafeInteger(generation) || generation <= 0) fail('TLO_OWNER_INVALID', 'Invalid generation.');
    return { kind, id, generation };
  }
  return Object.freeze({
    snapshot,
    claimInitialBrowser({ scopeId = 'default', workspaceId } = {}) {
      identity('browser', workspaceId);
      return change(scopeId, s => {
        if (s.owner || s.handoff || s.turn || s.generation !== 0)
          fail('TLO_OWNER_ALREADY_CLAIMED', 'Initial owner may be claimed once only.');
        s.owner = { kind: 'browser', id: workspaceId };
        s.generation = 1;
        return s;
      });
    },
    prepareHandoff({ scopeId = 'default', from, to, conversationDigest,
      sourceWorkspaceId, acknowledgementSecret } = {}) {
      const source = ownerArgs(from?.kind, from?.id, from?.generation);
      const target = identity(to?.kind, to?.id);
      if (source.kind === target.kind) fail('TLO_OWNER_INVALID', 'Handoff must change host kind.');
      digest(conversationDigest, 'conversation digest');
      valid(sourceWorkspaceId, ID, 'source workspace identity');
      const acknowledgementHash = tokenHash(acknowledgementSecret);
      return change(scopeId, s => {
        ensureOwner(s, source);
        if (s.turn || s.handoff) fail('TLO_OWNER_BUSY', 'Cannot hand off with active, unknown, or pending work.');
        const stamp = now();
        s.handoff = {
          id: `tlo-handoff-${uid()}`, status: 'prepared',
          from: { ...s.owner, generation: s.generation }, to: target,
          toGeneration: s.generation + 1,
          conversationDigest,
          sourceWorkspaceId,
          tokenHash: acknowledgementHash,
          acknowledgedBy: null,
          at: stamp,
          expiresAt: stamp + HANDOFF_TTL_MS
        };
        return s;
      });
    },
    acknowledgeHandoff({ scopeId = 'default', handoffId, to, acknowledgementSecret } = {}) {
      const target = identity(to?.kind, to?.id);
      const presentedHash = tokenHash(acknowledgementSecret);
      return change(scopeId, s => {
        if (!s.handoff || s.handoff.id !== handoffId || s.handoff.status !== 'prepared' || s.turn)
          fail('TLO_HANDOFF_STALE', 'Handoff is not prepared at an idle boundary.');
        if (now() > s.handoff.expiresAt) fail('TLO_HANDOFF_EXPIRED', 'Handoff acknowledgement expired.');
        if (s.handoff.to.kind !== target.kind || s.handoff.to.id !== target.id
            || !sameHash(s.handoff.tokenHash, presentedHash)) {
          fail('TLO_HANDOFF_AUTH_INVALID', 'Handoff acknowledgement is not authorized for this target.');
        }
        s.handoff.status = 'acknowledged';
        s.handoff.tokenHash = null;
        s.handoff.acknowledgedBy = target;
        s.handoff.acknowledgedAt = now();
        return s;
      });
    },
    completeHandoff({ scopeId = 'default', handoffId, from } = {}) {
      const source = ownerArgs(from?.kind, from?.id, from?.generation);
      return change(scopeId, s => {
        ensureOwner(s, source);
        if (!s.handoff || s.handoff.id !== handoffId || s.handoff.status !== 'acknowledged' || s.turn)
          fail('TLO_HANDOFF_STALE', 'Handoff lacks acknowledged, idle source ownership.');
        if (!Number.isSafeInteger(s.generation + 1)) fail('TLO_OWNER_STATE_CORRUPT', 'Generation overflow.');
        s.owner = { ...s.handoff.to };
        s.generation += 1;
        s.handoff = null;
        return s;
      });
    },
    cancelPreparedHandoff({ scopeId = 'default', handoffId, from } = {}) {
      const source = ownerArgs(from?.kind, from?.id, from?.generation);
      return change(scopeId, s => {
        ensureOwner(s, source);
        if (!s.handoff || s.handoff.id !== handoffId || s.handoff.status !== 'prepared')
          fail('TLO_HANDOFF_STALE', 'Only an unacknowledged handoff can be cancelled.');
        s.handoff = null;
        return s;
      });
    },
    reserveTurn({ scopeId = 'default', owner, requestId } = {}) {
      const source = ownerArgs(owner?.kind, owner?.id, owner?.generation);
      valid(requestId, ID, 'request ID');
      return change(scopeId, s => {
        ensureOwner(s, source);
        if (s.handoff || s.turn) fail('TLO_OWNER_BUSY', 'A handoff or unresolved turn blocks another dispatch.');
        // The existing Dex durable dispatch ledger MUST have admitted requestId
        // before reserveTurn is called. This fence is not a replacement ledger.
        s.turn = { requestId, ownerGeneration: s.generation, phase: 'admitted', at: now() };
        return s;
      });
    },
    markDispatched({ scopeId = 'default', owner, requestId } = {}) {
      const source = ownerArgs(owner?.kind, owner?.id, owner?.generation);
      return change(scopeId, s => {
        ensureOwner(s, source);
        if (s.turn?.requestId !== requestId || s.turn.phase !== 'admitted')
          fail('TLO_TURN_STALE', 'Turn must be durably marked once before upstream inference.');
        s.turn.phase = 'dispatched';
        return s;
      });
    },
    markUncertain({ scopeId = 'default', requestId } = {}) {
      return change(scopeId, s => {
        if (s.turn?.requestId !== requestId || !['admitted', 'dispatched'].includes(s.turn.phase))
          fail('TLO_TURN_STALE', 'No unresolved turn to fence.');
        s.turn.phase = 'unknown';
        return s;
      });
    },
    settleWithReceipt({ scopeId = 'default', owner, requestId, finalReceipt } = {}) {
      const source = ownerArgs(owner?.kind, owner?.id, owner?.generation);
      return change(scopeId, s => {
        ensureOwner(s, source);
        if (s.turn?.requestId !== requestId || s.turn.ownerGeneration !== source.generation ||
            s.turn.phase !== 'dispatched') fail('TLO_TURN_STALE', 'Turn or generation does not match.');
        if (finalReceipt?.source !== 'dex-durable-ledger' || finalReceipt.requestId !== requestId ||
            finalReceipt.confirmed !== true) fail('TLO_RECEIPT_REQUIRED', 'Correlated authoritative final receipt required.');
        s.turn = null;
        return s;
      });
    },
    reconcileUncertainWithReceipt({ scopeId = 'default', owner, requestId, finalReceipt } = {}) {
      const source = ownerArgs(owner?.kind, owner?.id, owner?.generation);
      return change(scopeId, s => {
        ensureOwner(s, source);
        if (s.turn?.requestId !== requestId || s.turn.ownerGeneration !== source.generation
            || s.turn.phase !== 'unknown') fail('TLO_TURN_STALE', 'No matching uncertain turn can be reconciled.');
        if (finalReceipt?.source !== 'dex-durable-ledger' || finalReceipt.requestId !== requestId
            || finalReceipt.confirmed !== true) fail('TLO_RECEIPT_REQUIRED', 'Correlated authoritative final receipt required.');
        s.turn = null;
        return s;
      });
    },
    // On process restart, an admitted/dispatched turn may have reached upstream.
    // Preserve the request ID and block all new dispatch/handoff until manual
    // reconciliation against the existing durable Dex ledger.
    fenceRestart({ scopeId = 'default' } = {}) {
      const current = snapshot(scopeId);
      if (!current.state.turn || current.state.turn.phase === 'unknown') return current.state;
      return change(scopeId, s => {
        s.turn.phase = 'unknown';
        return s;
      });
    }
  });
}
module.exports = { SCHEMA, HANDOFF_TTL_MS, createTloOwnershipFence };
