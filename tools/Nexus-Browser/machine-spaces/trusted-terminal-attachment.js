'use strict';

const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');

function text(value) { return String(value ?? '').trim(); }
function fail(code, message) { return Object.assign(new Error(message), { code }); }
function digest(value) { return createHash('sha256').update(String(value)).digest(); }
function publicRecord(record) {
  if (!record) return null;
  return {
    attachmentId: record.attachmentId,
    targetId: record.targetId,
    processEpoch: record.processEpoch,
    adapterId: record.adapterId,
    cwd: record.cwd,
    shellType: record.shellType,
    ownerId: record.ownerId,
    trustedAt: record.trustedAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    revokedReason: record.revokedReason,
    enabled: record.enabled === true,
    capabilities: [...record.capabilities]
  };
}

function createTrustedTerminalAttachmentRegistry(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : () => randomUUID();
  const challengeTtlMs = Math.max(10_000, Number(options.challengeTtlMs) || 120_000);
  const trustTtlMs = Math.max(60_000, Number(options.trustTtlMs) || 8 * 60 * 60 * 1000);
  const challenges = new Map();
  const records = new Map();

  function begin(input = {}) {
    const targetId = text(input.targetId), processEpoch = text(input.processEpoch), adapterId = text(input.adapterId);
    const ownerId = text(input.ownerId), cwd = text(input.cwd), shellType = text(input.shellType);
    if (!targetId || !processEpoch || !adapterId || !ownerId || !cwd || !shellType)
      throw fail('MACHINE_TRUSTED_ATTACH_IDENTITY_REQUIRED', 'Trusted attachment requires exact target, process epoch, adapter, owner, cwd and shell identity.');
    const challengeId = `trusted-attach-challenge-${idFactory()}`;
    const nonce = randomUUID();
    const createdAtMs = now();
    challenges.set(challengeId, {
      challengeId, nonce, targetId, processEpoch, adapterId, ownerId, cwd, shellType,
      createdAtMs, expiresAtMs: createdAtMs + challengeTtlMs
    });
    return {
      challengeId,
      nonce,
      targetId,
      processEpoch,
      adapterId,
      expiresAt: new Date(createdAtMs + challengeTtlMs).toISOString()
    };
  }

  function expectedProof(challenge, adapterSecret) {
    return createHash('sha256').update(JSON.stringify({
      nonce: challenge.nonce,
      targetId: challenge.targetId,
      processEpoch: challenge.processEpoch,
      adapterId: challenge.adapterId,
      cwd: challenge.cwd,
      shellType: challenge.shellType,
      adapterSecret: text(adapterSecret)
    })).digest('hex');
  }

  function attest(input = {}) {
    const challengeId = text(input.challengeId);
    const challenge = challenges.get(challengeId);
    if (!challenge) throw fail('MACHINE_TRUSTED_ATTACH_CHALLENGE_UNKNOWN', 'Trusted attachment challenge is missing or already consumed.');
    challenges.delete(challengeId);
    if (challenge.expiresAtMs <= now()) throw fail('MACHINE_TRUSTED_ATTACH_CHALLENGE_EXPIRED', 'Trusted attachment challenge expired.');
    const proof = text(input.proof);
    const expected = expectedProof(challenge, input.adapterSecret);
    if (!proof || proof.length !== expected.length || !timingSafeEqual(digest(proof), digest(expected)))
      throw fail('MACHINE_TRUSTED_ATTACH_PROOF_INVALID', 'Terminal adapter attestation did not match the exact challenge.');
    if (text(input.ownerId) !== challenge.ownerId)
      throw fail('MACHINE_TRUSTED_ATTACH_OWNER_MISMATCH', 'Only the local owner that opened the challenge may trust this terminal.');
    const attachmentId = `trusted-terminal-${idFactory()}`;
    const stamp = now();
    const record = {
      attachmentId,
      targetId: challenge.targetId,
      processEpoch: challenge.processEpoch,
      adapterId: challenge.adapterId,
      ownerId: challenge.ownerId,
      cwd: challenge.cwd,
      shellType: challenge.shellType,
      capabilities: Object.freeze(['observe', 'interrupt']),
      trustedAt: new Date(stamp).toISOString(),
      expiresAt: new Date(stamp + trustTtlMs).toISOString(),
      revokedAt: null,
      revokedReason: null,
      enabled: true
    };
    records.set(attachmentId, record);
    return publicRecord(record);
  }

  function authorize(attachmentId, input = {}) {
    const record = records.get(text(attachmentId));
    if (!record || record.enabled !== true) return { allowed: false, reason: 'attachment-disabled', attachment: publicRecord(record) };
    if (Date.parse(record.expiresAt) <= now()) {
      record.enabled = false; record.revokedAt = new Date(now()).toISOString(); record.revokedReason = 'expired';
      return { allowed: false, reason: 'attachment-expired', attachment: publicRecord(record) };
    }
    if (text(input.targetId) !== record.targetId || text(input.processEpoch) !== record.processEpoch || text(input.adapterId) !== record.adapterId)
      return { allowed: false, reason: 'identity-mismatch', attachment: publicRecord(record) };
    const capability = text(input.capability);
    if (!record.capabilities.includes(capability)) return { allowed: false, reason: 'capability-not-trusted', attachment: publicRecord(record) };
    return { allowed: true, reason: 'trusted', attachment: publicRecord(record) };
  }

  function revoke(attachmentId, reason = 'owner-revoked') {
    const record = records.get(text(attachmentId));
    if (!record) return null;
    if (record.enabled) {
      record.enabled = false; record.revokedAt = new Date(now()).toISOString(); record.revokedReason = text(reason).slice(0, 80) || 'owner-revoked';
    }
    return publicRecord(record);
  }

  function list() { return [...records.values()].map(publicRecord); }

  return { begin, expectedProof, attest, authorize, revoke, list };
}

module.exports = { createTrustedTerminalAttachmentRegistry };
