'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngineeringIncidentBridge, middleAgentFor } = require('../dex/engineering-incident');
const { createDexServerScheduler } = require('../dex/server-scheduler');
const { mergeClientSnapshot } = require('../dex/server-state-merge');
const { projection } = require('../dex/terminal-operator');
const { formatJobs } = require('../scripts/dex-room-tui');
const { createSupervisedJobCoordinator } = require('../machine-spaces/supervised-job');
const { enhanceMachineSpacesSupervisedController } = require('../machine-spaces/server-controller-supervised');
const { SCHEMA, validateEngineeringProposal } = require('../dex/engineering-proposal');
const { createEngineeringCycle } = require('../dex/engineering-cycle');
const { validateEngineeringCompletion } = require('../dex/engineering-completion');
const { commandDigest } = require('../machine-spaces/approval-broker');
const { createWorkflowAuthorization, validateInheritedRecovery } = require('../machine-spaces/engineering-workflow-authorization');

function store(seed) {
  let value = structuredClone(seed);
  return { load: () => structuredClone(value), save: (next) => (value = structuredClone(next)), value: () => structuredClone(value) };
}
function room(members, settings = {}) {
  return { version: 1, activeRoomId: 'room-one', rooms: [{ id: 'room-one', name: 'Engineering', settings,
    members, messages: [], relay: { active: false, remaining: 0, waitingFor: null, lastStopReason: 'Idle' } }] };
}
const member = (id, providerId = 'tlo-chat') => ({ id, name: id, relayEnabled: true,
  binding: { targetClassId: 'local-origin', providerId, targetId: `local:${id}` } });
const job = (state = 'failed') => ({ jobId: 'machine-job-one', requestId: 'request-one', state,
  roomId: 'room-one', spaceId: 'space-one', targetId: 'terminal-one', processEpoch: 'epoch-one',
  finishedAt: '2026-10-19T20:00:00.000Z', errorCode: state === 'failed' ? 'TEST_ASSERTION_FAILED' : null,
  reason: state === 'failed' ? 'assertion mismatch' : null, result: { outputId: 'output-one', exitCode: state === 'completed' ? 0 : 1 } });

test('confirmed failure is recorded once and schedules the selected provider-agnostic middle agent', () => {
  const state = store(room([member('tlo'), member('claude', 'claude')], { middleAgentMode: 'manual', middleAgentMemberId: 'tlo' }));
  const calls = [], bridge = createEngineeringIncidentBridge({ load: state.load, save: state.save,
    scheduler: { startMemberTurn(input) { calls.push(input); return { ok: true }; } }, uid: () => 'one' });
  const first = bridge.handle(job()), second = bridge.handle(job());
  assert.equal(first.dispatch.ok, true); assert.equal(second.deduplicated, true); assert.equal(calls.length, 1);
  assert.equal(calls[0].memberId, 'tlo');
  const saved = state.value().rooms[0];
  assert.equal(saved.engineeringIncidentReceipts.length, 1);
  assert.match(saved.messages[0].text, /outputReceipt=output-one/);
  assert.doesNotMatch(saved.messages[0].text, /raw stdout|secret/i);
});

test('automatic slot accepts any sole eligible provider and uncertain work safe-stops without dispatch', () => {
  assert.equal(middleAgentFor(room([member('claude', 'claude')]).rooms[0]).id, 'claude');
  const state = store(room([member('claude', 'claude')])), calls = [];
  const bridge = createEngineeringIncidentBridge({ load: state.load, save: state.save,
    scheduler: { startMemberTurn(input) { calls.push(input); return { ok: true }; } } });
  bridge.handle(job('outcome-unknown'));
  assert.equal(calls.length, 0);
  assert.match(state.value().rooms[0].messages[0].text, /Do not replay/);
});

test('completed work records GREEN evidence without invoking an agent', () => {
  const state = store(room([member('tlo')])), calls = [];
  const bridge = createEngineeringIncidentBridge({ load: state.load, save: state.save,
    scheduler: { startMemberTurn(input) { calls.push(input); return { ok: true }; } } });
  bridge.handle(job('completed'));
  assert.equal(calls.length, 0);
  assert.equal(state.value().rooms[0].engineeringIncidentReceipts[0].dispatch, 'not-required');
});

