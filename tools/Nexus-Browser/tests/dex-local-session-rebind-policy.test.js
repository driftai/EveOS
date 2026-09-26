'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { proposeRebind, MAX_ATTEST_AGE_MS } = require('../dex/local-session-rebind-policy');
const ROOM = 'room-original', MEMBER = 'astro', DEVICE = 'device-one';
const OLD_ID = 'local:antigravity-existing:25032', NEW_ID = 'local:antigravity-existing:25100';
const A = 'a'.repeat(64), B = 'b'.repeat(64), NOW = 200000;
function fixture() {
  const snapshot = { rooms: [{ id: ROOM, name: 'Eve + Astro', updatedAt: 'revision-one',
    members: [{ id: MEMBER, binding: { targetClassId: 'local-origin',
      providerId: 'local-antigravity-existing', targetId: OLD_ID } }],
    relay: { active: false }, messages: [] }] };
  const enrollment = { roomId: ROOM, memberId: MEMBER, targetId: OLD_ID, pid: 25032,
    sessionKeyDigest: A, executableDigest: B, deviceId: DEVICE, processEpoch: 'start-old' };
  const candidate = { id: NEW_ID, pid: 25100, providerId: 'local-antigravity-existing',
    targetClassId: 'local-origin' };
  const proof = { verified: true, deviceId: DEVICE, sessionKeyDigest: A,
    executableDigest: B, providerId: candidate.providerId, targetId: NEW_ID,
    lockOwnerPid: candidate.pid, uniqueLockOwnerCount: 1, oldPidAlive: false,
    processEpoch: 'start-new', observedAtMs: NOW };
  const arg = { snapshot, roomId: ROOM, memberId: MEMBER, enrollment, candidate,
    attest: () => proof, dispatchQuiescent: true, hasActiveJobs: false, nowMs: NOW };
  return { arg, proof };
}
function code(arg, want) { assert.equal(proposeRebind(arg).code, want); }
test('matching fresh unique lock produces a reviewable plan without mutating any room', () => {
  const { arg } = fixture(), before = JSON.stringify(arg.snapshot);
  const result = proposeRebind(arg);
  assert.equal(result.ok, true);
  assert.equal(result.plan.oldTargetId, OLD_ID);
  assert.equal(result.plan.newTargetId, NEW_ID);
  assert.equal(result.plan.expectedRoomRevision, 'revision-one');
  assert.equal(JSON.stringify(arg.snapshot), before);
  assert.equal(result.plan.sessionKeyDigest, undefined);
});
test('unregistered, busy and pending-job source never rebinds', () => {
  const { arg } = fixture();
  code({ ...arg, attest: null }, 'REBOUND_ATTESTOR_REQUIRED');
  code({ ...arg, enrollment: null }, 'REBOUND_NO_ENROLLMENT');
  code({ ...arg, dispatchQuiescent: false }, 'REBOUND_NOT_QUIESCENT');
  code({ ...arg, hasActiveJobs: true }, 'REBOUND_NOT_QUIESCENT');
  code({ ...arg, hasActiveJobs: undefined }, 'REBOUND_NOT_QUIESCENT');
  arg.snapshot.rooms[0].recovery = { requestId: 'unfinished' };
  code(arg, 'REBOUND_ROOM_BUSY_OR_AMBIGUOUS');
});
test('same-provider process cannot impersonate registered conversation', () => {
  const { arg, proof } = fixture();
  code({ ...arg, attest: () => ({ ...proof, sessionKeyDigest: 'c'.repeat(64) }) },
    'REBOUND_IDENTITY_UNPROVEN');
  code({ ...arg, attest: () => ({ ...proof, executableDigest: 'c'.repeat(64) }) },
    'REBOUND_IDENTITY_UNPROVEN');
  code({ ...arg, attest: () => ({ ...proof, lockOwnerPid: 25101 }) },
    'REBOUND_IDENTITY_UNPROVEN');
  code({ ...arg, attest: () => ({ ...proof, uniqueLockOwnerCount: 2 }) },
    'REBOUND_IDENTITY_UNPROVEN');
  code({ ...arg, attest: () => ({ ...proof, oldPidAlive: true }) },
    'REBOUND_IDENTITY_UNPROVEN');
});
test('stale evidence, same PID reuse and unchanged process epoch fail closed', () => {
  const { arg, proof } = fixture();
  code({ ...arg, attest: () => ({ ...proof,
    observedAtMs: NOW - MAX_ATTEST_AGE_MS - 1 }) }, 'REBOUND_IDENTITY_UNPROVEN');
  code({ ...arg, candidate: { ...arg.candidate, pid: 25032, id: OLD_ID } },
    'REBOUND_BAD_CANDIDATE');
  code({ ...arg, attest: () => ({ ...proof, processEpoch: 'start-old' }) },
    'REBOUND_IDENTITY_UNPROVEN');
});
test('shared sessions or conflicting target owners require manual coordination', () => {
  const { arg } = fixture();
  arg.snapshot.rooms.push({ id: 'other-room', members: [{ id: 'other-astro',
    binding: { targetClassId: 'local-origin', providerId: 'local-antigravity-existing',
      targetId: NEW_ID } }] });
  code(arg, 'REBOUND_SHARED_BINDING');
  arg.snapshot.rooms[1].members[0].binding.targetId = OLD_ID;
  code(arg, 'REBOUND_SHARED_BINDING');
});
test('native discovery cannot supply its own proof or a spoofed target ID', () => {
  const { arg } = fixture();
  code({ ...arg, attest: () => { throw Error('locked'); } }, 'REBOUND_ATTESTATION_FAILED');
  code({ ...arg, candidate: { ...arg.candidate, id: 'local:antigravity-existing:999' } },
    'REBOUND_BAD_CANDIDATE');
  code({ ...arg, candidate: { ...arg.candidate, verified: true }, attest: null },
    'REBOUND_ATTESTOR_REQUIRED');
});
