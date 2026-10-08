'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRequestView, provenance, decodeCursor } = require('../machine-spaces/request-view');

const terminal = [{
  requestId: 'term-1', actorName: 'Vera-Hark-Agent', actorMemberId: 'agent-vera', sourceMessageId: 'msg-vera',
  terminalId: 'terminal-one', commandDigest: 'digest-terminal', commandSummary: 'git status --short', state: 'completed',
  outputId: 'out-one', createdAt: '2026-10-08T10:00:00.000Z'
}];
const files = [{
  requestId: 'file-1', actorName: 'Eve-Main-Agent', actorMemberId: 'agent-eve', sourceMessageId: 'msg-eve',
  terminalId: 'terminal-one', grantId: 'grant-one', capability: 'files.patch', operationDigest: 'digest-file',
  operationSummary: 'patch src/app.js', state: 'failed', errorCode: 'MACHINE_FILE_HASH_MISMATCH',
  createdAt: '2026-10-08T10:01:00.000Z'
}];
const jobs = [{
  jobId: 'job-one', requestId: 'job-1', ownerMemberId: 'agent-nova', targetId: 'terminal-two', processEpoch: 'session-two',
  kind: 'terminal-supervised', state: 'deferred', reason: 'local-supervisor-disconnected', result: { outputId: 'out-job' },
  createdAt: '2026-10-08T10:02:00.000Z'
}];

test('provenance retains exact control/resource identifiers for audit UI', () => {
  const value = provenance(files[0]);
  assert.deepEqual(value, {
    requestId: 'file-1', sourceMessageId: 'msg-eve', actorMemberId: 'agent-eve', actorName: 'Eve-Main-Agent',
    terminalId: 'terminal-one', processEpoch: null, grantId: 'grant-one', capability: 'files.patch',
    commandDigest: null, operationDigest: 'digest-file', outputId: null
  });
});

test('combined request view sorts newest first and classifies all machine work', () => {
  const view = buildRequestView({ terminalRequests: terminal, fileRequests: files, supervisedJobs: jobs });
  assert.deepEqual(view.items.map((item) => item.kind), ['supervised', 'filesystem', 'terminal']);
  assert.deepEqual(view.items.map((item) => item.id), ['job-1', 'file-1', 'term-1']);
  assert.equal(view.items[0].live, true);
  assert.equal(view.items[1].live, false);
});

test('filters can isolate live work, kind, actor, state and provenance text', () => {
  const all = { terminalRequests: terminal, fileRequests: files, supervisedJobs: jobs };
  assert.deepEqual(buildRequestView(all, { liveOnly: true }).items.map((item) => item.id), ['job-1']);
  assert.deepEqual(buildRequestView(all, { kind: 'filesystem' }).items.map((item) => item.id), ['file-1']);
  assert.deepEqual(buildRequestView(all, { actor: 'eve' }).items.map((item) => item.id), ['file-1']);
  assert.deepEqual(buildRequestView(all, { state: 'completed' }).items.map((item) => item.id), ['term-1']);
  assert.deepEqual(buildRequestView(all, { query: 'grant-one' }).items.map((item) => item.id), ['file-1']);
  assert.deepEqual(buildRequestView(all, { query: 'session-two' }).items.map((item) => item.id), ['job-1']);
});

test('cursor pagination is stable and never repeats the boundary item', () => {
  const data = { terminalRequests: terminal, fileRequests: files, supervisedJobs: jobs };
  const first = buildRequestView(data, { limit: 2 });
  assert.deepEqual(first.items.map((item) => item.id), ['job-1', 'file-1']);
  assert.equal(first.hasMore, true);
  assert.ok(decodeCursor(first.nextCursor));
  const second = buildRequestView(data, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((item) => item.id), ['term-1']);
  assert.equal(second.hasMore, false);
});
