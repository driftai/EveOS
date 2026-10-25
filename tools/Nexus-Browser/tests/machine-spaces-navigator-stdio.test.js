'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'navigator-stdio.js');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-nav-jsonl-'));
  fs.mkdirSync(path.join(root, 'source'));
  fs.writeFileSync(path.join(root, 'source', 'find-me.txt'), 'content');
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function talk(root, messages) {
  const child = spawnSync(process.execPath, [script], {
    env: { ...process.env, EVEOS_NAVIGATOR_ROOT: root },
    input: messages.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('\n') + '\n',
    encoding: 'utf8', timeout: 8000
  });
  return { ...child, lines: child.stdout.trim().split('\n').filter(Boolean).map(JSON.parse) };
}

test('JSONL sidecar requires an explicit root and has no network listener', () => {
  const result = talk('', [{ requestId: 'hello', action: 'handshake' }]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /NAVIGATOR_ROOT_REQUIRED/);
});

test('JSONL protocol handles handshake, bounded status, read-only search and shutdown', () => {
  const f = fixture();
  try {
    const result = talk(f.root, [
      { requestId: 'a1', action: 'handshake' },
      { requestId: 'a2', action: 'nav_status' },
      { requestId: 'a3', action: 'nav_search', query: 'find-me', options: { path: 'source' } },
      { requestId: 'a4', action: 'shutdown' }
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.lines.length, 4);
    assert.ok(result.lines.every(x => x.ok === true));
    assert.equal(result.lines[0].result.protocol, 'eveos.navigator.jsonl.v1');
    assert.equal(result.lines[1].result.mode, 'bounded-live-scan');
    assert.deepEqual(result.lines[2].result.results.map(x => x.path), ['source/find-me.txt']);
    assert.equal(result.lines[3].result.stopped, true);
  } finally { f.cleanup(); }
});

test('JSONL duplicate IDs replay read-only receipt, conflicting duplicates are rejected', () => {
  const f = fixture();
  try {
    const one = { requestId: 'same', action: 'nav_search', query: 'find' };
    const result = talk(f.root, [one, one, { ...one, query: 'different' },
      { requestId: 'quit', action: 'shutdown' }]);
    assert.equal(result.status, 0);
    assert.deepEqual(result.lines[0], result.lines[1]);
    assert.equal(result.lines[2].code, 'NAVIGATOR_REQUEST_CONFLICT');
    assert.equal(result.lines[3].ok, true);
  } finally { f.cleanup(); }
});

test('JSONL rejects malformed requests and unknown commands without mutations', () => {
  const f = fixture();
  try {
    const result = talk(f.root, ['{broken', { requestId: 'bad', action: 'arbitrary_exec' },
      { requestId: 'quit', action: 'shutdown' }]);
    assert.equal(result.status, 0);
    assert.equal(result.lines[0].code, 'NAVIGATOR_INVALID_JSON');
    assert.equal(result.lines[1].code, 'NAVIGATOR_UNKNOWN_ACTION');
    assert.equal(fs.readFileSync(path.join(f.root, 'source', 'find-me.txt'), 'utf8'), 'content');
  } finally { f.cleanup(); }
});
