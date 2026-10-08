'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createManagedTerminalBroker } = require('../machine-spaces/managed-terminal-broker');

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; };
  return child;
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-supervised-'));
  let child = null;
  const broker = createManagedTerminalBroker({
    platform: 'win32', defaultCwd: root, executableCheck: () => true,
    idFactory: (() => { let n = 0; return () => `id-${++n}`; })(),
    spawnImpl() { child = fakeChild(); return child; },
    supervisedTimeoutMs: options.supervisedTimeoutMs || 60000,
    maxOutputBytes: options.maxOutputBytes || 16
  });
  const target = broker.createSession({ type: 'powershell', cwd: root });
  return { root, broker, target, child: () => child, cleanup() { broker.stopAll(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('supervised command occupies the same managed terminal resource', async () => {
  const f = fixture();
  try {
    const promise = f.broker.runSupervised({ targetId: f.target.id, processEpoch: f.target.processEpoch, requestId: 'supervised-one', command: 'npm run dev' });
    assert.equal(f.broker.target(f.target.id).busy, true);
    assert.equal(f.broker.target(f.target.id).activeMode, 'supervised');
    assert.equal(f.broker.activeInfo(f.target.id).requestId, 'supervised-one');
    await assert.rejects(() => f.broker.run({ targetId: f.target.id, requestId: 'bounded-two', command: 'git status' }), { code: 'MACHINE_TARGET_BUSY' });
    f.child().emit('close', 0, null);
    const result = await promise;
    assert.equal(result.state, 'completed');
    assert.equal(f.broker.target(f.target.id).busy, false);
  } finally { f.cleanup(); }
});

test('supervised execution refuses a replaced process epoch', async () => {
  const f = fixture();
  try {
    await assert.rejects(() => f.broker.runSupervised({ targetId: f.target.id, processEpoch: 'stale-epoch', requestId: 'bad', command: 'npm run dev' }), {
      code: 'MACHINE_TARGET_EPOCH_MISMATCH'
    });
  } finally { f.cleanup(); }
});

test('supervised output is bounded without killing a healthy long-running process', async () => {
  const f = fixture({ maxOutputBytes: 8 });
  try {
    const chunks = [];
    const promise = f.broker.runSupervised({
      targetId: f.target.id, processEpoch: f.target.processEpoch, requestId: 'logs', command: 'npm run dev',
      onData: (event) => chunks.push(event)
    });
    f.child().stdout.emit('data', Buffer.from('123456'));
    f.child().stderr.emit('data', Buffer.from('abcdef'));
    assert.equal(f.broker.target(f.target.id).busy, true, 'output overflow must not terminate a supervised server');
    f.child().emit('close', 0, null);
    const result = await promise;
    assert.equal(result.state, 'completed');
    assert.equal(result.bytes, 8);
    assert.equal(result.totalBytes, 12);
    assert.equal(result.outputTruncated, true);
    assert.equal(chunks.at(-1).outputTruncated, true);
  } finally { f.cleanup(); }
});

test('interrupting a supervised server settles as outcome-unknown rather than success', async () => {
  const f = fixture();
  try {
    const promise = f.broker.runSupervised({ targetId: f.target.id, processEpoch: f.target.processEpoch, requestId: 'interrupt-me', command: 'npm run dev' });
    assert.equal(f.broker.interrupt(f.target.id), true);
    const result = await promise;
    assert.equal(result.state, 'outcome-unknown');
    assert.equal(result.reason, 'interrupted');
  } finally { f.cleanup(); }
});
