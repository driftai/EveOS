'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspaceProvisionProviderControl } = require('../machine-spaces/workspace-provision-provider-control');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-workspace-provision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let created = 0;
  const targets = new Map();
  const broker = {
    createSession(input) {
      created += 1;
      const target = { id: `terminal-${created}`, processEpoch: `epoch-${created}`,
        type: input.type, cwd: fs.realpathSync(input.cwd) };
      targets.set(target.id, target); return target;
    },
    target(id) { return targets.get(id) || null; },
    stopSession(id) { return targets.delete(id); }
  };
  let snapshot = { rooms: [{ id: 'room-one', name: 'Fresh Room',
    settings: { middleAgentMode: 'manual', middleAgentMemberId: 'agent-tlo' },
    members: [{ id: 'agent-tlo', name: 'TLO', relayEnabled: true,
      binding: { providerId: 'tlo-chat', targetClassId: 'local-origin', targetId: 'local:tlo' } }],
    machineSpaces: { version: 1, spaces: [] } }] };
  const control = createWorkspaceProvisionProviderControl({ getState: () => snapshot,
    saveState(value) { snapshot = structuredClone(value); return snapshot; }, broadcastState() {},
    broker, repoRoot: root, now: () => Date.parse('2026-10-21T12:00:00Z'), idFactory: () => 'space-id' });
  const input = { requestId: 'workspace-one', command: { action: 'workspace_ensure' },
    origin: { roomId: 'room-one', executorMemberId: 'agent-tlo', executorName: 'TLO', agentMessageId: 'msg-one' } };
  return { control, input, broker, created: () => created, snapshot: () => snapshot };
}

test('fresh-room provisioning creates one non-granted EveOS PowerShell workspace and is idempotent', (t) => {
  const f = fixture(t);
  const first = f.control.route(f.input);
  assert.equal(first.ok, true);
  assert.equal(first.data.ready, true);
  assert.equal(first.data.executionAuthority, 'not-granted');
  assert.equal(first.data.publicationAuthority, 'not-granted');
  assert.equal(f.created(), 1);
  const space = f.snapshot().rooms[0].machineSpaces.spaces[0];
  assert.equal(space.grant, null);
  assert.deepEqual(space.fileGrants, []);
  const repeat = f.control.route(f.input);
  assert.equal(repeat.data.idempotent, true);
  assert.equal(f.created(), 1);
  const reuse = f.control.route({ ...f.input, requestId: 'workspace-two',
    origin: { ...f.input.origin, agentMessageId: 'msg-two' } });
  assert.equal(reuse.data.reused, true);
  assert.equal(reuse.data.targetId, first.data.targetId);
  assert.equal(f.created(), 1);
});

test('fresh-room provisioning rejects non-middle agents without mutation', (t) => {
  const f = fixture(t);
  const denied = f.control.route({ ...f.input,
    origin: { ...f.input.origin, executorMemberId: 'agent-other' } });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'MACHINE_WORKSPACE_MIDDLE_AGENT_REQUIRED');
  assert.equal(f.created(), 0);
  assert.equal(f.snapshot().rooms[0].machineSpaces.spaces.length, 0);
});
