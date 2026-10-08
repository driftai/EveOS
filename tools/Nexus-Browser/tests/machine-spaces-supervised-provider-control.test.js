'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupervisedJobCoordinator } = require('../machine-spaces/supervised-job');
const { createSupervisedJobProviderControl } = require('../machine-spaces/supervised-job-provider-control');

function fixture() {
  const jobs = createSupervisedJobCoordinator({ idFactory: (() => { let n = 0; return () => `id-${++n}`; })() });
  const commandStore = new Map();
  const room = { id: 'room-one', machineSpaces: { spaces: [{ id: 'space-one', name: 'Build', resourceIds: ['terminal-one'] }] } };
  const target = { id: 'terminal-one', processEpoch: 'session-one' };
  const broker = { target: (id) => id === target.id ? target : null };
  const control = createSupervisedJobProviderControl({ jobs, commandStore, broker,
    getState: () => ({ rooms: [room] }), findSpace: (value, ref) => value.machineSpaces.spaces.find((space) => space.id === ref || space.name === ref) });
  return { jobs, commandStore, control };
}

function input(action, command = {}, origin = undefined) {
  return {
    source: { providerId: 'chatgpt', targetClassId: 'online-origin' },
    command: { action, ...command },
    requestId: command.requestId || `request-${action}`,
    boundRoomId: 'room-one',
    origin: origin === undefined ? {
      roomId: 'room-one', executorMemberId: 'agent-eve', executorName: 'Eve-Main-Agent', agentMessageId: `msg-${action}`
    } : origin
  };
}

test('agent may prepare but not remotely launch a supervised command', () => {
  const { control, commandStore } = fixture();
  const result = control.route(input('job_prepare', { space: 'space-one', terminal: 'terminal-one', command: 'npm run dev' }));
  assert.equal(result.ok, true);
  assert.equal(result.data.state, 'queued');
  assert.equal(result.data.commandAvailable, true);
  assert.equal(commandStore.size, 1);
  assert.equal(control.owns('job_start'), false, 'remote provider surface must not expose launch');
  assert.equal(control.owns('job_rebound'), false, 'remote provider surface must not expose rebound');
});

test('job_prepare requires exact committed relay provenance', () => {
  const { control, commandStore } = fixture();
  const result = control.route(input('job_prepare', { space: 'space-one', terminal: 'terminal-one', command: 'npm run dev' }, null));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MACHINE_JOB_ORIGIN_REQUIRED');
  assert.equal(commandStore.size, 0);
});

test('prepared request id is exact-once and conflicting command cannot replace it', () => {
  const { control } = fixture();
  const first = input('job_prepare', { space: 'space-one', terminal: 'terminal-one', command: 'npm run dev', requestId: 'same-request' });
  first.requestId = 'same-request';
  const retry = control.route(first);
  const repeated = control.route(first);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.data.jobId, retry.data.jobId);

  const conflict = input('job_prepare', { space: 'space-one', terminal: 'terminal-one', command: 'npm run other', requestId: 'same-request' });
  conflict.requestId = 'same-request';
  const rejected = control.route(conflict);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'MACHINE_JOB_REQUEST_CONFLICT');
});

test('job status/list stay scoped to the authorized room and space', () => {
  const { control } = fixture();
  const prepared = control.route(input('job_prepare', { space: 'space-one', terminal: 'terminal-one', command: 'npm run dev' }));
  const listed = control.route(input('job_list', { space: 'space-one' }, null));
  assert.equal(listed.ok, true);
  assert.equal(listed.data.length, 1);
  const status = control.route(input('job_status', { space: 'space-one', jobId: prepared.data.jobId }, null));
  assert.equal(status.ok, true);
  assert.equal(status.data.jobId, prepared.data.jobId);
});
