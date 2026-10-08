'use strict';

const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const POLICY_ID = 'machine-files-v1';
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CAPABILITIES = new Set([
  'files.list',
  'files.stat',
  'files.read',
  'files.search',
  'files.create',
  'files.write',
  'files.patch',
  'files.move',
  'files.delete'
]);
const MUTATING_CAPABILITIES = new Set([
  'files.create', 'files.write', 'files.patch', 'files.move', 'files.delete'
]);

function grantError(code, message) { return Object.assign(new Error(message), { code }); }
function cleanRoot(value) {
  const root = String(value || '').trim();
  if (!root || root.length > 1024 || root.includes('\0'))
    throw grantError('MACHINE_BAD_FILE_ROOT', 'Filesystem grants require one bounded canonical repository root.');
  return root;
}
function pathApiFor(value) { return /^[A-Za-z]:[\\/]/.test(String(value || '')) ? path.win32 : path; }
function normalizeRoot(value) {
  const api = pathApiFor(value);
  const resolved = api.resolve(cleanRoot(value));
  return resolved.length > 3 ? resolved.replace(/[\\/]+$/, '') : resolved;
}
function sameRoot(a, b) {
  if (!a || !b) return false;
  const api = pathApiFor(a);
  const left = normalizeRoot(a), right = normalizeRoot(b);
  return api === path.win32 ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function cleanCapability(value) {
  const capability = String(value || '').trim().toLowerCase();
  if (!CAPABILITIES.has(capability))
    throw grantError('MACHINE_BAD_FILE_CAPABILITY', `Unsupported Machine Spaces capability: ${capability || '(empty)'}.`);
  return capability;
}
function normalizeCapabilities(values) {
  const source = Array.isArray(values) ? values : [values];
  const capabilities = [...new Set(source.filter((value) => String(value || '').trim()).map(cleanCapability))].sort();
  if (!capabilities.length)
    throw grantError('MACHINE_BAD_FILE_CAPABILITY', 'At least one filesystem capability is required.');
  return capabilities;
}
function boundedTtl(value, mode) {
  if (mode === 'once') return Math.min(MAX_TTL_MS, Math.max(60_000, Number(value) || 15 * 60_000));
  return Math.min(MAX_TTL_MS, Math.max(60_000, Number(value) || DEFAULT_TTL_MS));
}
function scopeDigest({ repoRoot, targetId, capabilities, mode }) {
  return createHash('sha256').update(JSON.stringify({
    repoRoot: normalizeRoot(repoRoot),
    targetId: String(targetId || ''),
    capabilities: normalizeCapabilities(capabilities),
    mode: String(mode || '')
  })).digest('hex');
}
function createCapabilityGrant({
  repoRoot,
  targetId,
  ownerId,
  capabilities,
  mode = 'persistent',
  ttlMs = null,
  now = () => Date.now(),
  idFactory = () => `machine-file-grant-${randomUUID()}`
} = {}) {
  const cleanMode = String(mode || '').toLowerCase();
  if (!['once', 'persistent'].includes(cleanMode))
    throw grantError('MACHINE_BAD_FILE_GRANT_MODE', 'Filesystem grants must be allow-once or persistent.');
  if (!String(targetId || '').trim() || !String(ownerId || '').trim())
    throw grantError('MACHINE_BAD_FILE_GRANT', 'Filesystem grants require one exact target and local owner identity.');
  const root = normalizeRoot(repoRoot);
  const normalizedCaps = normalizeCapabilities(capabilities);
  const createdAtMs = now();
  const expiresAtMs = createdAtMs + boundedTtl(ttlMs, cleanMode);
  return {
    id: idFactory(),
    policy: POLICY_ID,
    enabled: true,
    mode: cleanMode,
    repoRoot: root,
    targetId: String(targetId),
    capabilities: normalizedCaps,
    createdByOwnerId: String(ownerId),
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    revokedAt: null,
    revokedReason: null,
    usesRemaining: cleanMode === 'once' ? 1 : null,
    scopeDigest: scopeDigest({ repoRoot: root, targetId, capabilities: normalizedCaps, mode: cleanMode })
  };
}
function publicCapabilityGrant(grant) {
  if (!grant || typeof grant !== 'object') return null;
  return {
    id: grant.id || null,
    policy: grant.policy || null,
    enabled: grant.enabled === true,
    mode: grant.mode || null,
    repoRoot: grant.repoRoot || null,
    targetId: grant.targetId || null,
    capabilities: Array.isArray(grant.capabilities) ? [...grant.capabilities] : [],
    createdAt: grant.createdAt || null,
    expiresAt: grant.expiresAt || null,
    revokedAt: grant.revokedAt || null,
    revokedReason: grant.revokedReason || null,
    usesRemaining: Number.isInteger(grant.usesRemaining) ? grant.usesRemaining : null,
    scopeDigest: grant.scopeDigest || null
  };
}
function revokeCapabilityGrant(grant, { reason = 'owner-revoked', now = () => Date.now() } = {}) {
  if (!grant || typeof grant !== 'object') return null;
  if (grant.enabled === true) {
    grant.enabled = false;
    grant.revokedAt = new Date(now()).toISOString();
    grant.revokedReason = String(reason || 'owner-revoked').slice(0, 80);
  }
  return publicCapabilityGrant(grant);
}
function authorizeCapabilityGrant(grant, {
  repoRoot,
  targetId,
  capability,
  now = () => Date.now(),
  consume = false
} = {}) {
  let wanted;
  try { wanted = cleanCapability(capability); }
  catch (error) { return { allowed: false, reason: error.code || 'bad-capability', grant: publicCapabilityGrant(grant) }; }
  if (!grant || grant.policy !== POLICY_ID) return { allowed: false, reason: 'missing-grant', grant: publicCapabilityGrant(grant) };
  if (grant.enabled !== true) return { allowed: false, reason: 'grant-disabled', grant: publicCapabilityGrant(grant) };
  if (!sameRoot(grant.repoRoot, repoRoot)) return { allowed: false, reason: 'root-mismatch', grant: publicCapabilityGrant(grant) };
  if (String(grant.targetId || '') !== String(targetId || '')) return { allowed: false, reason: 'target-mismatch', grant: publicCapabilityGrant(grant) };
  if (!Array.isArray(grant.capabilities) || !grant.capabilities.includes(wanted))
    return { allowed: false, reason: 'capability-not-granted', grant: publicCapabilityGrant(grant) };
  const expiry = Date.parse(String(grant.expiresAt || ''));
  if (!Number.isFinite(expiry) || expiry <= now()) {
    revokeCapabilityGrant(grant, { reason: 'expired', now });
    return { allowed: false, reason: 'grant-expired', grant: publicCapabilityGrant(grant) };
  }
  if (grant.mode === 'once' && (!Number.isInteger(grant.usesRemaining) || grant.usesRemaining <= 0)) {
    revokeCapabilityGrant(grant, { reason: 'consumed', now });
    return { allowed: false, reason: 'grant-consumed', grant: publicCapabilityGrant(grant) };
  }
  if (consume && grant.mode === 'once') {
    grant.usesRemaining -= 1;
    if (grant.usesRemaining <= 0) revokeCapabilityGrant(grant, { reason: 'consumed', now });
  }
  return { allowed: true, reason: 'granted', capability: wanted, grant: publicCapabilityGrant(grant) };
}
function capabilityRisk(capability) {
  const wanted = cleanCapability(capability);
  return MUTATING_CAPABILITIES.has(wanted) ? 'mutation' : 'read-only';
}

module.exports = {
  POLICY_ID,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  CAPABILITIES,
  MUTATING_CAPABILITIES,
  normalizeRoot,
  sameRoot,
  normalizeCapabilities,
  scopeDigest,
  createCapabilityGrant,
  publicCapabilityGrant,
  revokeCapabilityGrant,
  authorizeCapabilityGrant,
  capabilityRisk
};
