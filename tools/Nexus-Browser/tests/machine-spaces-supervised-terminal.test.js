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
  const treeKills = [];
  const broker = createManagedTerminalBroker({
    platform: 'win32', defaultCwd: root, executableCheck: () => true,
    idFactory: (() => { let n = 0; return () => `id-${++n}`; })(),
    spawnImpl() { child = fakeChild(); return child; },
    windowsTreeKill: options.windowsTreeKill || ((pid) => {
      treeKills.push(pid); queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true;
    }),
    supervisedTimeoutMs: options.supervisedTimeoutMs || 60000,
    maxOutputBytes: options.maxOutputBytes || 16,
    exitGraceMs: options.exitGraceMs == null ? 5 : options.exitGraceMs
  });
  const target = broker.createSession({ type: 'powershell', cwd: root });
  return { root, broker, target, child: () => child, treeKills,
    cleanup() { broker.stopAll(); fs.rmSync(root, { recursive: true, force: true }); } };
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

test('POSIX interrupt signals the whole process group so native grandchildren cannot pin the terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-supervised-posix-'));
  const kills = []; let child = null; let spawnOptions = null;
  const broker = createManagedTerminalBroker({
    platform: 'linux', defaultCwd: root, executableCheck: () => true,
    idFactory: (() => { let n = 0; return () => `posix-${++n}`; })(),
    spawnImpl(file, args, options) { spawnOptions = options; child = fakeChild(); child.kill = () => { kills.push('child'); return true; }; return child; },
    processKill(pid, signal) { kills.push([pid, signal]); queueMicrotask(() => child.emit('close', null, 'SIGTERM')); }
  });
  try {
    const target = broker.createSession({ type: 'pwsh', cwd: root });
    const promise = broker.runSupervised({ targetId: target.id, processEpoch: target.processEpoch, requestId: 'posix-tree', command: 'sleep 300' });
    assert.equal(spawnOptions.detached, true);
    assert.equal(broker.interrupt(target.id), true);
    assert.deepEqual(kills, [[-4242, 'SIGTERM']]);
    const result = await promise;
    assert.equal(result.state, 'outcome-unknown');
    assert.equal(result.reason, 'interrupted');
    assert.equal(broker.target(target.id).busy, false);
  } finally { broker.stopAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Windows interrupt invokes tree kill for the shell pid and does not detach', async () => {
  const f = fixture();
  try {
    const promise = f.broker.runSupervised({ targetId: f.target.id, processEpoch: f.target.processEpoch, requestId: 'win-kill', command: 'npm run dev' });
    assert.equal(f.broker.interrupt(f.target.id), true);
    assert.deepEqual(f.treeKills, [4242]);
    const result = await promise;
    assert.equal(result.state, 'outcome-unknown');
    assert.equal(result.reason, 'interrupted');
    assert.equal(f.broker.target(f.target.id).busy, false);
  } finally { f.cleanup(); }
});

test('Windows tree-kill failure falls back to direct child kill', async () => {
  const f = fixture({ windowsTreeKill: () => false });
  try {
    const promise = f.broker.runSupervised({ targetId: f.target.id, processEpoch: f.target.processEpoch, requestId: 'win-fallback', command: 'npm run dev' });
    assert.equal(f.broker.interrupt(f.target.id), true);
    const result = await promise;
    assert.equal(result.state, 'outcome-unknown');
    assert.equal(result.reason, 'interrupted');
  } finally { f.cleanup(); }
});

test('process exit releases a supervised terminal after the pipe grace even if close is pinned', async () => {
  const f = fixture({ exitGraceMs: 1 });
  try {
    const promise = f.broker.runSupervised({ targetId: f.target.id, processEpoch: f.target.processEpoch, requestId: 'exit-grace', command: 'npm run dev' });
    f.child().stdout.emit('data', Buffer.from('done\n'));
    f.child().emit('exit', 0, null);
    const result = await promise;
    assert.equal(result.state, 'completed');
    assert.equal(result.stdout, 'done\n');
    assert.equal(f.broker.target(f.target.id).busy, false);
  } finally { f.cleanup(); }
});
