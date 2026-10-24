'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const serviceChats = require('../local-targets/eveos-service-chats');
const { createTloProductionActivation, sourceIdentity, PREPARE_TTL_MS,
  ACTIVE_LEASE_MS } = require('../dex/tlo-production-activation');
const { createTloProductionAssembly } = require('../dex/tlo-production-assembly');
const { createTloConversationStore, historyDigest } = require('../dex/tlo-conversation-store');
const { createDurableTloOwnershipStore } = require('../dex/tlo-ownership-durable-store');

const SESSION = 'nexus-session-production-test-0001';
const HISTORY = [{ role: 'user', content: 'preserved question' },
  { role: 'assistant', content: 'preserved answer' }];

function fixture(t, { hydrateError = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-tlo-production-'));
  t.after(() => { serviceChats.configureExclusiveTloRoute(null); fs.rmSync(dir, { recursive: true, force: true }); });
  let browserHistory = structuredClone(HISTORY), browserGeneration = 1, hydrateCalls = 0;
  const workspaceId = 'search-monitor-production-test-0001';
  const historyBridge = {
    snapshot() { return { bound: true, running: true, state: 'ready', workspaceId }; },
    async exportTloHistory({ scopeId, generation }) {
      browserGeneration = generation;
      return { history: structuredClone(browserHistory),
        digest: historyDigest({ scopeId, generation, history: browserHistory }) };
    },
    async hydrateTloHistory(payload) {
      hydrateCalls += 1;
      if (hydrateError) throw hydrateError;
      assert.equal(payload.expectedCurrentGeneration, browserGeneration);
      assert.equal(payload.expectedCurrentDigest,
        historyDigest({ scopeId: payload.scopeId, generation: browserGeneration, history: browserHistory }));
      assert.equal(payload.digest,
        historyDigest({ scopeId: payload.scopeId, generation: payload.generation, history: payload.history }));
      browserHistory = structuredClone(payload.history); browserGeneration = payload.generation;
      return { digest: payload.digest, messages: payload.history.length };
    },
    async sendPrompt() { return 'browser'; }
  };
  const source = sourceIdentity();
  const activation = createTloProductionActivation({
    filePath: path.join(dir, 'activation.json'), serverSessionId: SESSION, source
  });
  const assembly = createTloProductionAssembly({ serverSessionId: SESSION,
    getDurability: () => ({ query: () => null }),
    getStateStore: () => ({ load: () => ({ version: 1, rooms: [] }) }),
    ownershipStore: createDurableTloOwnershipStore({ dirPath: path.join(dir, 'owners') }),
    conversationStore: createTloConversationStore({ dirPath: path.join(dir, 'history') }),
    activation, historyBridge, eveosBaseUrl: 'http://127.0.0.1:8765' });
  t.after(() => assembly.close());
  return { dir, assembly, activation, historyBridge,
    browser: () => ({ history: browserHistory, generation: browserGeneration, hydrateCalls }) };
}

test('production assembly stays browser-owned and backend-disabled before preflight', async t => {
  const f = fixture(t);
  assert.equal(f.assembly.status().deployment.state, 'disabled');
  assert.equal(f.assembly.status().owner.generation, 0);
  assert.equal((await f.assembly.route.listTargets())[0].transport, 'search-monitor-workspace');
  assert.equal(fs.existsSync(f.activation.filePath), false);
});

test('preflight, one-use handoff and activation preserve exact conversation identity', async t => {
  const f = fixture(t);
  const prepared = await f.assembly.control.preflight();
  assert.equal(prepared.state, 'prepared');
  assert.equal(JSON.stringify(prepared).includes('secret'), false);
  assert.equal(f.assembly.status().owner.kind, 'browser');
  await assert.rejects(f.assembly.control.preflight(), { code: 'TLO_DEPLOYMENT_ALREADY_PREPARED' });
  assert.equal(f.assembly.control.handoff().state, 'handed_off');
  assert.equal((await f.assembly.route.listTargets()).length, 0);
  assert.equal(f.assembly.control.activate().state, 'active');
  const target = (await f.assembly.route.listTargets())[0];
  assert.equal(target.transport, 'tlo-backend-owner');
  assert.equal(f.assembly.status().readiness.state, 'ready');
  await f.assembly.control.rollback();
  assert.equal(f.assembly.status().owner.kind, 'browser');
  assert.deepEqual(f.browser().history, HISTORY);
  assert.equal(f.browser().generation, 3);
  assert.equal(fs.existsSync(f.activation.filePath), false);
});

test('rollback refuses unresolved work and never replays it', async t => {
  const f = fixture(t); await f.assembly.control.preflight(); f.assembly.control.handoff(); f.assembly.control.activate();
  const owner = f.assembly.status().owner;
  f.assembly.ownerFence.reserveTurn({ owner, requestId: 'dex-turn-production-unknown' });
  f.assembly.ownerFence.markDispatched({ owner, requestId: 'dex-turn-production-unknown' });
  f.assembly.ownerFence.markUncertain({ requestId: 'dex-turn-production-unknown' });
  await assert.rejects(f.assembly.control.rollback(), { code: 'TLO_ROLLBACK_BLOCKED' });
  assert.equal(f.assembly.status().uncertain, true);
});

test('lost browser acknowledgement leaves an explicit transferring safe stop', async t => {
  const f = fixture(t, { hydrateError: Object.assign(new Error('lost ack'), { code: 'LOST_ACK' }) });
  await f.assembly.control.preflight(); f.assembly.control.handoff(); f.assembly.control.activate();
  await assert.rejects(f.assembly.control.rollback(), { code: 'LOST_ACK' });
  const status = f.assembly.status();
  assert.equal(status.handoff.status, 'prepared');
  assert.equal(status.readiness.state, 'transferring');
  assert.equal(f.browser().hydrateCalls, 1);
});

test('expired or mixed-source activation fails closed without leaking credentials', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-tlo-activation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 1000;
  const filePath = path.join(dir, 'activation.json');
  const activation = createTloProductionActivation({ filePath, serverSessionId: SESSION,
    source: sourceIdentity(), now: () => clock });
  activation.prepare({ ownerId: 'nexus-backend-production-test', ownerGeneration: 2,
    browserWorkspaceId: 'search-monitor-production-test', browserGeneration: 1,
    browserDigest: 'a'.repeat(64) });
  assert.equal(JSON.stringify(activation.status()).includes('secret'), false);
  const mixed = createTloProductionActivation({ filePath, serverSessionId: SESSION,
    source: { ...sourceIdentity(), fingerprint: 'b'.repeat(64) }, now: () => clock });
  assert.equal(mixed.status().code, 'TLO_DEPLOYMENT_MIXED_VERSION');
  clock += PREPARE_TTL_MS + 1;
  assert.equal(activation.status().code, 'TLO_DEPLOYMENT_EXPIRED');
});

test('active authority uses a bounded renewable lease instead of surviving an owner crash', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-tlo-active-lease-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 10_000;
  const activation = createTloProductionActivation({ filePath: path.join(dir, 'activation.json'),
    serverSessionId: SESSION, source: sourceIdentity(), now: () => clock });
  activation.prepare({ ownerId: 'nexus-backend-lease-test', ownerGeneration: 2,
    browserWorkspaceId: 'search-monitor-lease-test', browserGeneration: 1,
    browserDigest: 'a'.repeat(64) });
  activation.markHandedOff(); activation.activate();
  const firstExpiry = activation.status().expiresAt;
  clock += ACTIVE_LEASE_MS / 2; activation.renew();
  assert.ok(activation.status().expiresAt > firstExpiry);
  clock += ACTIVE_LEASE_MS + 1;
  assert.equal(activation.status().code, 'TLO_DEPLOYMENT_EXPIRED');
});
