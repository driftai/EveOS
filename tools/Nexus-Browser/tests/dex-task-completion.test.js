'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskCompletionJournal, credentialPath, resultPath } = require('../dex/task-completion-journal');
const { createTaskCompletionDelivery } = require('../dex/task-completion-delivery');
const { writeJournal } = require('../dex/post-idle-maintenance');
const SHA = 'a'.repeat(40), BRANCH = 'codex/nexus-post-idle-maintenance';
const LOCAL = { targetClassId: 'local-origin', targetId: 'local:antigravity-existing:42',
  providerId: 'local-antigravity-existing' };
const ONLINE = { targetClassId: 'online-origin', targetId: 99,
  providerId: 'chatgpt', url: 'https://chatgpt.com/c/one' };
function fixture(t, { dirty = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-task-completion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 1000000;
  const state = { rooms: [{ id: 'eve-astro', name: 'Eve + Astro', members: [
    { id: 'eve', binding: { ...ONLINE } }, { id: 'astro', binding: { ...LOCAL } }
  ], relay: { active: false } }] };
  const make = () => createTaskCompletionJournal({
    root, getState: () => state, validateLocal: async (source) =>
      source.targetId === LOCAL.targetId && source.providerId === LOCAL.providerId,
    readGit: async () => ({ head: SHA, branch: BRANCH, dirty }),
    now: () => now
  });
  return { root, state, make, clock: (value) => { now = value; } };
}
const command = (taskId = 'batch-revision41-one') => ({
  roomId: 'eve-astro', requesterMemberId: 'eve', taskId, branch: BRANCH, expectedHead: SHA
});
function validResult(root, id, token) {
  writeJournal(resultPath(root, id), {
    version: 1, id, token, expectedHead: SHA, taskId: 'batch-revision41-one',
    result: 'success', summary: 'All qualification gates passed.',
    stageResults: [{ name: 'nexus', exitCode: 0 }, { name: 'guardrails', exitCode: 0 }],
    logs: ['task-completions/logs/' + id + '/01-nexus-browser-test.log']
  });
}
test('local worker registers immutable exact task, signed result is claimed before one provider notification', async (t) => {
  const f = fixture(t), journal = f.make();
  const accepted = await journal.register({ source: LOCAL, command: command() });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.job.state, 'armed');
  assert.equal(accepted.job.requesterMemberId, 'eve');
  assert.equal(accepted.job.workerMemberId, 'astro');
  assert.ok(!JSON.stringify(accepted).includes('token'), 'never expose local capability in browser status');
  const id = accepted.job.id, creds = JSON.parse(fs.readFileSync(credentialPath(f.root, id), 'utf8'));
  assert.equal(creds.expectedHead, SHA);
  const duplicate = await journal.register({ source: LOCAL, command: command() });
  assert.equal(duplicate.ok, true); assert.equal(duplicate.deduplicated, true);
  assert.equal(journal.all().length, 1);
  validResult(f.root, id, creds.token);
  assert.equal(journal.scan(), 1);
  assert.equal(journal.all()[0].state, 'ready');
  assert.equal(fs.existsSync(resultPath(f.root, id)), false, 'signed result is transferred durably');
  const packets = [], socket = { readyState: 1 };
  const delivery = createTaskCompletionDelivery({
    journal, getState: () => f.state, getTabs: () => [{ id: 99, ...ONLINE }],
    getSocket: () => socket, safeSend: (ws, payload) => {
      assert.equal(ws, socket); packets.push(payload); return true;
    }
  });
  assert.equal(delivery.flush().sent, 1);
  assert.equal(journal.all()[0].state, 'sent-unconfirmed');
  assert.equal(packets.length, 1);
  assert.equal(packets[0].source.url, ONLINE.url);
  assert.equal(packets[0].eventId, id);
  assert.match(packets[0].text, /All qualification gates passed/);
  assert.equal(delivery.flush().sent, 0, 'claim forbids repeat submission');
  assert.equal(delivery.handleAck(socket, { type: 'dex_task_completion_ack',
    eventId: id, ok: true }), true);
  assert.equal(journal.all()[0].state, 'confirmed');
  const afterRestart = f.make();
  assert.equal(afterRestart.ready().length, 0);
  assert.equal(afterRestart.all()[0].state, 'confirmed');
});
test('wrong source, missing room, dirty head, and conflicting task id fail closed', async (t) => {
  const f = fixture(t), journal = f.make();
  assert.equal((await journal.register({ source: { ...LOCAL, targetId: 'other' },
    command: command() })).ok, false);
  assert.equal((await journal.register({ source: LOCAL,
    command: { ...command(), roomId: 'missing' } })).ok, false);
  assert.equal((await journal.register({ source: LOCAL, command: command() })).ok, true);
  assert.equal((await journal.register({ source: LOCAL, command: {
    ...command(), expectedHead: 'b'.repeat(40)
  } })).code, 'TASK_COMPLETION_ID_CONFLICT');
  assert.equal(journal.all().length, 1);
  const dirty = fixture(t, { dirty: true }), blocked = dirty.make();
  assert.equal((await blocked.register({ source: LOCAL, command: command() })).code,
    'TASK_COMPLETION_GIT_MISMATCH');
});
test('uncertain browser send and server crash never re-dispatch an already claimed completion', async (t) => {
  const f = fixture(t), journal = f.make();
  const reg = await journal.register({ source: LOCAL, command: command() });
  const creds = JSON.parse(fs.readFileSync(credentialPath(f.root, reg.job.id), 'utf8'));
  validResult(f.root, reg.job.id, creds.token);
  journal.scan();
  const socket = { readyState: 1 };
  const delivery = createTaskCompletionDelivery({
    journal, getState: () => f.state, getTabs: () => [{ id: 99, ...ONLINE }],
    getSocket: () => socket, safeSend: () => true
  });
  assert.equal(delivery.flush().sent, 1);
  const rebooted = f.make();
  assert.equal(rebooted.all()[0].state, 'outcome-unknown');
  assert.equal(rebooted.ready().length, 0);
  assert.equal(rebooted.all()[0].report.result, 'success',
    'the completed task report survives a notification crash');
});
test('invalid report credentials preserve an unknown outcome instead of declaring tests passed', async (t) => {
  const f = fixture(t), journal = f.make();
  const reg = await journal.register({ source: LOCAL, command: command() });
  validResult(f.root, reg.job.id, 'f'.repeat(64));
  assert.equal(journal.scan(), 1);
  assert.equal(journal.all()[0].report.result, 'unknown');
  assert.equal(journal.all()[0].report.code, 'TASK_COMPLETION_INVALID_REPORT');
});
test('active original room and offline exact target retain the report without spending one-shot claim', async (t) => {
  const f = fixture(t), journal = f.make();
  const reg = await journal.register({ source: LOCAL, command: command() });
  const creds = JSON.parse(fs.readFileSync(credentialPath(f.root, reg.job.id), 'utf8'));
  validResult(f.root, reg.job.id, creds.token); journal.scan();
  const socket = { readyState: 1 }, packets = [];
  const delivery = createTaskCompletionDelivery({
    journal, getState: () => f.state, getTabs: () => [],
    getSocket: () => socket, safeSend: (_, packet) => { packets.push(packet); return true; }
  });
  assert.equal(delivery.flush().sent, 0);
  f.state.rooms[0].relay.active = true;
  assert.equal(delivery.flush().sent, 0);
  f.state.rooms[0].relay.active = false;
  assert.equal(journal.all()[0].state, 'ready');
  assert.equal(packets.length, 0);
});

