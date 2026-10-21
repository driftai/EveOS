'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSupervisedJobCoordinator } = require('../machine-spaces/supervised-job');
const { createSupervisedJobProviderControl } = require('../machine-spaces/supervised-job-provider-control');
const { createLocalPlanController } = require('../machine-spaces/server-controller-local-plans');
const { findSpace } = require('../machine-spaces/server-controller-model');

test('selected middle agent prepares one approval-bound governed publication plan', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-governor-provider-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data', 'runtime', 'smoke-results', 'agent-governor'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'runtime', 'mission.txt'), 'Make one bounded source improvement.');
  fs.writeFileSync(path.join(root, 'tools', 'change.js'), 'module.exports = true;\n');
  fs.writeFileSync(path.join(root, 'docs', 'draft.md'), 'unfinished\n');
  const head = 'a'.repeat(40);
  const target = { id: 'terminal-one', processEpoch: 'epoch-one', type: 'powershell', cwd: root };
  const room = { id: 'room-one', settings: { middleAgentMode: 'manual', middleAgentMemberId: 'agent-tlo' },
    members: [{ id: 'agent-tlo', name: 'TLO', relayEnabled: true, binding: { providerId: 'tlo-chat' } }],
    machineSpaces: { spaces: [{ id: 'space-one', resourceIds: [target.id] }] } };
  const getState = () => ({ rooms: [room] });
  const broker = { target: (id) => id === target.id ? target : null };
  const jobs = createSupervisedJobCoordinator({ now: () => Date.parse('2026-10-21T12:00:00Z'),
    idFactory: () => 'job-id' });
  const commandStore = new Map();
  const plans = createLocalPlanController({ jobs, commandStore, broker, getState, repoRoot: root,
    resolveHead: () => head });
  const control = createSupervisedJobProviderControl({ jobs, commandStore, broker, getState,
    findSpace, repoRoot: root, now: () => Date.parse('2026-10-21T12:00:00Z'),
    prepareGovernor: (input) => plans.prepareProviderGovernor(input) });
  const input = { requestId: 'governor-one', boundRoomId: room.id,
    origin: { roomId: room.id, executorMemberId: 'agent-tlo', executorName: 'TLO', agentMessageId: 'msg-one' },
    command: { action: 'governor_prepare', space: 'space-one', terminal: target.id,
      runId: 'fresh-room-proof', expectedHead: head, tier: 'small', mission: 'data/runtime/mission.txt',
      allowedFiles: ['tools/change.js'], preserveFiles: ['docs/draft.md'], publish: true,
      commitMessage: 'feat(nexus): prove fresh-room publication' } };
  const result = control.route(input);
  assert.equal(result.ok, true);
  assert.equal(result.data.kind, 'governor');
  assert.equal(result.data.workflowEligible, true);
  assert.match(result.data.chatApproval.requiredText, /^\/approve-workflow machine-job-/);
  const stored = commandStore.get(result.data.jobId);
  assert.match(stored.command, /--authorize-publish/);
  assert.equal(stored.governor.publication.commitMessage, 'feat(nexus): prove fresh-room publication');

  const denied = control.route({ ...input, requestId: 'governor-two',
    origin: { ...input.origin, executorMemberId: 'agent-other', agentMessageId: 'msg-two' },
    command: { ...input.command, runId: 'fresh-room-denied' } });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'MACHINE_GOVERNOR_MIDDLE_AGENT_REQUIRED');
});
