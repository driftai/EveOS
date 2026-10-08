'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createCapabilityGrant, authorizeCapabilityGrant, revokeCapabilityGrant } = require('../machine-spaces/capability-grant');
const { createAgentQuorumCoordinator } = require('../machine-spaces/agent-quorum');
const { createSupervisedJobCoordinator } = require('../machine-spaces/supervised-job');
const { createSupervisedJobProviderControl } = require('../machine-spaces/supervised-job-provider-control');
const { createManagedTerminalBroker, shellInvocation } = require('../machine-spaces/managed-terminal-broker');

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 5151;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; };
  return child;
}

test('filesystem grants fail closed across scope, target, capability, expiry and revocation', () => {
  let clock = Date.parse('2026-10-08T12:00:00.000Z');
  const grant = createCapabilityGrant({
    repoRoot: path.resolve('/repo'), targetId: 'terminal-one', ownerId: 'local-owner',
    capabilities: ['files.read'], mode: 'persistent', ttlMs: 60000,
    now: () => clock, idFactory: () => 'grant-one'
  });
  assert.equal(authorizeCapabilityGrant(grant, { repoRoot: path.resolve('/repo'), targetId: 'terminal-one', capability: 'files.read', now: () => clock }).allowed, true);
  assert.equal(authorizeCapabilityGrant(grant, { repoRoot: path.resolve('/other'), targetId: 'terminal-one', capability: 'files.read', now: () => clock }).reason, 'root-mismatch');
  assert.equal(authorizeCapabilityGrant(grant, { repoRoot: path.resolve('/repo'), targetId: 'terminal-two', capability: 'files.read', now: () => clock }).reason, 'target-mismatch');
  assert.equal(authorizeCapabilityGrant(grant, { repoRoot: path.resolve('/repo'), targetId: 'terminal-one', capability: 'files.delete', now: () => clock }).reason, 'capability-not-granted');
  clock += 60001;
  assert.equal(authorizeCapabilityGrant(grant, { repoRoot: path.resolve('/repo'), targetId: 'terminal-one', capability: 'files.read', now: () => clock }).reason, 'grant-expired');
  assert.equal(grant.enabled, false);

  const second = createCapabilityGrant({ repoRoot: path.resolve('/repo'), targetId: 'terminal-one', ownerId: 'local-owner', capabilities: ['files.read'], now: () => clock });
  revokeCapabilityGrant(second, { now: () => clock, reason: 'matrix-revoke' });
  assert.equal(authorizeCapabilityGrant(second, { repoRoot: path.resolve('/repo'), targetId: 'terminal-one', capability: 'files.read', now: () => clock }).reason, 'grant-disabled');
});

test('allow-once filesystem authority is consumed exactly once', () => {
  const grant = createCapabilityGrant({
    repoRoot: path.resolve('/repo'), targetId: 'terminal-one', ownerId: 'local-owner',
    capabilities: ['files.patch'], mode: 'once', idFactory: () => 'grant-once'
  });
  const first = authorizeCapabilityGrant(grant, { repoRoot: path.resolve('/repo'), targetId: 'terminal-one', capability: 'files.patch', consume: true });
  assert.equal(first.allowed, true);
  assert.equal(grant.enabled, false);
  const replay = authorizeCapabilityGrant(grant, { repoRoot: path.resolve('/repo'), targetId: 'terminal-one', capability: 'files.patch', consume: true });
  assert.equal(replay.allowed, false);
});

test('agent-only quorum rejects spoofed provider identity and stale availability', () => {
  let clock = Date.parse('2026-10-08T12:00:00.000Z');
  const quorum = createAgentQuorumCoordinator({ now: () => clock, defaultTtlMs: 5000 });
  quorum.reportPresence({ agent: 'Vera', provider: 'hark', available: true });
  quorum.openWorkflow({ workflowId: 'wf-security', expectedAgents: ['vera'], minVotes: 1 });
  assert.throws(() => quorum.castVote({ workflowId: 'wf-security', agent: 'Vera', provider: 'chatgpt', decision: 'approve', controlId: 'spoof' }), {
    code: 'MACHINE_AGENT_PROVIDER_MISMATCH'
  });
  clock += 5001;
  assert.throws(() => quorum.castVote({ workflowId: 'wf-security', agent: 'Vera', provider: 'hark', decision: 'approve', controlId: 'stale' }), {
    code: 'MACHINE_QUORUM_PRESENCE_REQUIRED'
  });
});

