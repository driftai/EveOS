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
  const commandStore = new Map([[queued.jobId, { command: 'broken-command', commandDigest: 'digest', kind: 'terminal' }]]);
  const base = { broker: { target: () => ({ id: 'terminal-one', processEpoch: 'epoch-one' }), activeInfo: () => null,
    runSupervised: async () => ({ state: 'failed', stdout: 'bounded', stderr: 'failure', exitCode: 1, bytes: 14, totalBytes: 14 }) },
    spool: { store: () => ({ outputId: 'output-one' }) }, providerControl: { owns: () => false, route: () => null },
    handle: async () => false, stop() {} };
  const controller = enhanceMachineSpacesSupervisedController(() => base, { uiSockets: new Set([ui]),
    safeSend: () => true, supervisedJobs: jobs, supervisedCommandStore: commandStore,
    onSupervisedJobSettled: (entry) => settled.push(entry) });
  await controller.handle(ui, { type: 'machine_start_supervised_job', jobId: queued.jobId });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled.length, 1); assert.equal(settled[0].state, 'failed');
  assert.equal(settled[0].result.outputId, 'output-one');
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