test('completed recovery dispatches one receipt-bound verification turn', () => {
  const state = store(room([member('tlo')])), calls = [];
  const bridge = createEngineeringIncidentBridge({ load: state.load, save: state.save,
    scheduler: { startMemberTurn(input) { calls.push(input); return { ok: true }; } }, uid: () => 'verified' });
  const result = bridge.handle({ ...job('completed'), kind: 'recovery',
    result: { outputId: 'output-green', exitCode: 0, recovery: { outcome: 'GREEN',
      receipt: 'data/runtime/smoke-results/tlo-autorecover-proof/receipt.json' } } });
  assert.equal(result.dispatch.ok, true); assert.equal(calls.length, 1);
  assert.equal(calls[0].purpose, 'engineering-verification');
  const message = state.value().rooms[0].messages[0];
  assert.equal(message.engineeringVerification.outputId, 'output-green');
  assert.match(message.text, /Nexus will reject DONE/);
});

test('exhausted recovery defers to the local owner without another agent loop', () => {
  const state = store(room([member('tlo')])), calls = [];
  const bridge = createEngineeringIncidentBridge({ load: state.load, save: state.save,
    scheduler: { startMemberTurn(input) { calls.push(input); return { ok: true }; } } });
  const result = bridge.handle({ ...job('failed'), kind: 'recovery' });
  assert.equal(calls.length, 0);
  assert.equal(result.receipt.dispatch, 'owner-required');
  assert.equal(result.dispatch.code, 'ENGINEERING_RECOVERY_EXHAUSTED');
  assert.match(state.value().rooms[0].messages[0].text, /local owner action is required/i);
});

test('existing scheduler targets the exact member instead of round-robin selection', async () => {
  const state = store(room([member('eve'), member('tlo')], { middleAgentMemberId: 'tlo' }));
  const snapshot = state.load(); snapshot.rooms[0].messages.push({ id: 'incident-one', senderKind: 'system', senderName: 'Machine Spaces', text: 'failure',
    engineeringIncident: { schema: 'eveos.machine-spaces.engineering-incident.v1', jobId: 'job-one' } }); state.save(snapshot);
  const prompts = [], timers = [];
  const scheduler = createDexServerScheduler({ stateStore: state, durability: { beforeDispatch: async () => ({ ok: true }), query: () => ({ reliable: true }) },
    getLocalTargets: async () => [{ id: 'local:tlo', providerId: 'tlo-chat', targetClassId: 'local-origin' }],
    sendLocalPrompt: async (input) => { prompts.push(input); }, setTimer(fn) { timers.push(fn); return timers.length; }, clearTimer() {} });
  assert.equal(scheduler.startMemberTurn({ roomId: 'room-one', sourceMessageId: 'incident-one', memberId: 'tlo' }).ok, true);
  await timers.shift()();
  assert.equal(scheduler.diagnostics().current.memberId, 'tlo');
  assert.equal(prompts.length, 1);
  const requestId = scheduler.diagnostics().current.requestId;
  await scheduler.handleTransportEvent({ type: 'response_final', requestId, text: JSON.stringify({ schema: SCHEMA,
    incidentJobId: 'job-one', classification: 'test-failure', summary: 'A bounded diagnosis.', confidence: 0.8,
    requestedEvidence: [], repair: { kind: 'none', paths: [], description: 'No automatic mutation.' }, retryIntent: 'none' }) });
  const reply = state.value().rooms[0].messages.at(-1);
  assert.equal(reply.engineeringProposal.ok, true);
  assert.match(reply.engineeringRawText, /engineering-proposal/);
  assert.equal(state.value().rooms[0].pendingProviderControlReceipt, undefined);
});