test('registered external signal accepts only matching signed completion without launching a process', async (t) => {
  const f = fixture(t), journal = f.make();
  const external = { ...command('external-task-one'), jobType: 'external-signal' };
  const registered = await journal.register({ source: LOCAL, command: external });
  assert.equal(registered.ok, true);
  assert.equal(registered.job.jobType, 'external-signal');
  assert.equal((await journal.register({ source: LOCAL, command: external })).deduplicated, true);
  assert.equal((await journal.register({ source: LOCAL, command: command('external-task-one') })).code,
    'TASK_COMPLETION_ID_CONFLICT');
  assert.equal((await journal.register({ source: LOCAL,
    command: { ...command('untrusted-type'), jobType: 'shell' } })).code, 'TASK_COMPLETION_BAD_TYPE');
  assert.equal(journal.all()[0].state, 'armed', 'registration never launches an arbitrary local job');
  const creds = JSON.parse(fs.readFileSync(credentialPath(f.root, registered.job.id), 'utf8'));
  assert.equal(creds.jobType, 'external-signal');
  writeJournal(resultPath(f.root, registered.job.id), {
    version: 1, id: registered.job.id, taskId: external.taskId, jobType: external.jobType,
    expectedHead: SHA, token: creds.token, result: 'success', summary: 'Authorized local signal completed.',
    stageResults: []
  });
  assert.equal(journal.scan(), 1);
  assert.equal(journal.all()[0].state, 'ready');
  assert.equal(journal.all()[0].report.result, 'success');
  assert.equal(f.make().all()[0].jobType, 'external-signal');
});
test('external signal rejects a legacy qualification payload even with a valid local token', async (t) => {
  const f = fixture(t), journal = f.make();
  const external = { ...command('external-task-two'), jobType: 'external-signal' };
  const registered = await journal.register({ source: LOCAL, command: external });
  const creds = JSON.parse(fs.readFileSync(credentialPath(f.root, registered.job.id), 'utf8'));
  writeJournal(resultPath(f.root, registered.job.id), {
    version: 1, id: registered.job.id, taskId: external.taskId,
    expectedHead: SHA, token: creds.token, result: 'success', summary: 'Wrong signed job type.'
  });
  assert.equal(journal.scan(), 1);
  assert.equal(journal.all()[0].report.result, 'unknown');
  assert.equal(journal.all()[0].report.code, 'TASK_COMPLETION_INVALID_REPORT');
});
