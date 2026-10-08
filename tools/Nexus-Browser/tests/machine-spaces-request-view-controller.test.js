'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enhanceMachineSpacesRequestViewController } = require('../machine-spaces/server-controller-request-view');

function socket() { return {}; }

function fixture() {
  const owner = socket();
  const outsider = socket();
  const uiSockets = new Set([owner]);
  const sent = new Map();
  const safeSend = (ws, payload) => {
    const values = sent.get(ws) || [];
    values.push(payload);
    sent.set(ws, values);
    return true;
  };
  const state = {
    rooms: [{
      id: 'room-one',
      name: 'Room One',
      machineSpaces: {
        version: 1,
        spaces: [{
          id: 'space-one',
          name: 'Space One',
          archived: false,
          resourceIds: ['terminal-one'],
          requests: [{
            requestId: 'terminal-request', actorName: 'Vera-Hark-Agent', actorMemberId: 'vera',
            sourceMessageId: 'msg-terminal', terminalId: 'terminal-one', commandDigest: 'digest-terminal',
            commandSummary: 'git status --short', state: 'completed', outputId: 'output-terminal',
            createdAt: '2026-10-08T10:00:00.000Z'
          }],
          fileRequests: [{
            requestId: 'file-request', actorName: 'Eve-Main-Agent', actorMemberId: 'eve',
            sourceMessageId: 'msg-file', terminalId: 'terminal-one', grantId: 'grant-one',
            capability: 'files.patch', operationDigest: 'digest-file', operationSummary: 'patch src/app.js',
            state: 'failed', errorCode: 'MACHINE_FILE_HASH_MISMATCH',
            createdAt: '2026-10-08T10:01:00.000Z'
          }],
          fileGrants: []
        }]
      }
    }]
  };
  const base = {
    handle: async () => false,
    supervisedJobs: {
      snapshot: () => ({ jobs: [{
        jobId: 'job-one', requestId: 'supervised-request', roomId: 'room-one', spaceId: 'space-one',
        ownerMemberId: 'nova', targetId: 'terminal-one', processEpoch: 'epoch-one', kind: 'terminal-supervised',
        state: 'deferred', reason: 'local-supervisor-disconnected', createdAt: '2026-10-08T10:02:00.000Z'
      }, {
        jobId: 'job-other', requestId: 'other-request', roomId: 'room-other', spaceId: 'space-other',
        ownerMemberId: 'nova', targetId: 'terminal-two', processEpoch: 'epoch-two', kind: 'terminal-supervised',
        state: 'running', createdAt: '2026-10-08T10:03:00.000Z'
      }] })
    }
  };
  const controller = enhanceMachineSpacesRequestViewController(() => base, {
    uiSockets, safeSend, getState: () => state
  });
  const messages = (ws) => sent.get(ws) || [];
  return { owner, outsider, controller, messages };
}

test('local request view combines terminal, filesystem and exact-space supervised work', async () => {
  const f = fixture();
  await f.controller.handle(f.owner, {
    type: 'machine_request_view', requestId: 'view-all', roomId: 'room-one', spaceId: 'space-one', limit: 24
  });
  const result = f.messages(f.owner).at(-1);
  assert.equal(result.type, 'machine_request_view');
  assert.equal(result.requestId, 'view-all');
  assert.equal(result.roomId, 'room-one');
  assert.equal(result.spaceId, 'space-one');
  assert.deepEqual(result.items.map((item) => item.kind), ['supervised', 'filesystem', 'terminal']);
  assert.deepEqual(result.items.map((item) => item.id), ['supervised-request', 'file-request', 'terminal-request']);
  assert.equal(result.items.some((item) => item.id === 'other-request'), false);
});

test('request view exposes kind/state/actor/query/live filters through the controller', async () => {
  const f = fixture();
  await f.controller.handle(f.owner, {
    type: 'machine_request_view', requestId: 'view-filtered', roomId: 'room-one', spaceId: 'space-one',
    kind: 'filesystem', actor: 'eve', state: 'failed', query: 'grant-one', liveOnly: false
  });
  const result = f.messages(f.owner).at(-1);
  assert.deepEqual(result.items.map((item) => item.id), ['file-request']);
  assert.deepEqual(result.filters, {
    kinds: ['filesystem'], states: ['failed'], actor: 'eve', query: 'grant-one', liveOnly: false
  });
});

test('request view is local-only and rejects missing exact room/space identity', async () => {
  const f = fixture();
  await f.controller.handle(f.outsider, {
    type: 'machine_request_view', requestId: 'view-outsider', roomId: 'room-one', spaceId: 'space-one'
  });
  assert.equal(f.messages(f.outsider).at(-1).code, 'MACHINE_LOCAL_OWNER_REQUIRED');

  await f.controller.handle(f.owner, {
    type: 'machine_request_view', requestId: 'view-missing', roomId: 'room-one', spaceId: 'missing-space'
  });
  assert.equal(f.messages(f.owner).at(-1).code, 'MACHINE_SPACE_REQUIRED');
});
