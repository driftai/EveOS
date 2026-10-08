'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createManagedTerminalBroker } = require('../machine-spaces/managed-terminal-broker');
const { createMachineSpacesController } = require('../machine-spaces/server-controller');
const { commandDigest } = require('../machine-spaces/approval-broker');
const { POLICY_ID, resolveRepoRoot, evaluateRepoSafeCommand } = require('../machine-spaces/repo-safe-grant');

function fakeChild({ stdout = 'OK\n', exitCode = 0 } = {}) {
  const child = new EventEmitter();
  child.pid = 7654; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => true;
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', exitCode, null);
  });
  return child;
}
async function settled(snapshot, requestId) {
  for (let i = 0; i < 100; i++) {
    const request = snapshot.rooms[0].machineSpaces.spaces[0].requests.find((entry) => entry.requestId === requestId);
    if (request && ['completed', 'failed', 'outcome-unknown'].includes(request.state)) return request;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${requestId}`);
}
function route(controller, ws, space, target, requestId, command, delivered) {
  controller.providerControl.route({ source: {}, command: { action: 'terminal_exec', space, terminal: target, command },
    requestId, ws, origin: { roomId: 'room-one', executorMemberId: 'agent-vera', executorName: 'Vera-Hark-Agent', agentMessageId: `msg-${requestId}` } }, {
    commitOriginReceipt: () => ({ id: `receipt-${requestId}` }),
    sendResult: (_recipient, result) => delivered.push(result)
  });
}

test('repo-safe policy accepts only the explicit trusted command families and repo-local paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-grant-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'README.md'), 'hello');
  fs.writeFileSync(path.join(root, 'tests', 'one.test.js'), '');
  assert.equal(resolveRepoRoot(path.join(root, 'tests')), root);
  const allows = [
    'Get-Location',
    'Get-ChildItem',
    'Get-Content README.md',
    'git pull --ff-only origin eve/nexus-machine-spaces',
    'git fetch origin',
    'git status --short',
    'git log --oneline --max-count=5',
    'git diff --stat',
    'npm test',
    'node --test tests/one.test.js'
  ];
  for (const command of allows)
    assert.equal(evaluateRepoSafeCommand(command, { repoRoot: root, cwd: root }).allowed, true, command);
  const denies = [
    'git push origin eve/nexus-machine-spaces',
    'git reset --hard HEAD',
    'git clean -fd',
    'git checkout main',
    'npm install',
    'npm run restart',
    'Remove-Item README.md',
    'Get-Content ../secret.txt',
    'git status; whoami',
    'git status | Out-File status.txt',
    'node -e "process.exit()"'
  ];
  for (const command of denies)
    assert.equal(evaluateRepoSafeCommand(command, { repoRoot: root, cwd: root }).allowed, false, command);
  fs.rmSync(root, { recursive: true, force: true });
});

test('persistent per-space grant auto-runs safe Dex work, audits actor+digest, and revokes back to allow-once', async () => {
  let runs = 0;
  let snapshot = { version: 1, rooms: [{ id: 'room-one', name: 'Room', members: [], messages: [] }] };
  const broker = createManagedTerminalBroker({ platform: 'win32', defaultCwd: process.cwd(),
    idFactory: (() => { let n = 0; return () => `grant-id-${++n}`; })(), executableCheck: () => true,
    spawnImpl() { runs++; return fakeChild({ stdout: `RUN-${runs}\n` }); } });
  const ws = {}, events = [], uiSockets = new Set([ws]);
  const controller = createMachineSpacesController({ broker, uiSockets, repoRootResolver: () => process.cwd(),
    safeSend(target, value) { if (target === ws) events.push(value); return true; },
    getState: () => snapshot, saveState(value) { snapshot = value; return value; }, broadcastState() {} });

  await controller.handle(ws, { type: 'request_machine_targets', ownerId: 'machine-owner-12345678' });
  await controller.handle(ws, { type: 'machine_create_target', targetType: 'powershell', cwd: process.cwd() });
  const target = broker.listTargets()[0];
  await controller.handle(ws, { type: 'machine_create_space', roomId: 'room-one', name: 'Build' });
  const space = snapshot.rooms[0].machineSpaces.spaces[0];
  await controller.handle(ws, { type: 'machine_attach_target', roomId: 'room-one', spaceId: space.id, targetId: target.id });
  await controller.handle(ws, { type: 'machine_enable_repo_grant', roomId: 'room-one', spaceId: space.id, targetId: target.id });
  assert.equal(space.grant.enabled, true);
  assert.equal(space.grant.policy, POLICY_ID);
  assert.equal(space.grant.repoRoot, process.cwd());

  const delivered = [];
  route(controller, ws, space.id, target.id, 'safe-one', 'git status --short', delivered);
  assert.equal(delivered[0].ok, true, JSON.stringify(delivered[0]));
  assert.match(delivered[0].message, /auto-approved/i);
  const done = await settled(snapshot, 'safe-one');
  assert.equal(runs, 1);
  assert.equal(done.state, 'completed');
  assert.equal(done.approvalMode, POLICY_ID);
  assert.equal(done.approvedByMemberId, 'agent-vera');
  assert.equal(done.approvedByName, 'Vera-Hark-Agent');
  assert.equal(done.commandDigest, commandDigest('git status --short'));
  assert.equal(done.grantId, space.grant.id);
  assert.equal(space.ledger.events[0].grantId, space.grant.id);

  route(controller, ws, space.id, target.id, 'unsafe-one', 'git push origin eve/nexus-machine-spaces', delivered);
  const unsafe = snapshot.rooms[0].machineSpaces.spaces[0].requests.find((entry) => entry.requestId === 'unsafe-one');
  assert.equal(unsafe.state, 'approval-required');
  assert.ok(unsafe.approvalId);
  assert.equal(runs, 1, 'unsafe command must not execute under the persistent grant');

  await controller.handle(ws, { type: 'machine_approve_command', approvalId: unsafe.approvalId, decision: 'deny' });
  await controller.handle(ws, { type: 'machine_revoke_repo_grant', roomId: 'room-one', spaceId: space.id });
  assert.equal(space.grant.enabled, false);
  assert.ok(space.grant.revokedAt);

  route(controller, ws, space.id, target.id, 'safe-after-revoke', 'git status --short', delivered);
  const after = snapshot.rooms[0].machineSpaces.spaces[0].requests.find((entry) => entry.requestId === 'safe-after-revoke');
  assert.equal(after.state, 'approval-required');
  assert.equal(runs, 1, 'revocation returns even safe commands to local approval');
  controller.stop();
});

test('Machine Spaces panel exposes local enable/revoke controls and documents unchanged caps', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/machine-spaces-ui.js'), 'utf8');
  assert.match(source, /machine_enable_repo_grant/);
  assert.match(source, /machine_revoke_repo_grant/);
  assert.match(source, /Terminal repo-safe/);
  assert.match(source, /Revoke grant/);
  assert.match(source, /30 second runtime and 1 MiB output caps remain in force/);
  assert.match(source, /restart\/kill commands/);
  assert.match(source, /git push\/reset\/clean\/branch switching/);
});
