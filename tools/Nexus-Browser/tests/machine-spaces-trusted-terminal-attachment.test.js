'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrustedTerminalAttachmentRegistry } = require('../machine-spaces/trusted-terminal-attachment');

function fixture() {
  let clock = Date.parse('2026-10-08T13:00:00.000Z');
  let n = 0;
  const registry = createTrustedTerminalAttachmentRegistry({
    now: () => clock,
    idFactory: () => `id-${++n}`,
    challengeTtlMs: 10000,
    trustTtlMs: 60000
  });
  return { registry, advance(ms) { clock += ms; } };
}

function challenge(registry) {
  return registry.begin({
    targetId: 'external-terminal-one', processEpoch: 'process-epoch-one', adapterId: 'adapter-one',
    ownerId: 'machine-owner-one', cwd: 'C:\\repo', shellType: 'powershell'
  });
}

test('trusted attach requires exact one-time challenge proof and local owner identity', () => {
  const { registry } = fixture();
  const opened = challenge(registry);
  const adapterSecret = 'ephemeral-adapter-proof';
  const proof = registry.expectedProof({
    ...opened,
    cwd: 'C:\\repo', shellType: 'powershell', ownerId: 'machine-owner-one'
  }, adapterSecret);
  const record = registry.attest({ challengeId: opened.challengeId, ownerId: 'machine-owner-one', adapterSecret, proof });
  assert.equal(record.enabled, true);
  assert.deepEqual(record.capabilities, ['observe', 'interrupt']);
  assert.throws(() => registry.attest({ challengeId: opened.challengeId, ownerId: 'machine-owner-one', adapterSecret, proof }), {
    code: 'MACHINE_TRUSTED_ATTACH_CHALLENGE_UNKNOWN'
  });
});

test('bad proof, wrong owner and expired challenge fail closed', () => {
  const wrongProof = fixture();
  const first = challenge(wrongProof.registry);
  assert.throws(() => wrongProof.registry.attest({ challengeId: first.challengeId, ownerId: 'machine-owner-one', adapterSecret: 'x', proof: 'bad' }), {
    code: 'MACHINE_TRUSTED_ATTACH_PROOF_INVALID'
  });

  const wrongOwner = fixture();
  const second = challenge(wrongOwner.registry);
  const secret = 'proof';
  const proof = wrongOwner.registry.expectedProof({ ...second, cwd: 'C:\\repo', shellType: 'powershell', ownerId: 'machine-owner-one' }, secret);
  assert.throws(() => wrongOwner.registry.attest({ challengeId: second.challengeId, ownerId: 'other-owner', adapterSecret: secret, proof }), {
    code: 'MACHINE_TRUSTED_ATTACH_OWNER_MISMATCH'
  });

  const expired = fixture();
  const third = challenge(expired.registry);
  expired.advance(10001);
  const expiredProof = expired.registry.expectedProof({ ...third, cwd: 'C:\\repo', shellType: 'powershell', ownerId: 'machine-owner-one' }, secret);
  assert.throws(() => expired.registry.attest({ challengeId: third.challengeId, ownerId: 'machine-owner-one', adapterSecret: secret, proof: expiredProof }), {
    code: 'MACHINE_TRUSTED_ATTACH_CHALLENGE_EXPIRED'
  });
});

test('trusted attachment never grants command execution authority', () => {
  const { registry } = fixture();
  const opened = challenge(registry), secret = 'proof';
  const proof = registry.expectedProof({ ...opened, cwd: 'C:\\repo', shellType: 'powershell', ownerId: 'machine-owner-one' }, secret);
  const record = registry.attest({ challengeId: opened.challengeId, ownerId: 'machine-owner-one', adapterSecret: secret, proof });
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
  const opened = challenge(registry), secret = 'proof';
  const proof = registry.expectedProof({ ...opened, cwd: 'C:\\repo', shellType: 'powershell', ownerId: 'machine-owner-one' }, secret);
  const record = registry.attest({ challengeId: opened.challengeId, ownerId: 'machine-owner-one', adapterSecret: secret, proof });
  advance(60001);
  assert.equal(registry.authorize(record.attachmentId, {
    targetId: record.targetId, processEpoch: record.processEpoch, adapterId: record.adapterId, capability: 'observe'
  }).reason, 'attachment-expired');

  const next = challenge(registry);
  const nextProof = registry.expectedProof({ ...next, cwd: 'C:\\repo', shellType: 'powershell', ownerId: 'machine-owner-one' }, secret);
  const trusted = registry.attest({ challengeId: next.challengeId, ownerId: 'machine-owner-one', adapterSecret: secret, proof: nextProof });
  registry.revoke(trusted.attachmentId);
  assert.equal(registry.authorize(trusted.attachmentId, {
    targetId: trusted.targetId, processEpoch: trusted.processEpoch, adapterId: trusted.adapterId, capability: 'observe'
  }).reason, 'attachment-disabled');
});
