'use strict';

const { randomUUID } = require('node:crypto');

const SCHEMA = 'eveos.tlo-dispatch-capability.v1';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const SCOPE = /^[a-z][a-z0-9_-]{0,63}$/;
const DEFAULT_TTL_MS = 15_000;

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function exact(value, pattern, label) {
  const text = String(value || '').trim();
  if (!pattern.test(text)) fail('TLO_DISPATCH_CAPABILITY_INVALID', `Invalid ${label}.`);
  return text;
}

function binding(input = {}) {
  const owner = input.owner || {};
  if (!['browser', 'backend'].includes(owner.kind)
      || !Number.isSafeInteger(owner.generation) || owner.generation <= 0) {
    fail('TLO_DISPATCH_CAPABILITY_INVALID', 'Invalid TLO dispatch owner.');
  }
  return {
    scopeId: exact(input.scopeId || 'default', SCOPE, 'scope'),
    owner: { kind: owner.kind, id: exact(owner.id, ID, 'owner ID'), generation: owner.generation },
    requestId: exact(input.requestId, ID, 'request ID'),
    roomId: exact(input.roomId, ID, 'room ID'),
    sourceMessageId: exact(input.sourceMessageId, ID, 'source message ID'),
    targetId: exact(input.targetId, ID, 'target ID'),
    transport: exact(input.transport, ID, 'transport')
  };
}

function sameBinding(left, right) {
  return left.scopeId === right.scopeId
    && left.owner.kind === right.owner.kind
    && left.owner.id === right.owner.id
    && left.owner.generation === right.owner.generation
    && left.requestId === right.requestId
    && left.roomId === right.roomId
    && left.sourceMessageId === right.sourceMessageId
    && left.targetId === right.targetId
    && left.transport === right.transport;
}

function createTloDispatchCapabilityBroker({ now = Date.now, uid = randomUUID,
  ttlMs = DEFAULT_TTL_MS } = {}) {
  if (typeof now !== 'function' || typeof uid !== 'function'
      || !Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60_000) {
    throw new TypeError('TLO dispatch capability broker configuration is invalid.');
  }
  const records = new WeakMap();

  function issue(input) {
    const exactBinding = binding(input);
    const dispatchId = `tlo-dispatch-${uid()}`;
    exact(dispatchId, ID, 'dispatch ID');
    const issuedAt = now();
    const capability = Object.freeze({ schema: SCHEMA, dispatchId, expiresAt: issuedAt + ttlMs });
    records.set(capability, { binding: exactBinding, dispatchId, issuedAt,
      expiresAt: capability.expiresAt, consumed: false });
    return capability;
  }

  function consume(capability, input) {
    const record = capability && typeof capability === 'object' ? records.get(capability) : null;
    if (!record || record.consumed) {
      fail('TLO_DISPATCH_CAPABILITY_REQUIRED', 'A live one-use TLO dispatch capability is required.');
    }
    // A capability object is burned on its first presentation. It is never
    // serializable and cannot be reconstructed by a browser or socket client.
    record.consumed = true;
    records.delete(capability);
    if (now() > record.expiresAt) fail('TLO_DISPATCH_CAPABILITY_EXPIRED', 'TLO dispatch capability expired.');
    const presented = binding(input);
    if (!sameBinding(record.binding, presented)) {
      fail('TLO_DISPATCH_CAPABILITY_MISMATCH', 'TLO dispatch capability does not match this exact turn.');
    }
    return Object.freeze({ ...structuredClone(record.binding), dispatchId: record.dispatchId,
      issuedAt: record.issuedAt, expiresAt: record.expiresAt });
  }

  return Object.freeze({ issue, consume });
}

module.exports = { SCHEMA, DEFAULT_TTL_MS, createTloDispatchCapabilityBroker };
