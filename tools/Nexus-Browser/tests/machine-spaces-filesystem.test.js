'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  createCapabilityGrant,
  authorizeCapabilityGrant,
  revokeCapabilityGrant
} = require('../machine-spaces/capability-grant');
const {
  createFilesystemBroker,
  resolveScopedPath
} = require('../machine-spaces/filesystem-broker');

function digest(value) { return createHash('sha256').update(Buffer.from(value)).digest('hex'); }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-machine-files-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'one.txt'), 'alpha\nbeta\ngamma\n');
  fs.writeFileSync(path.join(root, 'src', 'two.txt'), 'BETA elsewhere\n');
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('filesystem capability grants are exact-root, exact-target, expiring and one-shot when requested', () => {
  const { root, cleanup } = fixture();
  try {
    let stamp = 1000;
    const grant = createCapabilityGrant({ repoRoot: root, targetId: 'terminal-one', ownerId: 'owner-one',
      capabilities: ['files.read', 'files.patch'], mode: 'once', ttlMs: 60_000,
      now: () => stamp, idFactory: () => 'machine-file-grant-one' });
    assert.equal(authorizeCapabilityGrant(grant, { repoRoot: root, targetId: 'terminal-one', capability: 'files.read', now: () => stamp }).allowed, true);
    assert.equal(authorizeCapabilityGrant(grant, { repoRoot: root, targetId: 'terminal-two', capability: 'files.read', now: () => stamp }).reason, 'target-mismatch');
    assert.equal(authorizeCapabilityGrant(grant, { repoRoot: root, targetId: 'terminal-one', capability: 'files.delete', now: () => stamp }).reason, 'capability-not-granted');
    const consumed = authorizeCapabilityGrant(grant, { repoRoot: root, targetId: 'terminal-one', capability: 'files.patch', now: () => stamp, consume: true });
    assert.equal(consumed.allowed, true);
    assert.equal(grant.enabled, false);
    assert.equal(authorizeCapabilityGrant(grant, { repoRoot: root, targetId: 'terminal-one', capability: 'files.read', now: () => stamp }).reason, 'grant-disabled');

    const expiring = createCapabilityGrant({ repoRoot: root, targetId: 'terminal-one', ownerId: 'owner-one',
      capabilities: ['files.search'], mode: 'persistent', ttlMs: 60_000, now: () => stamp });
    stamp += 60_001;
    assert.equal(authorizeCapabilityGrant(expiring, { repoRoot: root, targetId: 'terminal-one', capability: 'files.search', now: () => stamp }).reason, 'grant-expired');
    const revoked = createCapabilityGrant({ repoRoot: root, targetId: 'terminal-one', ownerId: 'owner-one', capabilities: ['files.list'] });
    revokeCapabilityGrant(revoked, { reason: 'test' });
    assert.equal(revoked.enabled, false);
  } finally { cleanup(); }
});

test('filesystem broker provides bounded list tree stat read and literal search inside one root', () => {
  const { root, cleanup } = fixture();
  try {
    const files = createFilesystemBroker();
    const listed = files.list(root, 'src', { limit: 1 });
    assert.equal(listed.entries.length, 1);
    assert.equal(listed.total, 2);
    assert.equal(listed.nextOffset, 1);
    const tree = files.tree(root, '', { depth: 2 });
    assert.ok(tree.entries.some((entry) => entry.path === 'src/one.txt'));
    const info = files.stat(root, 'src/one.txt');
    assert.equal(info.type, 'file');
    assert.equal(info.sha256, digest('alpha\nbeta\ngamma\n'));
    const read = files.read(root, 'src/one.txt', { limit: 6 });
    assert.equal(read.text, 'alpha\n');
    assert.equal(read.nextOffset, 6);
    assert.equal(read.lineCount, 3);
    const search = files.search(root, 'beta', { path: 'src' });
    assert.equal(search.results.length, 2);
    assert.equal(search.results[0].line, 2);
  } finally { cleanup(); }
});

test('filesystem broker mutations require hashes and create patch move delete without traversal', () => {
  const { root, cleanup } = fixture();
  try {
    const files = createFilesystemBroker();
    const one = files.stat(root, 'src/one.txt');
    assert.throws(() => files.write(root, 'src/one.txt', 'changed', '0'.repeat(64)), (error) => error.code === 'MACHINE_FILE_CHANGED');
    const patched = files.patch(root, 'src/one.txt', 'beta', 'BETA', one.sha256);
    assert.equal(patched.sha256, digest('alpha\nBETA\ngamma\n'));
    const created = files.create(root, 'src/new.txt', 'new file\n');
    assert.equal(created.sha256, digest('new file\n'));
    const moved = files.move(root, 'src/new.txt', 'src/moved.txt', created.sha256);
    assert.equal(moved.destination, 'src/moved.txt');
    assert.equal(fs.existsSync(path.join(root, 'src', 'new.txt')), false);
    files.remove(root, 'src/moved.txt', created.sha256);
    assert.equal(fs.existsSync(path.join(root, 'src', 'moved.txt')), false);
    assert.throws(() => files.stat(root, '../outside.txt'), (error) => error.code === 'MACHINE_FILE_TRAVERSAL');
    assert.throws(() => resolveScopedPath(root, path.resolve(root, 'src', 'one.txt')), (error) => error.code === 'MACHINE_FILE_ABSOLUTE_PATH');
  } finally { cleanup(); }
});

test('filesystem broker refuses to follow a symlink leaf outside the granted root', (t) => {
  const { root, cleanup } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-machine-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    try { fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt')); }
    catch (error) { t.skip(`symlink unavailable: ${error.code || error.message}`); return; }
    const files = createFilesystemBroker();
    assert.throws(() => files.read(root, 'escape.txt'), (error) => error.code === 'MACHINE_FILE_SYMLINK_ESCAPE' || error.code === 'MACHINE_FILE_SYMLINK');
  } finally {
    cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
