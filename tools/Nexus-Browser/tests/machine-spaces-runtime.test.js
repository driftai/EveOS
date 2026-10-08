'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createManagedTerminalBroker, shellInvocation } = require('../machine-spaces/managed-terminal-broker');
const { createApprovalBroker, classifyRisk, commandDigest } = require('../machine-spaces/approval-broker');
const { createOutputSpool } = require('../machine-spaces/output-spool');
const { createMachineSpacesController } = require('../machine-spaces/server-controller');

function assertCode(action, code) { assert.throws(action, (error) => error.code === code); }
function fakeChild({ stdout = 'OK\n', stderr = '', exitCode = 0 } = {}) {
  const child = new EventEmitter();
  child.pid = 4321; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; };
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', exitCode, null);
  });
  return child;
}
function nextEvent(events, type) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = events.find((entry) => entry.type === type);
      if (found) { clearInterval(timer); resolve(found); }
      else if (Date.now() - started > 1000) { clearInterval(timer); reject(new Error(`Timed out waiting for ${type}`)); }
    }, 2);
  });
}

test('managed terminals use shell:false, exact broker ownership and bounded session identity', async () => {
  const calls = [];
  const broker = createManagedTerminalBroker({ platform: 'win32', defaultCwd: process.cwd(),
    idFactory: () => 'fixed-id', executableCheck: () => true, spawnImpl(file, args, options) {
      calls.push({ file, args, options }); return fakeChild();
    } });
  const target = broker.createSession({ type: 'powershell', label: 'Test terminal' });
  assert.equal(target.id, 'terminal-powershell-fixed-id');
  assert.equal(target.sessionOrigin, 'managed');
  assert.equal(target.capabilities.trustedAttach, false);
  const result = await broker.run({ targetId: target.id, requestId: 'request-one', command: 'Write-Output OK' });
  assert.equal(result.state, 'completed');
  assert.equal(result.stdout, 'OK\n');
  assert.equal(calls[0].file, 'powershell.exe');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, target.cwd);
  assert.equal(broker.stopSession(target.id), true);
  await assert.rejects(broker.run({ targetId: target.id, command: 'echo no' }),
    (error) => error.code === 'MACHINE_TARGET_NOT_FOUND');
  assert.equal(shellInvocation('cmd', 'echo x', 'win32').file, 'cmd.exe');
});

test('allow-once approval is exact-owner, exact-command, expiring and challenged for high risk', () => {
  let stamp = 100;
  const approvals = createApprovalBroker({ now: () => stamp, ttlMs: 50,
    idFactory: () => 'approval-one', challengeFactory: () => 'ABC123' });
  const safe = approvals.prepare({ ownerId: 'owner-one', targetId: 'terminal-one',
    requestId: 'request-one', command: 'Get-ChildItem' });
  assert.equal(safe.risk, 'os-user-wide');
  assert.equal(safe.commandDigest, commandDigest('Get-ChildItem'));
  assertCode(() => approvals.decide({ ownerId: 'owner-two', approvalId: safe.approvalId,
    decision: 'allow-once' }), 'MACHINE_APPROVAL_INVALID');
  assert.equal(approvals.decide({ ownerId: 'owner-one', approvalId: safe.approvalId,
    decision: 'allow-once' }).allowed, true);
  const high = approvals.prepare({ ownerId: 'owner-one', targetId: 'terminal-one',
    requestId: 'request-two', command: 'Remove-Item file.txt' });
  assert.equal(classifyRisk('Remove-Item file.txt'), 'high');
  assertCode(() => approvals.decide({ ownerId: 'owner-one', approvalId: high.approvalId,
    decision: 'allow-once', challenge: 'wrong' }), 'MACHINE_APPROVAL_CHALLENGE');
  assert.equal(approvals.decide({ ownerId: 'owner-one', approvalId: high.approvalId,
    decision: 'allow-once', challenge: 'abc123' }).allowed, true);
  const expired = approvals.prepare({ ownerId: 'owner-one', targetId: 'terminal-one',
    requestId: 'request-three', command: 'pwd' });
  stamp = 151;
  assertCode(() => approvals.decide({ ownerId: 'owner-one', approvalId: expired.approvalId,
    decision: 'allow-once' }), 'MACHINE_APPROVAL_INVALID');
});

test('terminal output pages are bounded and cannot cross owner or room audiences', () => {
  const spool = createOutputSpool({ pageBytes: 4, idFactory: () => 'machine-output-one' });
  const output = spool.store({ requestId: 'request-one', audience: 'owner:one', stdout: 'abcdefgh' });
  assert.deepEqual(spool.page(output.outputId, { audience: 'owner:one' }), {
    outputId: output.outputId, requestId: 'request-one', stream: 'combined', offset: 0,
    text: 'abcd', nextOffset: 4, totalChars: 8, totalBytes: 8, state: 'completed', exitCode: null
  });
  assert.equal(spool.page(output.outputId, { audience: 'owner:one', offset: 4 }).text, 'efgh');
  assertCode(() => spool.page(output.outputId, { audience: 'room:one' }), 'MACHINE_OUTPUT_NOT_FOUND');
});

