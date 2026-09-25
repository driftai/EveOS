'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { credentialFile, readLocalAuth, loadOrCreateLocalAuth, localAuthMatches } =
  require('../dex/task-completion-local-auth');
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-local-completion-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('one owner-local capability persists across server restarts and authenticates exactly', (t) => {
  const root = sandbox(t);
  const secret = loadOrCreateLocalAuth(root);
  assert.match(secret, /^[a-f0-9]{64}$/);
  assert.equal(loadOrCreateLocalAuth(root), secret);
  assert.equal(readLocalAuth(root), secret);
  assert.equal(localAuthMatches(secret, secret), true);
  assert.equal(localAuthMatches('f'.repeat(64), secret), false);
  assert.equal(localAuthMatches('', secret), false);
  const stored = JSON.parse(fs.readFileSync(credentialFile(root), 'utf8'));
  assert.equal(stored.version, 1);
  if (process.platform !== 'win32')
    assert.equal(fs.statSync(credentialFile(root)).mode & 0o077, 0,
      'credential must not be readable by group or other local users');
});
test('missing or corrupt existing capability fails closed instead of rotating a live token', (t) => {
  const root = sandbox(t);
  assert.throws(() => readLocalAuth(root), /TASK_COMPLETION_LOCAL_AUTH_NOT_READY/);
  loadOrCreateLocalAuth(root);
  fs.writeFileSync(credentialFile(root), '{ invalid');
  assert.throws(() => loadOrCreateLocalAuth(root), /TASK_COMPLETION_LOCAL_AUTH_INVALID/);
  assert.throws(() => readLocalAuth(root), /TASK_COMPLETION_LOCAL_AUTH_INVALID/);
});
test('a remote tab cannot pass maintenance API authentication with a source/PID claim alone', () => {
  const known = 'a'.repeat(64);
  const attempts = [null, undefined, {}, 'local:antigravity-existing:42',
    'b'.repeat(64), known.slice(0, -2)];
  assert.ok(attempts.every((attempt) => !localAuthMatches(attempt, known)));
});