test('incident receipts survive stale viewer saves and appear in the room TUI', () => {
  const server = room([member('tlo')]);
  server.rooms[0].engineeringIncidentReceipts = [{ jobId: 'machine-job-one', requestId: 'request-one',
    state: 'failed', classification: 'confirmed-command-or-test-failure', middleAgentMemberId: 'tlo',
    dispatch: 'scheduled', createdAt: '2026-10-19T20:00:00.000Z' }];
  const client = room([member('tlo')]);
  const merged = mergeClientSnapshot(server, client);
  assert.equal(merged.rooms[0].engineeringIncidentReceipts.length, 1);
  const view = { ok: true, ...projection(merged.rooms[0]) };
  assert.match(formatJobs(view), /machine-job-one/);
  assert.match(formatJobs(view), /middle=tlo/);
});

test('the supervised controller emits the authoritative settled job to the room bridge', async () => {
  const ui = {}, settled = [], jobs = createSupervisedJobCoordinator({ idFactory: () => 'one' });
  const queued = jobs.create({ requestId: 'request-one', roomId: 'room-one', spaceId: 'space-one',
    ownerMemberId: 'local', targetId: 'terminal-one', processEpoch: 'epoch-one', commandDigest: 'digest' });
  const commandStore = new Map([[queued.jobId, { command: 'broken-command', commandDigest: 'digest', kind: 'terminal',
    governor: { runId: 'run-published' } }]]);
  const base = { broker: { target: () => ({ id: 'terminal-one', processEpoch: 'epoch-one' }), activeInfo: () => null,
    runSupervised: async () => ({ state: 'completed', stdout: 'bounded', stderr: '', exitCode: 0, bytes: 7, totalBytes: 7 }) },
    spool: { store: () => ({ outputId: 'output-one' }) }, providerControl: { owns: () => false, route: () => null },
    handle: async () => false, stop() {} };
  const controller = enhanceMachineSpacesSupervisedController(() => base, { uiSockets: new Set([ui]),
    safeSend: () => true, supervisedJobs: jobs, supervisedCommandStore: commandStore,
    governorReceiptReader: () => ({ runs: [{ runId: 'run-published', state: 'PUBLISHED', published: 'a'.repeat(40) }] }),
    onSupervisedJobSettled: (entry) => settled.push(entry) });
  await controller.handle(ui, { type: 'machine_start_supervised_job', jobId: queued.jobId });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled.length, 1); assert.equal(settled[0].state, 'completed');
  assert.equal(settled[0].result.outputId, 'output-one');
  assert.equal(settled[0].result.publicationSha, 'a'.repeat(40));
});

test('engineering responses require a versioned bounded proposal and traversal-free paths', () => {
  const valid = validateEngineeringProposal(JSON.stringify({ schema: SCHEMA, incidentJobId: 'job-one',
    classification: 'test-failure', summary: 'The assertion is stale.', confidence: 0.9,
    requestedEvidence: ['failing assertion'], repair: { kind: 'source-patch', paths: ['tools/safe.js'], description: 'Update the assertion.' },
    retryIntent: 'after-verified-repair' }), { jobId: 'job-one' });
  assert.equal(valid.ok, true);
  assert.equal(validateEngineeringProposal('{broken', { jobId: 'job-one' }).ok, false);
  const escape = { ...valid, schema: SCHEMA, repair: { kind: 'source-patch', paths: ['../secret'], description: 'bad' } };
  delete escape.ok;
  assert.equal(validateEngineeringProposal(JSON.stringify(escape), { jobId: 'job-one' }).code, 'ENGINEERING_PROPOSAL_PATH_INVALID');
});

test('failure incident gives the middle agent an exact versioned JSON template and closed enums', () => {
  const { incidentText } = require('../dex/engineering-incident');
  const text = incidentText(job('failed'), 'confirmed-command-or-test-failure');
  assert.match(text, /reply with exactly one JSON object \(no prose or fence\)/);
  assert.match(text, /"schema":"eveos\.machine-spaces\.engineering-proposal\.v1"/);
  assert.match(text, /"incidentJobId":"machine-job-one"/);
  assert.match(text, /Allowed repair\.kind: none, prepare-command, source-patch, await-approval/);
  assert.match(text, /Allowed retryIntent: none, after-verified-repair, requires-approval/);
});