test('supervised provider surface cannot launch or rebound and request ids remain immutable', () => {
  const jobs = createSupervisedJobCoordinator({ idFactory: (() => { let n = 0; return () => `id-${++n}`; })() });
  const commandStore = new Map();
  const target = { id: 'terminal-one', processEpoch: 'epoch-one' };
  const room = { id: 'room-one', machineSpaces: { spaces: [{ id: 'space-one', name: 'Build', resourceIds: [target.id] }] } };
  const control = createSupervisedJobProviderControl({ jobs, commandStore, broker: { target: (id) => id === target.id ? target : null },
    getState: () => ({ rooms: [room] }), findSpace: (value, ref) => value.machineSpaces.spaces.find((space) => space.id === ref) });
  assert.equal(control.owns('job_start'), false);
  assert.equal(control.owns('job_rebound'), false);
  const base = {
    source: { providerId: 'chatgpt' }, requestId: 'same-request', boundRoomId: 'room-one',
    origin: { roomId: 'room-one', executorMemberId: 'eve', executorName: 'Eve-Main-Agent', agentMessageId: 'msg-one' }
  };
  const first = control.route({ ...base, command: { action: 'job_prepare', space: 'space-one', terminal: target.id, command: 'npm run dev' } });
  assert.equal(first.ok, true);
  const conflict = control.route({ ...base, command: { action: 'job_prepare', space: 'space-one', terminal: target.id, command: 'npm run other' } });
  assert.equal(conflict.code, 'MACHINE_JOB_REQUEST_CONFLICT');
});

test('native shell invocations remain explicit argv with no implicit shell wrapper', () => {
  assert.deepEqual(shellInvocation('cmd', 'echo hi', 'win32'), { file: 'cmd.exe', args: ['/d', '/s', '/c', 'echo hi'] });
  assert.deepEqual(shellInvocation('powershell', 'echo hi', 'win32'), { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'echo hi'] });
  assert.deepEqual(shellInvocation('pwsh', 'echo hi', 'linux'), { file: 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'echo hi'] });
  assert.deepEqual(shellInvocation('wsl', 'echo hi', 'win32'), { file: 'wsl.exe', args: ['--exec', 'bash', '--noprofile', '--norc', '-c', 'echo hi'] });
});

test('bounded and supervised work cannot race on the same terminal and stale epochs fail closed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-security-matrix-'));
  let child;
  const broker = createManagedTerminalBroker({
    platform: 'win32', defaultCwd: root, executableCheck: () => true,
    idFactory: () => 'matrix', spawnImpl() { child = fakeChild(); return child; }, supervisedTimeoutMs: 60000
  });
  try {
    const target = broker.createSession({ type: 'powershell', cwd: root });
    await assert.rejects(() => broker.runSupervised({ targetId: target.id, processEpoch: 'stale', requestId: 'stale', command: 'npm run dev' }), {
      code: 'MACHINE_TARGET_EPOCH_MISMATCH'
    });
    const running = broker.runSupervised({ targetId: target.id, processEpoch: target.processEpoch, requestId: 'server', command: 'npm run dev' });
    await assert.rejects(() => broker.run({ targetId: target.id, requestId: 'race', command: 'git status' }), { code: 'MACHINE_TARGET_BUSY' });
    child.emit('close', 0, null);
    assert.equal((await running).state, 'completed');
  } finally {
    broker.stopAll(); fs.rmSync(root, { recursive: true, force: true });
  }
});
