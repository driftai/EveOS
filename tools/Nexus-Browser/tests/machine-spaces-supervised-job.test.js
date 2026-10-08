'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupervisedJobCoordinator } = require('../machine-spaces/supervised-job');

function fixture() {
  let now = Date.parse('2026-10-08T09:00:00.000Z');
  let n = 0;
  const jobs = createSupervisedJobCoordinator({ now: () => now, idFactory: () => `id-${++n}`, leaseTtlMs: 10000 });
  return { jobs, advance(ms) { now += ms; } };
}

function create(jobs, requestId = 'req-one') {
  return jobs.create({
    requestId,
    roomId: 'room-one', spaceId: 'space-one', ownerMemberId: 'agent-eve',
    targetId: 'terminal-powershell-one', processEpoch: 'session-one', commandDigest: 'sha256:abc'
  });
}

test('request id is exact-once and conflicting payload is rejected', () => {
  const { jobs } = fixture();
  const first = create(jobs);
  const retry = create(jobs);
  assert.equal(retry.jobId, first.jobId);
  assert.throws(() => jobs.create({ requestId: 'req-one', targetId: 'terminal-other', processEpoch: 'session-one', commandDigest: 'sha256:abc' }), {
    code: 'MACHINE_JOB_REQUEST_CONFLICT'
  });
});

test('rebound requires the same trusted terminal process epoch and rotates the lease monotonically', () => {
  const { jobs } = fixture();
  const job = create(jobs);
  const started = jobs.start(job.jobId, { sessionId: 'browser-session-a', targetId: job.targetId, processEpoch: job.processEpoch });
  const firstLease = started.lease.leaseId;
  assert.equal(started.lease.generation, 1);
  assert.equal(started.leaseGeneration, 1);
  const deferred = jobs.defer(job.jobId, { sessionId: 'browser-session-a', leaseId: firstLease, reason: 'socket-lost' });
  assert.equal(deferred.state, 'deferred');
  assert.equal(deferred.lease, null);
  assert.equal(deferred.leaseGeneration, 1);

  assert.throws(() => jobs.rebound(job.jobId, { sessionId: 'browser-session-b', targetId: job.targetId, processEpoch: 'replacement-process' }), {
    code: 'MACHINE_JOB_TARGET_EPOCH_MISMATCH'
  });

  const rebound = jobs.rebound(job.jobId, { sessionId: 'browser-session-b', targetId: job.targetId, processEpoch: job.processEpoch });
  assert.equal(rebound.state, 'running');
  assert.equal(rebound.reboundCount, 1);
  assert.notEqual(rebound.lease.leaseId, firstLease);
  assert.equal(rebound.lease.generation, 2);
  assert.equal(rebound.leaseGeneration, 2);
});

test('stale supervision lease cannot settle a running job', () => {
  const { jobs } = fixture();
  const job = create(jobs);
  const running = jobs.start(job.jobId, { sessionId: 'session-a' });
  assert.throws(() => jobs.settle(job.jobId, { state: 'completed', sessionId: 'session-b', leaseId: running.lease.leaseId, result: { ok: true } }), {
    code: 'MACHINE_JOB_LEASE_INVALID'
  });
  const done = jobs.settle(job.jobId, { state: 'completed', sessionId: 'session-a', leaseId: running.lease.leaseId, result: { ok: true } });
  assert.equal(done.state, 'completed');
});

test('same terminal settlement is idempotent but a contradictory second outcome is rejected', () => {
  const { jobs } = fixture();
  const job = create(jobs);
  const running = jobs.start(job.jobId, { sessionId: 'session-a' });
  const input = { state: 'failed', sessionId: 'session-a', leaseId: running.lease.leaseId, result: { exitCode: 2 }, errorCode: 'EXIT_2' };
  const first = jobs.settle(job.jobId, input);
  const retry = jobs.settle(job.jobId, input);
  assert.deepEqual(retry, first);
  assert.throws(() => jobs.settle(job.jobId, { ...input, state: 'completed' }), { code: 'MACHINE_JOB_ALREADY_SETTLED' });
});

test('session loss defers work without replay and target loss terminalizes uncertain work', () => {
  const { jobs } = fixture();
  const one = create(jobs, 'req-one');
  const two = create(jobs, 'req-two');
  jobs.start(one.jobId, { sessionId: 'session-a' });
  jobs.start(two.jobId, { sessionId: 'session-b' });

  const deferred = jobs.terminalizeForSession('session-a', 'provider-disconnected');
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].state, 'deferred');
  assert.equal(jobs.status(two.jobId).state, 'running');

  const uncertain = jobs.terminalizeForTarget(two.targetId, two.processEpoch, 'terminal-stopped');
  assert.equal(uncertain.length, 2);
  assert.ok(uncertain.every((entry) => entry.state === 'outcome-unknown'));
  assert.ok(uncertain.every((entry) => entry.errorCode === 'MACHINE_JOB_TARGET_LOST'));
});

test('audit snapshot exposes lifecycle without secret lease tokens beyond lease id', () => {
  const { jobs } = fixture();
  const job = create(jobs);
  const running = jobs.start(job.jobId, { sessionId: 'session-a' });
  jobs.defer(job.jobId, { sessionId: 'session-a', leaseId: running.lease.leaseId });
  jobs.rebound(job.jobId, { sessionId: 'session-b', targetId: job.targetId, processEpoch: job.processEpoch });
  const snapshot = jobs.snapshot();
  assert.deepEqual(snapshot.events.map((entry) => entry.type), ['created', 'started', 'deferred', 'rebound']);
  assert.equal(snapshot.jobs[0].reboundCount, 1);
  assert.equal(snapshot.jobs[0].leaseGeneration, 2);
});