test('verified completion requires DONE bound to exact server receipts', () => {
  const verification = { schema: 'eveos.machine-spaces.engineering-verification.v1',
    jobId: 'machine-job-green', state: 'completed', exitCode: 0, outputId: 'output-green',
    outcome: 'GREEN', receipt: 'data/runtime/smoke-results/tlo-autorecover-proof/receipt.json' };
  assert.equal(validateEngineeringCompletion('GREEN [[DEX:DONE]]', verification, true).ok, false);
  const text = `GREEN job=machine-job-green output=output-green receipt=${verification.receipt} [[DEX:DONE]]`;
  assert.equal(validateEngineeringCompletion(text, verification, true).ok, true);
  assert.equal(validateEngineeringCompletion(text, { ...verification, exitCode: 1 }, true).ok, false);
});

test('validated proposal prepares one inert scoped recovery job through the existing owner', () => {
  const state = store(room([member('tlo')])), prepared = [], incidents = [];
  const proposalMessage = { id: 'proposal-one', senderKind: 'agent', senderName: 'TLO',
    engineeringProposal: { ok: true, incidentJobId: 'machine-job-failed', retryIntent: 'after-verified-repair',
      repair: { kind: 'source-patch', paths: ['tools/fixture.js'] } } };
  const seeded = state.load(); seeded.rooms[0].messages.push(proposalMessage); state.save(seeded);
  const cycle = createEngineeringCycle({ load: state.load, save: state.save, repoRoot: process.cwd(),
    resolveHead: () => 'a'.repeat(40), broadcastState() {},
    incidentBridge: { handle(input) { incidents.push(input); return { ok: true }; } },
    machineSpaces: { prepareEngineeringRecovery(input) { prepared.push(input); return { jobId: 'machine-job-recovery' }; } } });
  cycle.onJobSettled({ ...job('failed'), jobId: 'machine-job-failed' }, {
    command: 'node tools/fixture.js', retrySafety: 'idempotent', repairFiles: ['tools/fixture.js'],
    contextFiles: ['tools/fixture.js'], invariants: ['preserve the passing branch'] });
  assert.equal(cycle.reconcile().changed, true); assert.equal(prepared.length, 1);
  assert.equal(prepared[0].incidentJobId, 'machine-job-failed');
  assert.equal(prepared[0].visibleTerminal, true); assert.equal(incidents.length, 1);
  const receipt = state.value().rooms[0].engineeringCycleReceipts[0];
  assert.equal(receipt.state, 'approval-pending'); assert.equal(receipt.recoveryJobId, 'machine-job-recovery');
  assert.equal(cycle.reconcile().changed, false); assert.equal(prepared.length, 1);
});

test('one exact owner workflow approval inherits into one bounded matching recovery', () => {
  const head = 'a'.repeat(40), original = 'node tools/fixture.js';
  const incident = { ...job('failed'), kind: 'terminal-supervised', commandDigest: commandDigest(original) };
  const initialStored = { command: original, retrySafety: 'idempotent', repairFiles: ['tools/fixture.js'],
    contextFiles: ['tools/fixture.js'], invariants: ['preserve the passing branch'] };
  const authorization = createWorkflowAuthorization({ job: incident, stored: initialStored,
    expectedHead: head, now: () => 1000 });
  incident.authorization = { sourceMessageId: 'owner-approval', workflow: authorization };
  const recoveryJob = { ...incident, jobId: 'machine-job-recovery', kind: 'recovery', state: 'queued' };
  const recoveryStored = { kind: 'recovery', displayCommand: original, recovery: {
    incidentJobId: incident.jobId, expectedHead: head, retrySafety: 'idempotent', maxAttempts: 1,
    repairFiles: ['tools/fixture.js'], contextFiles: ['tools/fixture.js'], invariants: ['preserve the passing branch'] } };
  const inherited = validateInheritedRecovery({ authorization, incidentJob: incident,
    recoveryJob, stored: recoveryStored, currentHead: head, now: () => 2000 });
  assert.equal(inherited.method, 'inherited-owner-workflow');
  assert.throws(() => validateInheritedRecovery({ authorization, incidentJob: incident,
    recoveryJob: { ...recoveryJob, targetId: 'other-terminal' }, stored: recoveryStored,
    currentHead: head, now: () => 2000 }), { code: 'MACHINE_WORKFLOW_TARGET_CHANGED' });
  assert.throws(() => validateInheritedRecovery({ authorization, incidentJob: incident,
    recoveryJob, stored: { ...recoveryStored, recovery: { ...recoveryStored.recovery,
      repairFiles: ['README.md'] } }, currentHead: head, now: () => 2000 }),
  { code: 'MACHINE_WORKFLOW_SCOPE_CHANGED' });
});

