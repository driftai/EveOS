'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPostIdleMaintenance, readJournal, writeJournal, TTL_MS } = require('../dex/post-idle-maintenance');
const SHA = '89aed74258145f4375f2aed30d6a6f8d7821dbcf';
const BRANCH = 'codex/nexus-agent-only-mode';
const EVE = { targetClassId: 'online-origin', targetId: 42, providerId: 'chatgpt', url: 'https://chatgpt.com/c/eve' };
const ASTRO = { targetClassId: 'local-origin', targetId: 'local:antigravity-existing:10872', providerId: 'local-antigravity-existing' };
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-post-idle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'journal.json');
  const room = { id: 'room-main', name: 'Eve + Astro', relay: { active: false },
    members: [
      { id: 'eve', binding: { ...EVE } },
      { id: 'astro', binding: { ...ASTRO } }
    ], messages: [] };
  const other = { id: 'room-other', relay: { active: false }, members: [] };
  const state = { rooms: [room, other] };
  let clock = Date.parse('2026-09-25T08:00:00.000Z');
  let pendingControls = false, activeTurn = false, dirty = false, gitHead = SHA;
  const dispatched = [];
  const make = (hooks = {}) => createPostIdleMaintenance({
    filePath, getState: () => state,
    hasPendingControls: () => pendingControls, hasActiveTurn: () => activeTurn,
    getTarget: async () => ({ id: ASTRO.targetId, providerId: ASTRO.providerId, sessionOrigin: 'existing' }),
    getTargetStatus: () => ({ running: true, busy: false }),
    sendPrompt: async (payload) => {
      dispatched.push(payload);
      if (hooks.sendPrompt) return hooks.sendPrompt(payload);
      payload.emit({ type: 'prompt_dispatched' });
      return 0;
    },
    readGit: async () => ({ head: gitHead, branch: BRANCH, dirty }),
    serverSessionId: 'old-session', now: () => clock
  });
  const command = { action: 'arm_post_idle', room: room.id, targetMemberId: 'astro',
    task: 'supervised-revision-deployment', intentId: 'revision37-deployment-once',
    branch: BRANCH, expectedHead: SHA, expectedAdapterRevision: 38 };
  const api = make(overrides);
  return { api, make, state, room, other, filePath, command, dispatched, EVE, ASTRO,
    advance(ms) { clock += ms; },
    setPending(v) { pendingControls = v; }, setTurn(v) { activeTurn = v; },
    setDirty(v) { dirty = v; }, setHead(v) { gitHead = v; },
    arm(commandOverride = command, source = EVE) { return api.arm({ source, command: commandOverride }); },
    status(source = EVE) { return api.status({ source }).data.jobs[0]; }
  };
}
test('only an exact bound browser may arm one fixed task for its exact existing Astro member', (t) => {
  const h = fixture(t);
  assert.equal(h.arm(h.command, { ...EVE, targetId: 999, url: 'https://chatgpt.com/c/other' }).code, 'POST_IDLE_NOT_BOUND');
  assert.equal(h.arm({ ...h.command, task: 'arbitrary-shell' }).code, 'POST_IDLE_BAD_TASK');
  assert.equal(h.arm({ ...h.command, targetMemberId: 'another' }).code, 'POST_IDLE_BAD_TARGET');
  assert.equal(h.arm({ ...h.command, expectedHead: 'invalid' }).code, 'POST_IDLE_BAD_INTENT');
  assert.equal(h.arm({ ...h.command, expectedAdapterRevision: null }).code, 'POST_IDLE_BAD_INTENT');
  const armed = h.arm();
  assert.equal(armed.ok, true);
  assert.equal(armed.data.job.state, 'armed');
  assert.equal(h.arm().data.deduplicated, true);
  assert.equal(h.arm({ ...h.command, intentId: 'completely-new-job-2' }).code, 'POST_IDLE_EXCLUSIVE');
  assert.equal(h.state.rooms[0].messages.length, 0, 'arming adds no relay turn');
});
test('global idle includes every room, pending control receipt, scheduler turn and pending controls', async (t) => {
  const h = fixture(t);
  h.arm();
  h.other.relay.active = true;
  assert.equal(await h.api.tick(), false);
  h.other.relay.active = false; h.other.pendingTurn = { memberId: 'x' };
  assert.equal(await h.api.tick(), false);
  delete h.other.pendingTurn; h.other.recovery = { requestId: 'recover' };
  assert.equal(await h.api.tick(), false);
  delete h.other.recovery; h.room.pendingProviderControlReceipt = { action: 'send' };
  assert.equal(await h.api.tick(), false);
  delete h.room.pendingProviderControlReceipt; h.setPending(true);
  assert.equal(await h.api.tick(), false);
  h.setPending(false); h.setTurn(true);
  assert.equal(await h.api.tick(), false);
  h.setTurn(false);
  assert.equal(await h.api.tick(), true);
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.dispatched[0].targetId, ASTRO.targetId);
  assert.equal(h.status().state, 'awaiting_report');
  assert.equal(h.state.rooms[0].messages.length, 0);
  assert.equal(await h.api.tick(), false, 'one claimed job can never be replayed');
});
test('the durable claim is fsynced before any external prompt and duplicate scans are blocked', async (t) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const h = fixture(t, { sendPrompt: async (task) => {
    const claimed = readJournal(h.filePath).jobs[0];
    assert.equal(claimed.state, 'claimed');
    assert.equal(h.api.leaseActive(), true);
    task.emit({ type: 'prompt_dispatched' });
    await waiting;
  } });
  h.arm();
  const first = h.api.tick(), second = h.api.tick();
  assert.equal(await second, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.api.leaseActive(), true);
  release();
  assert.equal(await first, true);
  assert.equal(h.api.leaseActive(), false);
  assert.equal(h.status().state, 'awaiting_report');
  assert.equal(readJournal(h.filePath).jobs[0].deliveryAcceptedAt != null, true);
});
test('wrong Git head, dirty tree or expired arm fail closed before prompt side effects', async (t) => {
  const h = fixture(t);
  h.arm(); h.setHead('a'.repeat(40));
  assert.equal(await h.api.tick(), false);
  assert.equal(h.status().state, 'blocked');
  assert.equal(h.status().failureCode, 'POST_IDLE_GIT_MISMATCH');
  assert.equal(h.dispatched.length, 0);
  const k = fixture(t); k.arm(); k.setDirty(true);
  assert.equal(await k.api.tick(), false);
  assert.equal(k.dispatched.length, 0);
  const e = fixture(t); e.arm(); e.advance(TTL_MS + 1);
  assert.equal(await e.api.tick(), false);
  assert.equal(e.status().state, 'expired');
  assert.equal(e.dispatched.length, 0);
});
test('original exact local target cannot be silently rebound, and only armed jobs can cancel', async (t) => {
  const h = fixture(t); h.arm();
  h.room.members[1].binding.targetId = 'local:antigravity-existing:123';
  assert.equal(await h.api.tick(), false);
  assert.equal(h.status().failureCode, 'POST_IDLE_TARGET_REBOUND');
  const k = fixture(t); k.arm();
  assert.equal(k.api.cancel({ source: EVE, command: { jobId: k.status().id } }).ok, true);
  assert.equal(await k.api.tick(), false);
  assert.equal(k.api.cancel({ source: EVE, command: { jobId: k.status().id } }).code, 'POST_IDLE_ALREADY_CLAIMED');
});
test('crash after durable claim never replays an uncertain prompt; accepted submission awaits explicit report', async (t) => {
  const h = fixture(t); h.arm();
  let journal = readJournal(h.filePath);
  journal.jobs[0].state = 'claimed'; writeJournal(h.filePath, journal);
  const reboot = h.make();
  assert.equal(reboot.status({ source: EVE }).data.jobs[0].state, 'outcome_unknown');
  assert.equal(await reboot.tick(), false);
  assert.equal(h.dispatched.length, 0);
  journal = readJournal(h.filePath);
  journal.jobs[0].state = 'submitted'; journal.jobs[0].deliveryAcceptedAt = '2026-09-25T08:00:01Z';
  writeJournal(h.filePath, journal);
  const rebootAfterSend = h.make();
  assert.equal(rebootAfterSend.status({ source: EVE }).data.jobs[0].state, 'awaiting_report');
  assert.equal(await rebootAfterSend.tick(), false);
  assert.equal(h.dispatched.length, 0);
});
test('one local-origin report requires concrete evidence, does not notify or auto-ACK, and is deduplicated', async (t) => {
  const h = fixture(t); h.arm(); await h.api.tick();
  const jobId = h.status().id;
  const report = { jobId, result: 'success', summary: 'New child and revision verified.',
    doctorOk: true, globalIdle: true, adapterRevision: 38, newSession: 'new-session' };
  assert.equal(h.api.report({ source: EVE, command: report }).code, 'POST_IDLE_REPORT_UNAUTHORIZED');
  assert.equal(h.api.report({ source: ASTRO, command: { ...report, doctorOk: false } }).code, 'POST_IDLE_INCOMPLETE_EVIDENCE');
  assert.equal(h.api.report({ source: ASTRO, command: { ...report, adapterRevision: 37 } }).code, 'POST_IDLE_INCOMPLETE_EVIDENCE');
  const ok = h.api.report({ source: ASTRO, command: report });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.job.state, 'reported_success');
  assert.equal(ok.data.job.report.evidenceType, 'local-agent-reported');
  assert.equal(h.api.report({ source: ASTRO, command: report }).data.deduplicated, true);
  assert.equal(h.state.rooms[0].messages.length, 0, 'report creates no Dex turn or acknowledgement');
});