test('Base and Dex commands never execute before local approval and settle into separate output storage', async () => {
  let runs = 0, snapshot = { version: 1, rooms: [{ id: 'room-one', name: 'Room', members: [], messages: [] }] };
  const broker = createManagedTerminalBroker({ platform: 'win32', defaultCwd: process.cwd(),
    idFactory: (() => { let n = 0; return () => `id-${++n}`; })(),
    executableCheck: () => true,
    spawnImpl() { runs++; return fakeChild({ stdout: `RUN-${runs}\n` }); } });
  const ws = {}, events = [], uiSockets = new Set([ws]);
  const controller = createMachineSpacesController({ broker, uiSockets,
    safeSend(target, value) { if (target === ws) events.push(value); return true; },
    getState: () => snapshot, saveState(value) { snapshot = value; return value; }, broadcastState() {} });
  await controller.handle(ws, { type: 'request_machine_targets', ownerId: 'machine-owner-12345678' });
  await controller.handle(ws, { type: 'machine_create_target', targetType: 'powershell', cwd: process.cwd() });
  const target = broker.listTargets()[0];
  await controller.handle(ws, { type: 'machine_prepare_command', requestId: 'base-request',
    targetId: target.id, command: 'Write-Output Base' });
  const baseApproval = events.find((entry) => entry.type === 'machine_command_prepared');
  assert.equal(runs, 0);
  await controller.handle(ws, { type: 'machine_approve_command', approvalId: baseApproval.approvalId,
    decision: 'allow-once' });
  const baseDone = await nextEvent(events, 'machine_command_complete');
  assert.equal(runs, 1);
  await controller.handle(ws, { type: 'machine_output_page', outputId: baseDone.outputId });
  assert.equal(events.find((entry) => entry.type === 'machine_output_page').text, 'RUN-1\n');

  await controller.handle(ws, { type: 'machine_set_human_input', enabled: true });
  await controller.handle(ws, { type: 'machine_create_space', roomId: 'room-one', name: 'Build' });
  const space = snapshot.rooms[0].machineSpaces.spaces[0];
  await controller.handle(ws, { type: 'machine_attach_target', roomId: 'room-one',
    spaceId: space.id, targetId: target.id });
  const delivered = [];
  controller.providerControl.route({ source: {}, command: { action: 'terminal_exec', space: space.id,
    terminal: target.id, command: 'Write-Output Dex' }, requestId: 'dex-request-one', ws,
    origin: { roomId: 'room-one', executorMemberId: 'agent-one', executorName: 'Eve', agentMessageId: 'message-one' } }, {
    commitOriginReceipt: () => ({ id: 'receipt-one' }), sendResult: (_recipient, result) => delivered.push(result)
  });
  assert.equal(delivered[0].ok, true);
  assert.equal(delivered[0].data.request.state, 'approval-required');
  assert.equal(runs, 1, 'provider requests never execute without a local owner decision');
  const dexRequest = snapshot.rooms[0].machineSpaces.spaces[0].requests[0];
  await controller.handle(ws, { type: 'machine_approve_command', approvalId: dexRequest.approvalId,
    decision: 'allow-once' });
  while (snapshot.rooms[0].machineSpaces.spaces[0].requests[0].state === 'running') await new Promise((r) => setTimeout(r, 2));
  const settled = snapshot.rooms[0].machineSpaces.spaces[0].requests[0];
  assert.equal(runs, 2);
  assert.equal(settled.state, 'completed');
  assert.ok(settled.outputId);
  assert.equal(snapshot.rooms[0].messages.length, 0, 'terminal output never floods the ordinary room transcript');

  // Outside a relay turn (no origin): read-only lookups use the exact bound room,
  // while terminal_exec still demands a relay origin for provenance.
  const loose = [];
  const sink = { commitOriginReceipt: () => null, sendResult: (_r, result) => loose.push(result) };
  controller.providerControl.route({ source: {}, command: { action: 'terminal_targets', space: space.id },
    requestId: 'loose-targets', ws, origin: null, boundRoomId: 'room-one' }, sink);
  assert.equal(loose[0].ok, true, JSON.stringify(loose[0]));
  assert.equal(loose[0].data.targets[0].id, target.id);
  controller.providerControl.route({ source: {}, command: { action: 'terminal_exec', space: space.id,
    terminal: target.id, command: 'Write-Output Loose' }, requestId: 'loose-exec', ws, origin: null, boundRoomId: 'room-one' }, sink);
  assert.equal(loose[1].ok, false);
  assert.equal(loose[1].code, 'MACHINE_ORIGIN_REQUIRED');
  assert.equal(runs, 2, 'an origin-less exec never runs or queues');
  controller.stop();
});