test('approved engineering cycle auto-starts matching recovery without a second owner prompt', () => {
  const state = store(room([member('tlo')])), prepared = [], started = [];
  const seeded = state.load(); seeded.rooms[0].messages.push({ id: 'proposal-workflow', senderKind: 'agent',
    engineeringProposal: { ok: true, incidentJobId: 'machine-job-failed', retryIntent: 'after-verified-repair',
      repair: { kind: 'source-patch', paths: ['tools/fixture.js'] } } }); state.save(seeded);
  const workflowAuthorization = { schema: 'eveos.machine-spaces.engineering-workflow-authorization.v1' };
  const cycle = createEngineeringCycle({ load: state.load, save: state.save, repoRoot: process.cwd(),
    resolveHead: () => 'a'.repeat(40), broadcastState() {}, incidentBridge: { handle() { return { ok: true }; } },
    machineSpaces: {
      prepareEngineeringRecovery(input) { prepared.push(input); return { jobId: 'machine-job-recovery' }; },
      startEngineeringRecovery(jobId, input) { started.push({ jobId, input }); return { state: 'running' }; }
    } });
  cycle.onJobSettled({ ...job('failed'), jobId: 'machine-job-failed', authorization: { workflow: workflowAuthorization } }, {
    command: 'node tools/fixture.js', retrySafety: 'idempotent', repairFiles: ['tools/fixture.js'],
    contextFiles: ['tools/fixture.js'], invariants: [] });
  assert.equal(cycle.reconcile().changed, true);
  assert.equal(prepared.length, 1); assert.equal(started.length, 1);
  assert.equal(started[0].input.authorization, workflowAuthorization);
  assert.equal(state.value().rooms[0].engineeringCycleReceipts[0].state, 'running');
});

test('scheduler rejects engineering DONE that is not bound to the authoritative receipt', async () => {
  const state = store(room([member('tlo')]));
  const seeded = state.load();
  seeded.rooms[0].messages.push({ id: 'verification-one', senderKind: 'system', senderName: 'Machine Spaces',
    text: 'verified recovery', engineeringVerification: {
      schema: 'eveos.machine-spaces.engineering-verification.v1', jobId: 'machine-job-green',
      state: 'completed', exitCode: 0, outputId: 'output-green', outcome: 'GREEN',
      receipt: 'data/runtime/smoke-results/tlo-autorecover-proof/receipt.json'
    } });
  state.save(seeded);
  const timers = [], scheduler = createDexServerScheduler({ stateStore: state,
    durability: { beforeDispatch: async () => ({ ok: true }), query: () => ({ reliable: true }) },
    getLocalTargets: async () => [{ id: 'local:tlo', providerId: 'tlo-chat', targetClassId: 'local-origin' }],
    sendLocalPrompt: async () => {}, setTimer(fn) { timers.push(fn); return timers.length; }, clearTimer() {} });
  assert.equal(scheduler.startMemberTurn({ roomId: 'room-one', sourceMessageId: 'verification-one', memberId: 'tlo' }).ok, true);
  await timers.shift()();
  const requestId = scheduler.diagnostics().current.requestId;
  await scheduler.handleTransportEvent({ type: 'response_final', requestId, text: 'GREEN [[DEX:DONE]]' });
  const saved = state.value().rooms[0], reply = saved.messages.at(-1);
  assert.equal(reply.engineeringCompletion.ok, false);
  assert.match(saved.relay.lastStopReason, /Engineering completion rejected/);
});
