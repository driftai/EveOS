'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { proposeEnrollment } = require('../dex/local-session-enrollment');
const ID = 'local:antigravity-existing:25032', NOW = 170000;
const A = 'a'.repeat(64), B = 'b'.repeat(64);
function fixture() {
  const snapshot = { rooms: [{ id: 'room-one', updatedAt: 'room-v1',
    relay: { active: false }, members: [{ id: 'astro',
      binding: { targetClassId: 'local-origin', targetId: ID,
        providerId: 'local-antigravity-existing' } }] }] };
  const target = { id: ID, targetClassId: 'local-origin',
    providerId: 'local-antigravity-existing', pid: 25032 };
  const grant = { approved: true, grantId: 'owner-grant-one', roomId: 'room-one',
    memberId: 'astro', targetId: ID, operation: 'enroll-local-session' };
  const proof = { verified: true, targetId: ID, providerId: target.providerId,
    lockOwnerPid: 25032, uniqueLockOwnerCount: 1, deviceId: 'machine-one',
    processEpoch: 'creation-epoch-one', sessionKeyDigest: A,
    executableDigest: B, observedAtMs: NOW };
  const args = { snapshot, roomId: 'room-one', memberId: 'astro', target,
    verifyOwnerGrant: () => grant, attest: () => proof,
    dispatchQuiescent: true, hasActiveJobs: false, nowMs: NOW };
  return { args, target, grant, proof };
}
const code = (args, expected) => assert.equal(proposeEnrollment(args).code, expected);
test('exact owner grant and recent unique lock produce immutable redacted enrollment proposal', () => {
  const { args } = fixture(), before = JSON.stringify(args.snapshot);
  const answer = proposeEnrollment(args);
  assert.equal(answer.ok, true);
  assert.equal(answer.proposal.sessionKeyDigest.length, 64);
  assert.equal(answer.proposal.grantId, 'owner-grant-one');
  assert.equal(answer.proposal.expectedRoomRevision, 'room-v1');
  assert.equal(Object.isFrozen(answer.proposal), true);
  assert.equal(JSON.stringify(args.snapshot), before);
  assert.ok(!JSON.stringify(answer).includes('.lock'));
});
test('untrusted approval and missing attestor never enroll', () => {
  const { args, grant } = fixture();
  code({ ...args, verifyOwnerGrant: null }, 'ENROLLMENT_TRUSTED_BROKER_REQUIRED');
  code({ ...args, attest: null }, 'ENROLLMENT_TRUSTED_BROKER_REQUIRED');
  code({ ...args, verifyOwnerGrant: () => true }, 'ENROLLMENT_OWNER_DENIED');
  code({ ...args, verifyOwnerGrant: () => ({ ...grant, targetId: 'other' }) },
    'ENROLLMENT_OWNER_DENIED');
});
test('no enrollment while a room or detached task is active or session is shared', () => {
  const { args } = fixture();
  code({ ...args, hasActiveJobs: undefined }, 'ENROLLMENT_NOT_QUIESCENT');
  code({ ...args, dispatchQuiescent: false }, 'ENROLLMENT_NOT_QUIESCENT');
  args.snapshot.rooms[0].pendingTurn = { requestId: 'active' };
  code(args, 'ENROLLMENT_ROOM_BUSY_OR_AMBIGUOUS');
  delete args.snapshot.rooms[0].pendingTurn;
  args.snapshot.rooms.push({ id: 'room-two',
    members: [{ id: 'another-agent', binding: args.snapshot.rooms[0].members[0].binding }] });
  code(args, 'ENROLLMENT_SHARED_TARGET');
});
test('candidate PID and native lock owner must exactly match the enrolled target', () => {
  const { args, proof, target } = fixture();
  code({ ...args, target: { ...target, pid: 999 } }, 'ENROLLMENT_TARGET_MISMATCH');
  code({ ...args, attest: () => ({ ...proof, lockOwnerPid: 999 }) },
    'ENROLLMENT_IDENTITY_UNPROVEN');
  code({ ...args, attest: () => ({ ...proof, uniqueLockOwnerCount: 2 }) },
    'ENROLLMENT_IDENTITY_UNPROVEN');
});
test('stale or unscoped evidence fails closed with no persistent room mutation', () => {
  const { args, proof } = fixture(), original = JSON.stringify(args.snapshot);
  code({ ...args, attest: () => ({ ...proof, observedAtMs: NOW - 20000 }) },
    'ENROLLMENT_IDENTITY_UNPROVEN');
  code({ ...args, attest: () => ({ ...proof, sessionKeyDigest: 'raw-conversation-id' }) },
    'ENROLLMENT_IDENTITY_UNPROVEN');
  assert.equal(JSON.stringify(args.snapshot), original);
});
