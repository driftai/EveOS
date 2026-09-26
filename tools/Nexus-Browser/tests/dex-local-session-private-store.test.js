'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { openPrivateEnrollmentStore } = require('../dex/local-session-private-store');
const NOW = Date.parse('2026-09-26T19:00:00Z');
const targetId = 'local:antigravity-existing:25032';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-private-enroll-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'private.json');
  const room = { id: 'room-one', updatedAt: 'v-one', relay: { active: false },
    members: [{ id: 'astro', binding: { targetClassId: 'local-origin',
      providerId: 'local-antigravity-existing', targetId } }] };
  const snapshot = { rooms: [room] };
  const proposal = { roomId: room.id, memberId: 'astro', targetId, pid: 25032,
    grantId: 'approved-one', deviceId: 'device-one', processEpoch: 'epoch-one',
    sessionKeyDigest: 'a'.repeat(64), executableDigest: 'b'.repeat(64),
    expectedRoomRevision: 'v-one', proofObservedAtMs: NOW };
  let held = true, secure = true, trusted = true;
  const open = () => openPrivateEnrollmentStore({ filePath, getSnapshot: () => snapshot,
    now: () => NOW, exclusiveLeaseHeld: () => held, privateStorageReady: () => secure,
    reverifyOwnerAndNative: () => trusted });
  return { proposal, snapshot, room, open, filePath,
    setHeld: v => { held = v; }, setSecure: v => { secure = v; },
    setTrusted: v => { trusted = v; } };
}
test('private enrollment persists only fixed redacted fields; public view omits grants and digests', (t) => {
  const f = fixture(t), store = f.open();
  assert.equal(store.commitVerified(f.proposal).ok, true);
  const publicRecord = store.publicStatus()[0];
  assert.equal(publicRecord.status, 'enrolled-unverified-current');
  assert.equal(publicRecord.grantId, undefined);
  assert.equal(publicRecord.sessionKeyDigest, undefined);
  assert.equal(publicRecord.executableDigest, undefined);
  assert.equal(f.open().publicStatus().length, 1);
  assert.equal(store.privateForPolicy('room-one', 'astro').sessionKeyDigest, 'a'.repeat(64));
  assert.ok(!fs.readFileSync(f.filePath, 'utf8').includes('raw conversation'));
});
test('a stale or busy room never commits even with a correctly shaped proposal', (t) => {
  const f = fixture(t), store = f.open();
  assert.equal(store.commitVerified({ ...f.proposal, expectedRoomRevision: 'old' }).code,
    'ENROLLMENT_SNAPSHOT_CHANGED');
  f.room.recovery = { requestId: 'active' };
  assert.equal(store.commitVerified(f.proposal).code, 'ENROLLMENT_SNAPSHOT_CHANGED');
  assert.equal(fs.existsSync(f.filePath), false);
});
test('owner/native reattestation and private storage are mandatory under exclusive lease', (t) => {
  const f = fixture(t), store = f.open();
  f.setHeld(false);
  assert.equal(store.commitVerified(f.proposal).code, 'ENROLLMENT_EXCLUSIVE_LEASE_REQUIRED');
  f.setHeld(true); f.setSecure(false);
  assert.equal(store.commitVerified(f.proposal).code, 'ENROLLMENT_PRIVATE_STORAGE_REQUIRED');
  f.setSecure(true); f.setTrusted(false);
  assert.equal(store.commitVerified(f.proposal).code, 'ENROLLMENT_REATTEST_FAILED');
  assert.equal(fs.existsSync(f.filePath), false);
});
test('immutable idempotence requires fresh proof; conflicting re-enrollment demands explicit revoke', (t) => {
  const f = fixture(t), store = f.open();
  assert.equal(store.commitVerified(f.proposal).deduplicated, false);
  assert.equal(store.commitVerified(f.proposal).deduplicated, true);
  assert.equal(store.commitVerified({ ...f.proposal, pid: 25033,
    targetId: 'local:antigravity-existing:25033' }).code, 'ENROLLMENT_SNAPSHOT_CHANGED');
  assert.equal(store.commitVerified({ ...f.proposal, grantId: 'other-grant' }).code,
    'ENROLLMENT_CONFLICT_EXPLICIT_REVOKE_REQUIRED');
  assert.equal(store.publicStatus().length, 1);
});
test('same native session cannot be silently assigned to another room', (t) => {
  const f = fixture(t), store = f.open();
  assert.equal(store.commitVerified(f.proposal).ok, true);
  f.snapshot.rooms.push({ id: 'room-two', updatedAt: 'v-two', relay: { active: false },
    members: [{ id: 'other', binding: { targetClassId: 'local-origin',
      providerId: 'local-antigravity-existing', targetId } }] });
  assert.equal(store.commitVerified({ ...f.proposal, roomId: 'room-two', memberId: 'other',
    expectedRoomRevision: 'v-two' }).code, 'ENROLLMENT_SESSION_ALREADY_OWNED');
});
test('corrupt private journal fails closed without overwriting original bytes', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.filePath, '{"version":1,"enrollments":[{"roomId":"bad"}]}');
  assert.throws(() => f.open(), /PRIVATE_JOURNAL_INVALID/);
  assert.match(fs.readFileSync(f.filePath, 'utf8'), /"bad"/);
});
test('expired proof or unexpected raw sensitive data cannot become a stored proposal', (t) => {
  const f = fixture(t), store = f.open();
  assert.equal(store.commitVerified({ ...f.proposal, proofObservedAtMs: NOW - 10001 }).code,
    'ENROLLMENT_INVALID_PROPOSAL');
  const result = store.commitVerified({ ...f.proposal,
    rawConversationId: 'do-not-persist', privateToken: 'do-not-persist' });
  assert.equal(result.ok, true);
  assert.doesNotMatch(fs.readFileSync(f.filePath, 'utf8'), /do-not-persist/);
});

test('duplicate or extra-field private records cannot resurrect ambiguous authority', (t) => {
  const f = fixture(t), store = f.open();
  assert.equal(store.commitVerified(f.proposal).ok, true);
  const original = JSON.parse(fs.readFileSync(f.filePath, 'utf8'));
  fs.writeFileSync(f.filePath, JSON.stringify({
    version: 1, enrollments: [...original.enrollments, { ...original.enrollments[0] }]
  }));
  assert.throws(() => f.open(), /PRIVATE_JOURNAL_INVALID/);
  const injected = { ...original.enrollments[0], rawConversationId: 'should-never-load' };
  fs.writeFileSync(f.filePath, JSON.stringify({ version: 1, enrollments: [injected] }));
  assert.throws(() => f.open(), /PRIVATE_JOURNAL_INVALID/);
});
