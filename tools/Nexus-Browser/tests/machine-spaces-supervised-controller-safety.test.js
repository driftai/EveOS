'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupervisedJobCoordinator } = require('../machine-spaces/supervised-job');
const { enhanceMachineSpacesSupervisedController } = require('../machine-spaces/server-controller-supervised');

function fixture({ activeInfo = null, interrupt = true, governorReceiptReader = () => ({ state: 'EMPTY', runs: [] }) } = {}) {
  const ws = {};
  const uiSockets = new Set([ws]);
  const sent = [];
  const jobs = createSupervisedJobCoordinator({ idFactory: (() => { let n = 0; return () => `id-${++n}`; })() });
  const job = jobs.create({
    requestId: 'request-one', roomId: 'room-one', spaceId: 'space-one', ownerMemberId: 'agent-eve',
    targetId: 'terminal-one', processEpoch: 'epoch-one', commandDigest: 'sha256:one'
  });
  const commandStore = new Map([[job.jobId, { command: 'npm run dev' }]]);
  let runs = 0;
  const broker = {
    target(id) { return id === 'terminal-one' ? { id: 'terminal-one', processEpoch: 'epoch-one' } : null; },
    activeInfo() { return typeof activeInfo === 'function' ? activeInfo() : activeInfo; },
    interrupt() { return interrupt; },
    runSupervised() { runs++; return new Promise(() => {}); }
  };
  const base = {
    broker,
    spool: { store: () => ({ outputId: 'out-one' }) },
    providerControl: { owns: () => false, route: () => null },
    handle: async () => false,
    stop() {}
  };
  const controller = enhanceMachineSpacesSupervisedController(() => base, {
    uiSockets,
    safeSend(_ws, payload) { sent.push(payload); return true; },
    supervisedJobs: jobs,
    supervisedCommandStore: commandStore,
    governorReceiptReader,
    getState: () => ({ rooms: [] })
  });
  return { ws, sent, jobs, job, commandStore, controller, runs: () => runs };
}

test('busy target is rejected before queued supervised job transitions to running', async () => {
  const f = fixture({ activeInfo: { mode: 'bounded', requestId: 'other-request' } });
  await f.controller.handle(f.ws, { type: 'machine_start_supervised_job', jobId: f.job.jobId, requestId: 'ui-start' });
  assert.equal(f.jobs.status(f.job.jobId).state, 'queued');
  assert.equal(f.commandStore.has(f.job.jobId), true);
  assert.equal(f.runs(), 0);
  assert.equal(f.sent.at(-1).code, 'MACHINE_TARGET_BUSY');
});

test('unconfirmed interrupt settles a running supervised job with its current lease', async () => {
  let active = null;
  const f = fixture({ activeInfo: () => active, interrupt: false });
  const running = f.jobs.start(f.job.jobId, { sessionId: 'supervisor-one', targetId: 'terminal-one', processEpoch: 'epoch-one' });
  active = { mode: 'supervised', requestId: running.requestId };

  await f.controller.handle(f.ws, { type: 'machine_cancel_supervised_job', jobId: f.job.jobId, requestId: 'ui-cancel' });
  const settled = f.jobs.status(f.job.jobId);
  assert.equal(settled.state, 'outcome-unknown');
  assert.equal(settled.errorCode, 'MACHINE_JOB_INTERRUPT_UNCONFIRMED');
  assert.equal(settled.reason, 'interrupt-not-confirmed');
  assert.equal(f.commandStore.has(f.job.jobId), false);
  assert.notEqual(f.sent.at(-1).code, 'MACHINE_JOB_LEASE_INVALID');
});

test('cancelling a running job with no active process also carries the current lease', async () => {
  const f = fixture({ activeInfo: null });
  f.jobs.start(f.job.jobId, { sessionId: 'supervisor-one', targetId: 'terminal-one', processEpoch: 'epoch-one' });

  await f.controller.handle(f.ws, { type: 'machine_cancel_supervised_job', jobId: f.job.jobId, requestId: 'ui-cancel' });
  assert.equal(f.jobs.status(f.job.jobId).state, 'cancelled');
  assert.equal(f.commandStore.has(f.job.jobId), false);
});

test('Governor evidence is visible only to locally authenticated Machine Spaces UI', async () => {
  let reads = 0;
  const f = fixture({ governorReceiptReader: () => {
    reads++;
    return { schema: 'eveos.machine-governor-evidence.v1', state: 'AVAILABLE',
      runs: [{ runId: 'run-one', state: 'QUALIFIED' }] };
  } });
  await f.controller.handle({}, { type: 'machine_governor_receipts', requestId: 'provider-ask' });
  assert.equal(reads, 0, 'provider-origin client cannot read local evidence');
  await f.controller.handle(f.ws, { type: 'machine_governor_receipts', requestId: 'local-ask' });
  assert.equal(reads, 1);
  assert.equal(f.sent.at(-1).type, 'machine_governor_receipts');
  assert.equal(f.sent.at(-1).runs[0].runId, 'run-one');
  assert.equal(f.runs(), 0, 'read-only evidence never executes a terminal command');
});
