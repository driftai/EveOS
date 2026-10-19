'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSupervisedJobCoordinator } = require('../machine-spaces/supervised-job');
const { enhanceMachineSpacesSupervisedController } = require('../machine-spaces/server-controller-supervised');
const { enhanceMachineSpacesHumanGateController, MUTATING_TYPES } = require('../machine-spaces/server-controller-human-gate');
const { createSupervisedLiveView } = require('../machine-spaces/supervised-live-view');

function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-recovery-supervised-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tools', 'repair.js'), 'process.exit(1);');
  const target = { id: 'terminal-one', type: 'powershell', cwd: repo, processEpoch: 'epoch-one' };
  const room = { id: 'room-one', settings: { middleAgentMode: 'manual', middleAgentMemberId: 'tlo' },
    members: [{ id: 'tlo', name: 'TLO', relayEnabled: true,
      binding: { targetClassId: 'local-origin', providerId: 'tlo-chat', targetId: 'local:tlo' } }],
    machineSpaces: { spaces: [{ id: 'space-one', resourceIds: [target.id] }] } };
  const ui = {}, sent = [], jobs = createSupervisedJobCoordinator({ idFactory: () => 'one' });
  let runs = 0;
  const observed = [];
  const base = { broker: { target: (id) => id === target.id ? target : null, activeInfo: () => null,
      runSupervised(input) { runs++; input.onData?.({ stream: 'stdout', text: 'running\n' }); return new Promise(() => {}); } },
    spool: { store: () => ({ outputId: 'out' }) }, providerControl: { owns: () => false, route: () => null },
    async handle() { return false; }, stop() {} };
  const shared = { uiSockets: new Set([ui]), safeSend(_ws, payload) { sent.push(payload); return true; },
    getState: () => ({ rooms: [room] }), supervisedJobs: jobs, governorRoot: repo,
    resolveSupervisedHead: () => 'b'.repeat(40), supervisedLiveView: { start(input) { observed.push(input);
      return { write(detail) { observed.push(detail); }, finish() {} }; } } };
  const controller = enhanceMachineSpacesHumanGateController(
    (options) => enhanceMachineSpacesSupervisedController(() => base, options), shared);
  const input = { type: 'machine_prepare_recovery_job', requestId: 'recovery-request-one',
    roomId: room.id, spaceId: 'space-one', targetId: target.id, runId: 'recovery-001',
    branch: 'eve/nexus-machine-spaces', expectedHead: 'a'.repeat(40), retrySafety: 'idempotent',
    command: 'node tools/repair.js', repairFiles: ['tools/repair.js'], contextFiles: ['tools/repair.js'],
    invariants: ['preserve exact receipts'], maxAttempts: 1 };
  return { ui, sent, jobs, controller, input, runs: () => runs, observed };
}

test('recovery preparation is Human-Input-gated and remains inert until exact local Start', async t => {
  const f = fixture(t);
  assert.ok(MUTATING_TYPES.has('machine_prepare_recovery_job'));
  await f.controller.handle(f.ui, f.input);
  assert.equal(f.jobs.snapshot().jobs.length, 0);
  await f.controller.handle(f.ui, { type: 'machine_set_human_input', enabled: true });
  await f.controller.handle(f.ui, f.input);
  const job = f.jobs.snapshot().jobs[0], prepared = f.sent.find((row) => row.type === 'machine_recovery_job_prepared');
  assert.equal(job.kind, 'recovery'); assert.equal(job.state, 'queued'); assert.equal(f.runs(), 0);
  assert.equal(prepared.job.commandPreview, 'node tools/repair.js');
  assert.equal(prepared.job.recovery.retrySafety, 'idempotent');
  await f.controller.handle(f.ui, { type: 'machine_start_supervised_job', jobId: job.jobId });
  assert.equal(f.runs(), 1); assert.equal(f.jobs.status(job.jobId).state, 'running');
});

test('recovery preparation rejects an unsafe retry contract before creating a job', async t => {
  const f = fixture(t);
  await f.controller.handle(f.ui, { type: 'machine_set_human_input', enabled: true });
  await f.controller.handle(f.ui, { ...f.input, retrySafety: 'unknown' });
  assert.equal(f.jobs.snapshot().jobs.length, 0);
  assert.equal(f.sent.at(-1).code, 'MACHINE_RECOVERY_RETRY_UNSAFE');
});

test('explicit room recovery intent binds TLO and one EveOS-rooted terminal but stays inert until Start', async t => {
  const f = fixture(t);
  assert.ok(MUTATING_TYPES.has('machine_prepare_room_recovery'));
  await f.controller.handle(f.ui, { type: 'machine_set_human_input', enabled: true });
  await f.controller.handle(f.ui, { type: 'machine_prepare_room_recovery', requestId: 'room-recovery:one',
    runId: 'room-recovery-one', roomId: 'room-one', spaceId: 'space-one', scriptPath: 'tools/repair.js',
    visibleTerminal: true, retrySafeConfirmed: true });
  const job = f.jobs.snapshot().jobs[0];
  const prepared = f.sent.find((row) => row.type === 'machine_recovery_job_prepared');
  assert.equal(job.state, 'queued'); assert.equal(f.runs(), 0);
  assert.equal(prepared.job.recovery.worker.memberId, 'tlo');
  assert.equal(prepared.job.visibleTerminal, true);
  assert.match(prepared.job.commandPreview, /& 'node' 'tools\/repair\.js'/);
  assert.match(prepared.job.commandPreview, /exit \$LASTEXITCODE/);
  await f.controller.handle(f.ui, { type: 'machine_start_supervised_job', jobId: job.jobId });
  assert.equal(f.runs(), 1);
  assert.equal(f.observed[0].jobId, job.jobId);
  assert.equal(f.observed[1].text, 'running\n');
});

test('room shortcut refuses implicit idempotence and never queues work', async t => {
  const f = fixture(t);
  await f.controller.handle(f.ui, { type: 'machine_set_human_input', enabled: true });
  await f.controller.handle(f.ui, { type: 'machine_prepare_room_recovery', requestId: 'room-recovery:unsafe',
    runId: 'room-recovery-unsafe', roomId: 'room-one', spaceId: 'space-one', scriptPath: 'tools/repair.js' });
  assert.equal(f.jobs.snapshot().jobs.length, 0);
  assert.equal(f.sent.at(-1).code, 'MACHINE_RECOVERY_IDEMPOTENCE_REQUIRED');
});

test('visible terminal view is an observer log and never owns command execution', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-recovery-view-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const spawns = [], view = createSupervisedLiveView({ repoRoot: repo, platform: 'win32',
    spawnImpl(file, args, options) { spawns.push({ file, args, options });
      return { once() {}, unref() {} }; } });
  const observer = view.start({ jobId: 'machine-job-123456', command: 'node safe.js' });
  observer.write({ stream: 'stdout', text: 'proof\n' }); observer.finish({ state: 'completed' });
  assert.equal(spawns.length, 1); assert.equal(spawns[0].file, 'powershell.exe');
  assert.equal(spawns[0].options.windowsHide, false);
  assert.match(fs.readFileSync(observer.logPath, 'utf8'), /proof[\s\S]*completed/);
  assert.equal(fs.existsSync(observer.donePath), true);
});
