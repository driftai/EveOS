'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateProof, createTrustedTerminalAttachmentRegistry } = require('../machine-spaces/trusted-terminal-attachment');

const ADAPTER_SECRET = 'server-side-adapter-secret';

function fixture({ trusted = true } = {}) {
  let clock = Date.parse('2026-10-08T13:00:00.000Z');
  let n = 0;
  let secret = trusted ? ADAPTER_SECRET : null;
  const registry = createTrustedTerminalAttachmentRegistry({
    now: () => clock,
    idFactory: () => `id-${++n}`,
    getAdapterSecret: (adapterId) => adapterId === 'adapter-one' ? secret : null,
    challengeTtlMs: 10000,
    trustTtlMs: 60000
  });
  return {
    registry,
    advance(ms) { clock += ms; },
    revokeAdapterCredential() { secret = null; }
  };
}

function challenge(registry) {
  return registry.begin({
    targetId: 'external-terminal-one', processEpoch: 'process-epoch-one', adapterId: 'adapter-one',
    ownerId: 'machine-owner-one', cwd: 'C:\\repo', shellType: 'powershell'
  });
}

function proof(opened, secret = ADAPTER_SECRET) {
  return calculateProof(opened, secret);
}

test('unregistered adapters cannot even obtain an attachment challenge', () => {
  const { registry } = fixture({ trusted: false });
  assert.throws(() => challenge(registry), { code: 'MACHINE_TRUSTED_ATTACH_ADAPTER_UNTRUSTED' });
});

test('trusted attach requires exact one-time challenge proof and local owner identity', () => {
  const { registry } = fixture();
  const opened = challenge(registry);
  const record = registry.attest({ challengeId: opened.challengeId, ownerId: 'machine-owner-one', proof: proof(opened) });
  assert.equal(record.enabled, true);
  assert.deepEqual(record.capabilities, ['observe', 'interrupt']);
  assert.throws(() => registry.attest({ challengeId: opened.challengeId, ownerId: 'machine-owner-one', proof: proof(opened) }), {
    code: 'MACHINE_TRUSTED_ATTACH_CHALLENGE_UNKNOWN'
  });
});

test('bad proof, wrong owner, revoked adapter credential and expired challenge fail closed', () => {
  const wrongProof = fixture();
  const first = challenge(wrongProof.registry);
  assert.throws(() => wrongProof.registry.attest({ challengeId: first.challengeId, ownerId: 'machine-owner-one', proof: 'bad' }), {
    code: 'MACHINE_TRUSTED_ATTACH_PROOF_INVALID'
  });

  const wrongOwner = fixture();
  const second = challenge(wrongOwner.registry);
  assert.throws(() => wrongOwner.registry.attest({ challengeId: second.challengeId, ownerId: 'other-owner', proof: proof(second) }), {
    code: 'MACHINE_TRUSTED_ATTACH_OWNER_MISMATCH'
  });

  const revoked = fixture();
  const revokedChallenge = challenge(revoked.registry);
  revoked.revokeAdapterCredential();
  assert.throws(() => revoked.registry.attest({ challengeId: revokedChallenge.challengeId, ownerId: 'machine-owner-one', proof: proof(revokedChallenge) }), {
    code: 'MACHINE_TRUSTED_ATTACH_ADAPTER_UNTRUSTED'
  });

  const expired = fixture();
  const third = challenge(expired.registry);
  expired.advance(10001);
  assert.throws(() => expired.registry.attest({ challengeId: third.challengeId, ownerId: 'machine-owner-one', proof: proof(third) }), {
    code: 'MACHINE_TRUSTED_ATTACH_CHALLENGE_EXPIRED'
  });
});

test('trusted attachment never grants command execution authority', () => {
  const { registry } = fixture();
  const opened = challenge(registry);
  const record = registry.attest({ challengeId: opened.challengeId, ownerId: 'machine-owner-one', proof: proof(opened) });
  assert.equal(registry.authorize(record.attachmentId, {
    targetId: record.targetId, processEpoch: record.processEpoch, adapterId: record.adapterId, capability: 'observe'
  }).allowed, true);
  assert.equal(registry.authorize(record.attachmentId, {
    targetId: record.targetId, processEpoch: record.processEpoch, adapterId: record.adapterId, capability: 'execute'
  }).reason, 'capability-not-trusted');
  assert.equal(registry.authorize(record.attachmentId, {
    targetId: record.targetId, processEpoch: 'replacement', adapterId: record.adapterId, capability: 'observe'
  }).reason, 'identity-mismatch');
});

test('expiry and local revocation invalidate attachment immediately', () => {
  const { registry, advance } = fixture();
  const opened = challenge(registry);
  const record = registry.attest({ challengeId: opened.challengeId, ownerId: 'machine-owner-one', proof: proof(opened) });
  advance(60001);
  assert.equal(registry.authorize(record.attachmentId, {
    targetId: record.targetId, processEpoch: record.processEpoch, adapterId: record.adapterId, capability: 'observe'
  }).reason, 'attachment-expired');

  const next = challenge(registry);
  const trusted = registry.attest({ challengeId: next.challengeId, ownerId: 'machine-owner-one', proof: proof(next) });
  registry.revoke(trusted.attachmentId);
  assert.equal(registry.authorize(trusted.attachmentId, {
    targetId: trusted.targetId, processEpoch: trusted.processEpoch, adapterId: trusted.adapterId, capability: 'observe'
  }).reason, 'attachment-disabled');
});
