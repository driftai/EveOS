'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFilesystemBroker } = require('../machine-spaces/filesystem-broker');
const { createFilesystemProviderControl } = require('../machine-spaces/filesystem-provider-control');
const { createCapabilityGrant } = require('../machine-spaces/capability-grant');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-navigator-control-'));
  fs.writeFileSync(path.join(root, 'target-alpha.js'), 'hello');
  const space = { id: 'space-one', name: 'Workspace', archived: false,
    resourceIds: ['terminal-one'], fileGrants: [], fileRequests: [] };
  let state = { rooms: [{ id: 'room-one', name: 'Room', machineSpaces: { version: 1, spaces: [space] } }] };
  const results = [];
  const machine = createFilesystemProviderControl({
    getState: () => state,
    saveState: snapshot => (state = snapshot),
    broadcastState: () => {},
    broker: { target: id => id === 'terminal-one' ? { cwd: root } : null },
    filesystemBroker: createFilesystemBroker(),
    repoRootResolver: value => value,
    notifyRoom: () => {},
    now: () => 1_800_000_000_000
  });
  const helpers = {
    commitOriginReceipt: () => null,
    sendResult: (_waiter, result) => results.push(result)
  };
  function request(action, requestId, extras = {}, origin = {}) {
    machine.route({
      command: { action, space: 'space-one', terminal: 'terminal-one', ...extras },
      requestId, ws: {}, source: {}, boundRoomId: 'room-one',
      origin: { roomId: 'room-one', executorMemberId: 'tlo-one', executorName: 'TLO',
        agentMessageId: 'agent-message-one', ...origin }
    }, helpers);
    return results.at(-1);
  }
  function permit() {
    space.fileGrants.push(createCapabilityGrant({ repoRoot: root, targetId: 'terminal-one',
      ownerId: 'local-owner', capabilities: ['files.search'], now: () => 1_800_000_000_000 }));
  }
  return { root, space, results, permit, request, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('Navigator provider commands require the existing scoped files.search grant', () => {
  const f = fixture();
  try {
    const denied = f.request('nav_search', 'nav-request-one', { query: 'target' });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'MACHINE_FILE_GRANT_REQUIRED');
    assert.equal(f.space.fileRequests.length, 0);

    f.permit();
    const allowed = f.request('nav_search', 'nav-request-one', { query: 'target' });
    assert.equal(allowed.ok, true);
    assert.deepEqual(allowed.data.result.results.map(row => row.path), ['target-alpha.js']);
    assert.equal(allowed.data.request.capability, 'files.search');
    assert.equal(f.space.fileRequests[0].state, 'completed');
    assert.equal(f.space.ledger.events[0].state, 'completed');
  } finally { f.cleanup(); }
});

test('Navigator status is not available through a grant-free side channel', () => {
  const f = fixture();
  try {
    assert.equal(f.request('nav_status', 'status-one').code, 'MACHINE_FILE_GRANT_REQUIRED');
    f.permit();
    const result = f.request('nav_status', 'status-two');
    assert.equal(result.ok, true);
    assert.equal(result.data.result.mode, 'bounded-live-scan');
    assert.equal(result.data.result.mutationAuthority, 'machine-spaces');
  } finally { f.cleanup(); }
});

test('Exact request-ID duplicates do not rescan or repeat, and mismatched intent conflicts', () => {
  const f = fixture();
  try {
    f.permit();
    assert.equal(f.request('nav_search', 'same-request', { query: 'target' }).ok, true);
    fs.unlinkSync(path.join(f.root, 'target-alpha.js'));
    const duplicate = f.request('nav_search', 'same-request', { query: 'target' });
    assert.equal(duplicate.ok, true);
    assert.match(duplicate.message, /already exists/);
    assert.equal(f.space.fileRequests.length, 1);
    const conflict = f.request('nav_search', 'same-request', { query: 'different' });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'MACHINE_REQUEST_ID_CONFLICT');
  } finally { f.cleanup(); }
});

test('Navigator refuses wrong-room, missing-origin and wrong-target requests', () => {
  const f = fixture();
  try {
    f.permit();
    assert.equal(f.request('nav_search', 'wrong-room', { query: 'target' }, { roomId: 'other-room' }).code,
      'MACHINE_ROOM_NOT_FOUND');
    const wrongTarget = f.request('nav_search', 'wrong-target', { terminal: 'other', query: 'target' });
    assert.equal(wrongTarget.code, 'MACHINE_TARGET_NOT_ATTACHED');
    assert.equal(f.space.ledger, undefined);
  } finally { f.cleanup(); }
});
