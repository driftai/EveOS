'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSupervisedJobCoordinator } = require('../machine-spaces/supervised-job');
const { enhanceMachineSpacesSupervisedController } = require('../machine-spaces/server-controller-supervised');
const { enhanceMachineSpacesHumanGateController, MUTATING_TYPES } = require('../machine-spaces/server-controller-human-gate');

function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-recovery-supervised-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tools', 'repair.js'), 'process.exit(1);');
  const target = { id: 'terminal-one', type: 'powershell', cwd: repo, processEpoch: 'epoch-one' };
  const room = { id: 'room-one', machineSpaces: { spaces: [{ id: 'space-one', resourceIds: [target.id] }] } };
  const ui = {}, sent = [], jobs = createSupervisedJobCoordinator({ idFactory: () => 'one' });
  let runs = 0;
  const base = { broker: { target: (id) => id === target.id ? target : null, activeInfo: () => null,
      runSupervised() { runs++; return new Promise(() => {}); } },
    spool: { store: () => ({ outputId: 'out' }) }, providerControl: { owns: () => false, route: () => null },
    async handle() { return false; }, stop() {} };
  const shared = { uiSockets: new Set([ui]), safeSend(_ws, payload) { sent.push(payload); return true; },
    getState: () => ({ rooms: [room] }), supervisedJobs: jobs, governorRoot: repo };
  const controller = enhanceMachineSpacesHumanGateController(
    (options) => enhanceMachineSpacesSupervisedController(() => base, options), shared);
  const input = { type: 'machine_prepare_recovery_job', requestId: 'recovery-request-one',
    roomId: room.id, spaceId: 'space-one', targetId: target.id, runId: 'recovery-001',
    branch: 'eve/nexus-machine-spaces', expectedHead: 'a'.repeat(40), retrySafety: 'idempotent',
    command: 'node tools/repair.js', repairFiles: ['tools/repair.js'], contextFiles: ['tools/repair.js'],
    invariants: ['preserve exact receipts'], maxAttempts: 1 };
  return { ui, sent, jobs, controller, input, runs: () => runs };
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
