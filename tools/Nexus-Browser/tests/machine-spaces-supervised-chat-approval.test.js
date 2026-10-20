'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { commandDigest } = require('../machine-spaces/approval-broker');
const { registeredPlan } = require('../machine-spaces/playwright-job-plan');
const { createChatApproval, publicChatApproval, validateChatApproval } = require('../machine-spaces/supervised-chat-approval');
const { createSupervisedJobCoordinator } = require('../machine-spaces/supervised-job');
const { enhanceMachineSpacesSupervisedController } = require('../machine-spaces/server-controller-supervised');
const { enhanceMachineSpacesHumanGateController } = require('../machine-spaces/server-controller-human-gate');
const chatUi = require('../public/machine-chat-approval-ui');

const ROOT = path.resolve(__dirname, '..', '..', '..');

test('chat approval text is exact, expiring and bound to one registered Playwright job', () => {
  let stamp = 1000;
  const approval = createChatApproval({ jobId: 'machine-job-one', commandDigest: 'abcdef0123456789',
    now: () => stamp, bytes: () => Buffer.from('a1b2c3d4e5f6', 'hex') });
  const job = { jobId: 'machine-job-one', roomId: 'room-one', state: 'queued',
    kind: 'playwright-acceptance', commandDigest: 'abcdef0123456789' };
  const stored = { kind: job.kind, commandDigest: job.commandDigest, chatApproval: approval };
  assert.deepEqual(chatUi.parse(approval.requiredText), {
    approvalText: approval.requiredText, jobId: job.jobId,
    commandDigestPrefix: 'abcdef012345', challenge: 'A1B2C3D4E5F6'
  });
  assert.equal(chatUi.parse('yes'), null);
  const accepted = validateChatApproval({ message: { approvalText: approval.requiredText,
    jobId: job.jobId, roomId: job.roomId, challenge: approval.challenge }, job, stored, now: () => stamp });
  assert.equal(accepted.method, 'dex-owner-chat');
  assert.throws(() => validateChatApproval({ message: { approvalText: approval.requiredText,
    jobId: job.jobId, roomId: job.roomId, challenge: '000000000000' }, job, stored, now: () => stamp }),
  { code: 'MACHINE_PLAYWRIGHT_CHAT_APPROVAL_INVALID' });
  stamp = Date.parse(approval.expiresAt) + 1;
  assert.equal(publicChatApproval(stored, () => stamp).expired, true);
  assert.throws(() => validateChatApproval({ message: { approvalText: approval.requiredText,
    jobId: job.jobId, roomId: job.roomId, challenge: approval.challenge }, job, stored, now: () => stamp }),
  { code: 'MACHINE_PLAYWRIGHT_CHAT_APPROVAL_EXPIRED' });
});

function fixture() {
  const nowValue = Date.parse('2026-10-20T12:00:00.000Z');
  const gate = new EventEmitter(), chat = new EventEmitter(); chat.clientKind = 'machine-chat-approval';
  const outsider = new EventEmitter(); outsider.clientKind = 'machine-chat-approval';
  const uiSockets = new Set([gate, chat]), sent = new Map([[gate, []], [chat, []], [outsider, []]]);
  const jobs = createSupervisedJobCoordinator({ now: () => nowValue,
    idFactory: (() => { let n = 0; return () => `id-${++n}`; })() });
  const target = { id: 'terminal-one', processEpoch: 'epoch-one', type: 'powershell', cwd: ROOT };
  const plan = registeredPlan({ command: { action: 'playwright_prepare', scenario: 'agent-nexus-browser' }, target, repoRoot: ROOT });
  const digest = commandDigest(plan.command);
  const job = jobs.create({ requestId: 'request-one', kind: plan.kind, roomId: 'room-one', spaceId: 'space-one',
    ownerMemberId: 'agent-one', targetId: target.id, processEpoch: target.processEpoch, commandDigest: digest });
  const chatApproval = createChatApproval({ jobId: job.jobId, commandDigest: digest, now: () => nowValue,
    bytes: () => Buffer.from('112233445566', 'hex') });
  const commandStore = new Map([[job.jobId, { ...plan, commandDigest: digest, chatApproval }]]);
  let snapshot = { rooms: [{ id: 'room-one', userName: 'Drift', messages: [],
    machineSpaces: { spaces: [{ id: 'space-one', resourceIds: [target.id] }] } }] };
  let runs = 0;
  const base = { broker: { target: (id) => id === target.id ? target : null, activeInfo: () => null,
      runSupervised() { runs += 1; return new Promise(() => {}); } },
    spool: { store: () => ({ outputId: 'out-one' }) }, providerControl: { owns: () => false, route: () => null },
    async handle() { return false; }, stop() {} };
  const options = { uiSockets, now: () => nowValue, safeSend(ws, payload) { sent.get(ws)?.push(payload); return true; },
    supervisedJobs: jobs, supervisedCommandStore: commandStore, getState: () => snapshot,
    saveState(value) { snapshot = structuredClone(value); return snapshot; }, broadcastState() {}, governorRoot: ROOT };
  const controller = enhanceMachineSpacesHumanGateController(
    shared => enhanceMachineSpacesSupervisedController(() => base, shared), options);
  return { controller, gate, chat, outsider, sent, jobs, job, approval: chatApproval, snapshot: () => snapshot, runs: () => runs };
}

test('local Dex chat approval starts once only after Human Input and records durable provenance', async () => {
  const f = fixture();
  const input = { type: 'machine_chat_approve_supervised_job', requestId: 'approve-one', roomId: 'room-one',
    jobId: f.job.jobId, challenge: f.approval.challenge, approvalText: f.approval.requiredText };
  await f.controller.handle(f.chat, input);
  assert.equal(f.sent.get(f.chat).at(-1).code, 'MACHINE_HUMAN_INPUT_LOCKED');
  assert.equal(f.runs(), 0);
  await f.controller.handle(f.gate, { type: 'machine_set_human_input', enabled: true });
  await f.controller.handle(f.outsider, input);
  assert.equal(f.sent.get(f.outsider).at(-1).code, 'MACHINE_LOCAL_OWNER_REQUIRED');
  await f.controller.handle(f.chat, { ...input, challenge: '000000000000' });
  assert.equal(f.sent.get(f.chat).at(-1).code, 'MACHINE_PLAYWRIGHT_CHAT_APPROVAL_INVALID');
  await f.controller.handle(f.chat, input);
  assert.equal(f.jobs.status(f.job.jobId).state, 'running');
  assert.equal(f.jobs.status(f.job.jobId).authorization.method, 'dex-owner-chat');
  assert.equal(f.runs(), 1);
  assert.deepEqual(f.snapshot().rooms[0].messages.map((entry) => entry.senderKind), ['user', 'system']);
  assert.equal(f.sent.get(f.chat).at(-1).approvalMethod, 'dex-owner-chat');
  await f.controller.handle(f.chat, input);
  assert.equal(f.runs(), 1, 'replayed approval cannot execute twice');
  assert.equal(f.sent.get(f.chat).at(-1).code, 'MACHINE_PLAYWRIGHT_CHAT_NOT_QUEUED');
});
