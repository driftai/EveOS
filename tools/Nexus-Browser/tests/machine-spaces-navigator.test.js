'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { searchPaths, scorePath, status } = require('../machine-spaces/navigator-path-search');
const { createFilesystemBroker } = require('../machine-spaces/filesystem-broker');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-navigator-'));
  fs.mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'hello-world.js'), 'hello');
  fs.writeFileSync(path.join(root, 'src', 'sub', 'überprüfung.txt'), 'Ünicode');
  fs.writeFileSync(path.join(root, 'src', 'other.js'), 'other');
  fs.writeFileSync(path.join(root, 'node_modules', 'hello-secret.js'), 'secret');
  fs.writeFileSync(path.join(root, 'data', 'runtime', 'private-hello.js'), 'secret');
  fs.writeFileSync(path.join(root, '.git', 'config'), 'secret');
  fs.writeFileSync(path.join(root, '.env'), 'secret');
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('Navigator v1 exposes no independent execution, indexing, or authorization authority', () => {
  assert.deepEqual({ ...status() }, {
    schema: 'eveos.navigator.discovery.v1', available: true,
    mode: 'bounded-live-scan', index: 'not-configured',
    mutationAuthority: 'machine-spaces', revalidateBeforeReadOrMutation: true,
    persistentIndex: false, sidecar: false
  });
});

test('Filename ranking favors exact and prefix names over fuzzy subsequences', () => {
  assert.ok(scorePath('src/worker.js', 'worker.js') > scorePath('src/worker-copy.js', 'worker.js'));
  assert.ok(scorePath('src/worker-copy.js', 'worker') > scorePath('src/weird-worker-copy.js', 'worker'));
  assert.ok(scorePath('src/hello-world.js', 'hlo') > 0);
  assert.equal(scorePath('src/hello-world.js', 'nomatch'), 0);
});

test('Navigator searches file and directory names in an authorized bounded root', () => {
  const f = fixture();
  try {
    const broker = createFilesystemBroker();
    const found = broker.navSearch(f.root, 'HELLO');
    assert.equal(found.results.length, 1);
    assert.equal(found.results[0].path, 'src/hello-world.js');
    assert.equal(found.results[0].type, 'file');
    assert.equal(found.scope, '.');
    assert.equal(found.revalidateBeforeReadOrMutation, true);
    assert.equal(broker.navStatus(f.root).mode, 'bounded-live-scan');
  } finally { f.cleanup(); }
});

test('Navigator preserves unicode and restricts paths to an exact subtree', () => {
  const f = fixture();
  try {
    const broker = createFilesystemBroker();
    const result = broker.navSearch(f.root, 'über', { path: 'src/sub' });
    assert.deepEqual(result.results.map(x => x.path), ['src/sub/überprüfung.txt']);
    assert.throws(() => broker.navSearch(f.root, 'hello', { path: '../' }),
      error => error.code === 'MACHINE_FILE_TRAVERSAL');
    assert.throws(() => broker.navSearch(f.root, 'hello', { path: '/etc' }),
      error => error.code === 'MACHINE_FILE_ABSOLUTE_PATH');
  } finally { f.cleanup(); }
});

test('Navigator never traverses ignored dependencies, private runtime files, or .env', () => {
  const f = fixture();
  try {
    const broker = createFilesystemBroker();
    const result = broker.navSearch(f.root, 'secret');
    assert.deepEqual(result.results, []);
    assert.throws(() => broker.navSearch(f.root, 'private', { path: 'data/runtime' }),
      error => error.code === 'NAVIGATOR_PRIVATE_PATH');
  } finally { f.cleanup(); }
});

test('Navigator never follows a symlink to external files or directories', t => {
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-nav-external-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret-outside.txt'), 'secret');
    try { fs.symlinkSync(outside, path.join(f.root, 'external'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { t.skip(`symlink unavailable: ${error.code}`); return; }
    const result = createFilesystemBroker().navSearch(f.root, 'secret-outside');
    assert.deepEqual(result.results, []);
  } finally { f.cleanup(); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('Navigator enforces bounded scans and marks incomplete evidence', () => {
  const f = fixture();
  try {
    const broker = createFilesystemBroker();
    const result = broker.navSearch(f.root, 'src', { maxEntries: 1, maxResults: 1 });
    assert.ok(result.examined <= 1);
    assert.equal(result.truncated, true);
    assert.ok(result.results.length <= 1);
  } finally { f.cleanup(); }
});

test('Navigator rejects unbounded, absent, or malformed queries', () => {
  const f = fixture();
  try {
    const broker = createFilesystemBroker();
    for (const query of ['', ' ', 'x'.repeat(129), '\0'])
      assert.throws(() => broker.navSearch(f.root, query), error => error.code === 'NAVIGATOR_BAD_QUERY');
  } finally { f.cleanup(); }
});

test('Navigator does not write files while discovering paths', () => {
  const f = fixture();
  try {
    const target = path.join(f.root, 'src', 'hello-world.js');
    const before = fs.statSync(target).mtimeMs;
    const text = fs.readFileSync(target, 'utf8');
    createFilesystemBroker().navSearch(f.root, 'hello');
    assert.equal(fs.statSync(target).mtimeMs, before);
    assert.equal(fs.readFileSync(target, 'utf8'), text);
  } finally { f.cleanup(); }
});
