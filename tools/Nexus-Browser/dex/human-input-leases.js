'use strict';

const { randomBytes, randomUUID } = require('node:crypto');

const HUMAN_OPERATIONS = Object.freeze([
  'state:edit', 'room:delete', 'relay:stop', 'relay:continue', 'machine:control'
]);
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 10 * 60 * 1000;
const RETAIN_MS = 5 * 60 * 1000;

function failure(code, message) { return { ok: false, code, message }; }
function scopeFor(value = {}) {
  if (value.type === 'create') return Object.freeze({ type: 'create' });
  const roomId = String(value.roomId || '').trim();
  return roomId ? Object.freeze({ type: 'room', roomId }) : null;
}

function createHumanInputLeaseAuthority({
  serverEpoch,
  now = () => Date.now(),
  tokenFactory = () => randomBytes(32).toString('base64url'),
  actorFactory = () => `dex-controller-${randomUUID()}`,
  defaultTtlMs = DEFAULT_TTL_MS,
  maxTtlMs = MAX_TTL_MS
} = {}) {
  if (!String(serverEpoch || '').trim()) throw new TypeError('Human Input leases require a server epoch.');
  let epoch = String(serverEpoch), controllerGeneration = 0;
  const actors = new WeakMap(), grants = new Map();

  function prune() {
    const stamp = now();
    for (const [token, grant] of grants) {
      if (stamp > grant.expiresAtMs + RETAIN_MS) grants.delete(token);
    }
  }
  function registerSocket(ws) {
    if (!ws || (typeof ws !== 'object' && typeof ws !== 'function')) throw new TypeError('A live Dex socket is required.');
    if (!actors.has(ws)) actors.set(ws, Object.freeze({ actorId: actorFactory() }));
    return actors.get(ws);
  }
  function publicGrant(grant) {
    return Object.freeze({
      token: grant.token,
      actorId: grant.actorId,
      serverEpoch: grant.serverEpoch,
      generation: grant.generation,
      scope: grant.scope,
      roomId: grant.scope.type === 'room' ? grant.scope.roomId : null,
      operations: [...grant.operations],
      expiresAt: new Date(grant.expiresAtMs).toISOString(),
      kind: grant.kind,
      requestId: grant.requestId || null
    });
  }
  function issue(ws, { kind = 'human-input', scope, operations = [], ttlMs, requestId = null, action = null } = {}) {
    prune();
    const actor = registerSocket(ws), normalizedScope = scopeFor(scope);
    if (!normalizedScope) throw new TypeError('A Human Input grant requires an exact room or creation scope.');
    const allowed = [...new Set(operations.map(String).filter(Boolean))];
    if (!allowed.length) throw new TypeError('A Human Input grant requires at least one operation.');
    const boundedTtl = Math.max(1, Math.min(maxTtlMs, Number(ttlMs) || defaultTtlMs));
    const token = tokenFactory();
    const grant = {
      token, kind, socket: ws, actorId: actor.actorId, serverEpoch: epoch,
      generation: controllerGeneration, scope: normalizedScope,
      operations: new Set(allowed), issuedAtMs: now(), expiresAtMs: now() + boundedTtl,
      requestId: requestId ? String(requestId) : null, action: action ? String(action) : null,
      usedOperations: new Set(), consumed: false, revokedCode: null
    };
    grants.set(token, grant);
    return publicGrant(grant);
  }
  function issueHuman(ws, options = {}) {
    return issue(ws, { ...options, kind: 'human-input',
      operations: options.operations || (options.scope?.type === 'create' ? ['room:create'] : HUMAN_OPERATIONS) });
  }
  function issueAgent(ws, options = {}) {
    return issue(ws, { ...options, kind: 'agent-control', ttlMs: options.ttlMs || 20000 });
  }
  function revokeGrant(grant, code = 'DEX_HUMAN_LEASE_REVOKED') {
    if (!grant || grant.revokedCode || grant.consumed) return false;
    grant.revokedCode = code;
    return true;
  }
  function revokeToken(token, code) { return revokeGrant(grants.get(String(token || '')), code); }
  function revokeSocket(ws, code = 'DEX_HUMAN_LEASE_REVOKED', kind = null) {
    let count = 0;
    for (const grant of grants.values()) {
      if (grant.socket === ws && (!kind || grant.kind === kind) && revokeGrant(grant, code)) count += 1;
    }
    if (!kind) actors.delete(ws);
    return count;
  }
  function revokeAll(code = 'DEX_HUMAN_LEASE_REVOKED') {
    let count = 0;
    for (const grant of grants.values()) if (revokeGrant(grant, code)) count += 1;
    return count;
  }
  function setControllerGeneration(value) {
    const next = Number(value);
    if (!Number.isInteger(next) || next < 0) throw new TypeError('Controller generation must be a non-negative integer.');
    if (next !== controllerGeneration) {
      controllerGeneration = next;
      revokeAll('DEX_HUMAN_LEASE_GENERATION_STALE');
    }
    return controllerGeneration;
  }
  function setServerEpoch(value) {
    const next = String(value || '').trim();
    if (!next) throw new TypeError('Server epoch cannot be empty.');
    if (next !== epoch) {
      epoch = next;
      revokeAll('DEX_HUMAN_LEASE_EPOCH_STALE');
    }
    return epoch;
  }
  function validate(ws, presented = {}, { operation, roomId = null, scopeType = null, kind = null,
    requestId = null, action = null, consume = false, consumeOperation = false } = {}) {
    prune();
    const token = String(presented?.token || '');
    if (!token) return failure('DEX_HUMAN_LEASE_REQUIRED', 'This operation requires an active server-issued Human Input authorization lease.');
    if (presented.serverEpoch != null && String(presented.serverEpoch) !== epoch)
      return failure('DEX_HUMAN_LEASE_EPOCH_STALE', 'The Human Input authorization belongs to an earlier server session.');
    if (presented.generation != null && Number(presented.generation) !== controllerGeneration)
      return failure('DEX_HUMAN_LEASE_GENERATION_STALE', 'Dex controller ownership changed after this authorization was issued.');
    const grant = grants.get(token);
    if (!grant) return failure('DEX_HUMAN_LEASE_REVOKED', 'The Human Input authorization is unknown or has been revoked.');
    if (grant.socket !== ws) return failure('DEX_HUMAN_LEASE_SOCKET_MISMATCH', 'The Human Input authorization belongs to a different live connection.');
    if (grant.revokedCode) return failure(grant.revokedCode, 'The Human Input authorization has been revoked.');
    const actor = actors.get(ws);
    if (!actor || actor.actorId !== grant.actorId || (presented.actorId != null && presented.actorId !== grant.actorId))
      return failure('DEX_HUMAN_LEASE_ACTOR_MISMATCH', 'The Human Input controller identity does not match this authorization.');
    if (grant.serverEpoch !== epoch) return failure('DEX_HUMAN_LEASE_EPOCH_STALE', 'The Human Input authorization belongs to an earlier server session.');
    if (grant.generation !== controllerGeneration) return failure('DEX_HUMAN_LEASE_GENERATION_STALE', 'Dex controller ownership changed after this authorization was issued.');
    if (now() >= grant.expiresAtMs) return failure('DEX_HUMAN_LEASE_EXPIRED', 'The Human Input authorization expired; enable it again for this exact room.');
    if (grant.consumed) return failure('DEX_HUMAN_LEASE_REPLAYED', 'This one-use Human Input authorization was already consumed.');
    if (kind && grant.kind !== kind) return failure('DEX_HUMAN_LEASE_KIND_MISMATCH', 'This authorization was issued for a different control path.');
    if (grant.kind === 'agent-control' && (requestId != null || action != null)
        && (!requestId || !action || grant.requestId !== String(requestId) || grant.action !== String(action)))
      return failure('DEX_AGENT_GRANT_REQUEST_MISMATCH', 'The provider grant does not belong to this exact pending command.');
    if (!grant.operations.has(String(operation || '')))
      return failure('DEX_HUMAN_LEASE_OPERATION_DENIED', 'This authorization does not allow the requested operation.');
    if (scopeType && grant.scope.type !== scopeType)
      return failure('DEX_HUMAN_LEASE_SCOPE_MISMATCH', 'This authorization has a different scope.');
    if (roomId != null && (grant.scope.type !== 'room' || grant.scope.roomId !== String(roomId)))
      return failure('DEX_HUMAN_LEASE_SCOPE_MISMATCH', 'This authorization belongs to a different Dex room.');
    if (consumeOperation && grant.usedOperations.has(String(operation || '')))
      return failure('DEX_AGENT_GRANT_REPLAYED', 'This provider operation has already been used by the pending command.');
    if (consume) grant.consumed = true;
    if (consumeOperation) grant.usedOperations.add(String(operation || ''));
    return { ok: true, grant, lease: publicGrant(grant) };
  }
  function diagnostics() {
    const active = [...grants.values()].filter(grant => !grant.revokedCode && !grant.consumed && now() < grant.expiresAtMs);
    return { serverEpoch: epoch, controllerGeneration, active: active.length,
      human: active.filter(grant => grant.kind === 'human-input').length,
      agent: active.filter(grant => grant.kind === 'agent-control').length };
  }

  return { registerSocket, issueHuman, issueAgent, validate, revokeToken, revokeSocket, revokeAll,
    setControllerGeneration, setServerEpoch, diagnostics, publicGrant,
    epoch: () => epoch, generation: () => controllerGeneration };
}

module.exports = { HUMAN_OPERATIONS, DEFAULT_TTL_MS, MAX_TTL_MS, scopeFor, createHumanInputLeaseAuthority };
