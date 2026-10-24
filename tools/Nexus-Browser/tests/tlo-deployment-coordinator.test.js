'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const subject = require('../dex/tlo-deployment-coordinator');

const secret = 'deployment-test-secret-0000000000000000000001';
const head = 'b'.repeat(40), source = 'c'.repeat(64), webSource = 'd'.repeat(64);
function base(root) {
  return { branch: 'eve/nexus-machine-spaces', head, remoteHead: head, clean: true,
    sourceFingerprint: source, sourceLoaded: false,
    serverSessionId: 'nexus-session-before', serverPid: 101, supervisorPid: 100,
    dexRooms: 14, roomIdentityDigest: 'e'.repeat(64),
    pending: { providerControls: 0, targetOperations: 0, controlReceipts: 0,
      recoveryRooms: 0, pendingRooms: 0, queuedIncoming: 0, activeTurn: 0 },
    control: { running: true, identityVerified: true, pid: 90,
      instanceId: 'control-instance-before', sourceFingerprint: '2'.repeat(64) },
    web: { running: true, identityVerified: true, instanceId: 'web-instance-before',
      sourceFingerprint: webSource, pids: [201], port: 8765, modularRoot: root },
    nexus: { owned: true, supervisorPid: 100, pids: [101] },
    durableTloDormancy: { proven: true, state: 'uninitialized', digest: '3'.repeat(64) },
    tlo: { source: { fingerprint: 'f'.repeat(64) }, deployment: { state: 'disabled' },
      uncertain: false, handoff: null } };
}
function afterWeb(before) {
  return { ...structuredClone(before), web: { ...before.web, instanceId: 'web-instance-after',
    sourceFingerprint: 'a'.repeat(64), pids: [202] } };
}
function finalState(web) {
  return { ...structuredClone(web), sourceLoaded: true,
    serverSessionId: 'nexus-session-after', serverPid: 301, supervisorPid: 300,
    nexus: { owned: true, supervisorPid: 300, pids: [301] },
    tlo: { ...web.tlo, source: { fingerprint: source } } };
}
function fixture({ mutate = null, restart = null, now = () => 1000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlo-deployment-'));
  const journalPath = path.join(root, 'journal.json'), lockPath = path.join(root, 'journal.lock');
  const initial = base(root), web = afterWeb(initial), final = finalState(web);
  const states = [initial, web, final].map((value) => structuredClone(value));
  if (mutate) mutate(states);
  let reads = 0, hits = [];
  const coordinator = subject.createDeploymentCoordinator({ journalPath, lockPath,
    readSecret: () => secret, now,
    observe: async () => structuredClone(states[Math.min(reads++, states.length - 1)]),
    restartService: async (service) => {
      hits.push(service);
      if (restart) return restart(service, { journalPath, hits });
      if (service === 'web') return { ok: true, serviceRestarted: true,
        expectedSourceFingerprint: 'a'.repeat(64), spotify: { restored: { ok: true } } };
      return { ok: true, serviceRestarted: true };
    } });
  const intent = subject.signDeploymentIntent(secret, initial, 'deployment-request-1000', 1000);
  return { root, journalPath, lockPath, states, coordinator, intent,
    get reads() { return reads; }, get hits() { return hits; } };
}

test('two-service deployment journals before web and Nexus side effects', async () => {
  const f = fixture({ restart(service, state) {
    const record = subject.readJournal(state.journalPath).records[0];
    assert.equal(record.stage, service === 'web' ? 'web-restart-pending' : 'nexus-restart-pending');
    return service === 'web' ? { ok: true, serviceRestarted: true,
      expectedSourceFingerprint: 'a'.repeat(64), spotify: { restored: { ok: true } } }
      : { ok: true, serviceRestarted: true };
  } });
  const result = await f.coordinator.execute(f.intent);
  assert.equal(result.ok, true); assert.deepEqual(f.hits, ['web', 'nexusBrowser']);
  assert.equal(subject.readJournal(f.journalPath).records[0].state, 'succeeded');
  const replay = await f.coordinator.execute(f.intent);
  assert.equal(replay.deduplicated, true); assert.deepEqual(f.hits, ['web', 'nexusBrowser']);
});

test('qualified revision is one-shot across different request IDs', async () => {
  const f = fixture();
  await f.coordinator.execute(f.intent);
  const other = subject.signDeploymentIntent(secret, f.states[0], 'deployment-request-2000', 1000);
  await assert.rejects(f.coordinator.execute(other), { code: 'TLO_DEPLOYMENT_ALREADY_SUCCEEDED' });
  assert.deepEqual(f.hits, ['web', 'nexusBrowser']);
});

test('successful deduplication remains bound to the exact signed intent', async () => {
  const f = fixture();
  await f.coordinator.execute(f.intent);
  const changed = { ...f.states[0], head: '9'.repeat(40), remoteHead: '9'.repeat(40) };
  const conflict = subject.signDeploymentIntent(secret, changed, f.intent.requestId, 1000);
  await assert.rejects(f.coordinator.execute(conflict), { code: 'TLO_DEPLOYMENT_REQUEST_CONFLICT' });
  assert.deepEqual(f.hits, ['web', 'nexusBrowser']);
});

test('exact completed intent remains safely deduplicated after authorization expiry', async () => {
  let clock = 1000;
  const f = fixture({ now: () => clock });
  await f.coordinator.execute(f.intent);
  clock = subject.MAX_AUTH_AGE_MS + 2000;
  const replay = await f.coordinator.execute(f.intent);
  assert.equal(replay.deduplicated, true); assert.deepEqual(f.hits, ['web', 'nexusBrowser']);
  const expiredNew = subject.signDeploymentIntent(secret, f.states[0], 'deployment-request-3000', 1000);
  await assert.rejects(f.coordinator.execute(expiredNew), { code: 'TLO_DEPLOYMENT_AUTH_INVALID' });
  assert.deepEqual(f.hits, ['web', 'nexusBrowser']);
});

test('stale source or process identity blocks before lifecycle mutation', async () => {
  for (const mutate of [states => { states[0].head = '9'.repeat(40); },
    states => { states[0].nexus.owned = false; },
    states => { states[0].web.instanceId = 'web-instance-changed'; }]) {
    const f = fixture({ mutate });
    await assert.rejects(f.coordinator.execute(f.intent), { code: 'TLO_DEPLOYMENT_PREFLIGHT_CHANGED' });
    assert.deepEqual(f.hits, []);
    assert.equal(subject.readJournal(f.journalPath).records[0].state, 'blocked');
  }
});

test('partial web restart becomes uncertain and cannot replay', async () => {
  const f = fixture({ restart: () => ({ ok: false, serviceRestarted: false }) });
  await assert.rejects(f.coordinator.execute(f.intent), { code: 'TLO_DEPLOYMENT_WEB_RESTART_FAILED' });
  assert.deepEqual(f.hits, ['web']);
  assert.equal(subject.readJournal(f.journalPath).records[0].state, 'uncertain');
  await assert.rejects(f.coordinator.execute(f.intent), { code: 'TLO_DEPLOYMENT_OUTCOME_UNCERTAIN' });
  assert.deepEqual(f.hits, ['web']);
});

test('Nexus failure after verified web replacement stays uncertain', async () => {
  const f = fixture({ restart(service) {
    return service === 'web' ? { ok: true, serviceRestarted: true,
      expectedSourceFingerprint: 'a'.repeat(64), spotify: { restored: { ok: true } } }
      : { ok: false, serviceRestarted: false };
  } });
  await assert.rejects(f.coordinator.execute(f.intent), { code: 'TLO_DEPLOYMENT_NEXUS_RESTART_FAILED' });
  assert.deepEqual(f.hits, ['web', 'nexusBrowser']);
  assert.equal(subject.readJournal(f.journalPath).records[0].state, 'uncertain');
});

test('room identity change after replacement is rejected', async () => {
  const f = fixture({ mutate: states => { states[2].roomIdentityDigest = '1'.repeat(64); } });
  await assert.rejects(f.coordinator.execute(f.intent), { code: 'TLO_DEPLOYMENT_NEXUS_VERIFY_FAILED' });
  assert.equal(subject.readJournal(f.journalPath).records[0].state, 'uncertain');
});

test('separate-process owner serializes journal read and recovery', async () => {
  const locked = fixture();
  const script = "const fs=require('node:fs');const f=process.argv[1];const h=fs.openSync(f,'wx');"
    + "process.stdout.write('READY\\n');setTimeout(()=>{fs.closeSync(h);fs.unlinkSync(f)},750)";
  const child = spawn(process.execPath, ['-e', script, locked.lockPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(child.stdout, 'data');
  await assert.rejects(locked.coordinator.execute(locked.intent), { code: 'TLO_DEPLOYMENT_CONCURRENT' });
  assert.deepEqual(locked.hits, []);
  await once(child, 'exit');
  const result = await locked.coordinator.execute(locked.intent);
  assert.equal(result.ok, true); assert.deepEqual(locked.hits, ['web', 'nexusBrowser']);
});

test('crash-recovery journal fails closed', async () => {
  const crashed = fixture();
  const pending = subject.sealRecord(secret, { schema: subject.RECORD_SCHEMA,
    requestId: 'old-deployment-request', intentDigest: '4'.repeat(64), expectedHead: head,
    sourceFingerprint: source, initialServerSessionId: 'nexus-session-before',
    replacementServerSessionId: null, state: 'pending', stage: 'web-restart-pending',
    startedAt: new Date(1000).toISOString(), finishedAt: null, code: null,
    webInstanceId: null, sideEffectsStarted: false, integrity: '0'.repeat(64) });
  fs.writeFileSync(crashed.journalPath, JSON.stringify({ schema: subject.JOURNAL_SCHEMA,
    records: [pending] }));
  await assert.rejects(crashed.coordinator.execute(crashed.intent), { code: 'TLO_DEPLOYMENT_OUTCOME_UNCERTAIN' });
  assert.deepEqual(crashed.hits, []);
});

test('malformed or tampered success journal is never accepted as deduplication', async () => {
  const malformed = fixture();
  fs.writeFileSync(malformed.journalPath, JSON.stringify({ schema: subject.JOURNAL_SCHEMA,
    records: [{ requestId: malformed.intent.requestId, state: 'succeeded', stage: 'complete' }] }));
  await assert.rejects(malformed.coordinator.execute(malformed.intent), { code: 'TLO_DEPLOYMENT_JOURNAL_INVALID' });
  assert.deepEqual(malformed.hits, []);
  const tampered = fixture();
  const record = subject.sealRecord(secret, { schema: subject.RECORD_SCHEMA,
    requestId: tampered.intent.requestId, intentDigest: subject.intentDigest(tampered.intent),
    expectedHead: head, sourceFingerprint: source, initialServerSessionId: 'nexus-session-before',
    replacementServerSessionId: 'nexus-session-after', state: 'succeeded', stage: 'complete',
    startedAt: new Date(1000).toISOString(), finishedAt: new Date(1000).toISOString(), code: null,
    webInstanceId: 'web-instance-after', sideEffectsStarted: true, integrity: '0'.repeat(64) });
  record.expectedHead = '9'.repeat(40);
  fs.writeFileSync(tampered.journalPath, JSON.stringify({ schema: subject.JOURNAL_SCHEMA, records: [record] }));
  await assert.rejects(tampered.coordinator.execute(tampered.intent), { code: 'TLO_DEPLOYMENT_JOURNAL_INVALID' });
  assert.deepEqual(tampered.hits, []);
});

test('legacy null deployment needs durable dormancy and final loaded source reports disabled', async () => {
  const accepted = fixture({ mutate: states => {
    states[0].tlo.deployment = null; states[1].tlo.deployment = null;
  } });
  assert.equal((await accepted.coordinator.execute(accepted.intent)).ok, true);
  const unsafe = fixture({ mutate: states => {
    states[0].tlo.deployment = null; states[0].durableTloDormancy.proven = false;
  } });
  await assert.rejects(unsafe.coordinator.execute(unsafe.intent), { code: 'TLO_DEPLOYMENT_PREFLIGHT_CHANGED' });
  assert.deepEqual(unsafe.hits, []);
});

test('tampered or expired deployment authorization is rejected', async () => {
  const f = fixture();
  assert.throws(() => subject.verifyDeploymentIntent(secret,
    { ...f.intent, webPort: 9999 }, 1000), { code: 'TLO_DEPLOYMENT_AUTH_INVALID' });
  assert.throws(() => subject.verifyDeploymentIntent(secret, f.intent,
    subject.MAX_AUTH_AGE_MS + 1001), { code: 'TLO_DEPLOYMENT_AUTH_INVALID' });
});
