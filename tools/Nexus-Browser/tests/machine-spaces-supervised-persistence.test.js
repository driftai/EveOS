'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupervisedJobCoordinator } = require('../machine-spaces/supervised-job');

function memoryStore() {
  let value = null;
  return { load: () => value && structuredClone(value), save: (next) => { value = structuredClone(next); } };
}
function create(jobs, requestId) {
  return jobs.create({ requestId, roomId: 'room-one', spaceId: 'space-one', ownerMemberId: 'local',
    targetId: 'terminal-one', processEpoch: 'epoch-one', commandDigest: `digest-${requestId}` });
}

test('restart preserves terminal history and refuses to replay running or queued jobs', () => {
  const store = memoryStore();
  const first = createSupervisedJobCoordinator({ store, idFactory: (() => { let n = 0; return () => String(++n); })() });
  const queued = create(first, 'queued'), running = create(first, 'running'), done = create(first, 'done');
  first.authorize(running.jobId, { method: 'test-local-owner' });
  first.authorize(done.jobId, { method: 'test-local-owner' });
  first.start(running.jobId, { sessionId: 'owner' });
  const active = first.status(done.jobId);
  const started = first.start(done.jobId, { sessionId: 'owner' });
  first.settle(done.jobId, { state: 'completed', sessionId: 'owner', leaseId: started.lease.leaseId, result: { exitCode: 0 } });
  const restored = createSupervisedJobCoordinator({ store });
  assert.equal(restored.status(queued.jobId).state, 'cancelled');
  assert.equal(restored.status(running.jobId).state, 'outcome-unknown');
  assert.equal(restored.status(active.jobId).state, 'completed');
  assert.deepEqual(restored.recovered().map((job) => job.state).sort(), ['cancelled', 'outcome-unknown']);
  assert.throws(() => restored.start(running.jobId, { sessionId: 'new' }), /outcome-unknown/);
});
