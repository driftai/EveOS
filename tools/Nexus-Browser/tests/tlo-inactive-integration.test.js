'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const serviceChats = require('../local-targets/eveos-service-chats');
const workspaceBridge = require('../service-workspace-bridge');
const { createTloBackendRuntime } = require('../dex/tlo-backend-runtime');
const { createTloConversationStore, historyDigest, MAX_MESSAGES } = require('../dex/tlo-conversation-store');
const { createDurableTloOwnershipStore } = require('../dex/tlo-ownership-durable-store');
const { createTloOwnershipFence, HANDOFF_TTL_MS } = require('../dex/tlo-ownership-fence');
const { createServerDurability } = require('../dex/server-durability');
const { createTurnLedger } = require('../dex/turn-ledger');

const BROWSER = { kind: 'browser', id: 'search-monitor-gate2-browser', generation: 1 };
const BACKEND = { kind: 'backend', id: 'nexus-gate2-backend', generation: 2 };
const HISTORY = [{ role: 'user', content: 'kept question' }, { role: 'assistant', content: 'kept answer' }];

function memoryState() {
  const value = { version: 1, activeRoomId: null, rooms: [] };
  return { load: () => structuredClone(value), save: next => structuredClone(next) };
}

function fixture(t, { enabled = false, bootstrapBackend = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve3d-gate2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ownershipStore = createDurableTloOwnershipStore({ dirPath: path.join(dir, 'owners') });
  const conversationStore = createTloConversationStore({ dirPath: path.join(dir, 'conversation') });
  const fence = createTloOwnershipFence(ownershipStore);
  fence.claimInitialBrowser({ workspaceId: BROWSER.id });
  conversationStore.initialize({ generation: 1, history: HISTORY,
    expectedDigest: historyDigest({ scopeId: 'default', generation: 1, history: HISTORY }) });
  if (bootstrapBackend) handoff(fence, conversationStore, BROWSER, BACKEND, 'gate2-handoff-secret-0001');
  const ledger = createTurnLedger({ filePath: path.join(dir, 'turns.jsonl') });
  const durability = createServerDurability({ ledger, incidents: { record() {}, stats() { return {}; } } });
  let transportCalls = 0;
  let active = enabled;
  const runtime = createTloBackendRuntime({ active: () => active, owner: BACKEND,
    ownershipStore, conversationStore, durability, stateStore: memoryState(),
    streamChat: async () => { transportCalls += 1; throw new Error('inference must remain disabled'); } });
  return { dir, ownershipStore, conversationStore, fence, durability, runtime,
    setActive: value => { active = value; }, transportCalls: () => transportCalls };
}

function handoff(fence, conversations, from, to, secret) {
  const proof = conversations.proof('default', from.generation);
  const prepared = fence.prepareHandoff({ from, to, conversationDigest: proof.digest,
    sourceWorkspaceId: from.id, acknowledgementSecret: secret });
  const acknowledged = fence.acknowledgeHandoff({ handoffId: prepared.handoff.id,
    to, acknowledgementSecret: secret });
  fence.completeHandoff({ handoffId: prepared.handoff.id, from });
  conversations.advanceGeneration({ handoffProof: acknowledged.handoff });
  return acknowledged.handoff;
}

test('canonical registration order cannot create a second TLO owner or direct-send fallback', async t => {
  const f = fixture(t, { bootstrapBackend: true });
  workspaceBridge._resetForTests();
  serviceChats.configureExclusiveTloRoute(f.runtime.targetAdapter);
  t.after(() => serviceChats.configureExclusiveTloRoute(null));
  const beforeHost = await serviceChats.listTargets();
  const socket = { readyState: 1, send() {} };
  workspaceBridge.registerHost(socket, { workspaceId: 'search-monitor-gate2-viewer', targets: [serviceChats.TLO_ID] });
  const afterHost = await serviceChats.listTargets();
  assert.equal(beforeHost.filter(item => item.id === serviceChats.TLO_ID).length, 0);
  assert.equal(afterHost.filter(item => item.id === serviceChats.TLO_ID).length, 0);
  serviceChats.configureExclusiveTloRoute(null);
  workspaceBridge._resetForTests();
  workspaceBridge.registerHost(socket, { workspaceId: 'search-monitor-gate2-viewer-first', targets: [serviceChats.TLO_ID] });
  serviceChats.configureExclusiveTloRoute(f.runtime.targetAdapter);
  assert.equal((await serviceChats.listTargets()).filter(item => item.id === serviceChats.TLO_ID).length, 0);
  await assert.rejects(serviceChats.sendPrompt({ requestId: 'dex-turn-gate2-direct', text: 'blocked',
    target: { id: serviceChats.TLO_ID, providerId: 'tlo-chat', transport: 'search-monitor-workspace' },
    emit() {} }), { code: 'TLO_BACKEND_DISABLED' });
  assert.equal(f.transportCalls(), 0);
});

test('fresh restart fences interrupted work and missing receipt never replays inference', async t => {
  const f = fixture(t, { enabled: true, bootstrapBackend: true });
  const requestId = 'dex-turn-gate2-restart';
  const roomId = 'room-gate2-restart', sourceMessageId = 'msg-source-gate2-restart';
  const memberId = 'member-tlo-gate2-restart';
  const meta = { targetClassId: 'local-origin', targetId: serviceChats.TLO_ID, providerId: 'tlo-chat' };
  assert.equal((await f.durability.beforeDispatch({ type: 'send_prompt', requestId }, meta)).ok, true);
  await f.durability.observe({ type: 'response_final', requestId }, meta);
  f.fence.reserveTurn({ owner: BACKEND, requestId });
  f.fence.markDispatched({ owner: BACKEND, requestId });
  f.conversationStore.beginTurn({ generation: 2, requestId, roomId,
    sourceMessageId, dispatchId: 'tlo-dispatch-gate2-restart', message: 'work' });
  f.conversationStore.markDispatched({ generation: 2, requestId });
  f.conversationStore.markInferred({ generation: 2, requestId, response: 'inferred but not delivered' });
  const state = { version: 1, activeRoomId: roomId, rooms: [{ id: roomId,
    members: [{ id: memberId, binding: { targetClassId: 'local-origin',
      targetId: serviceChats.TLO_ID, providerId: 'tlo-chat' } }],
    messages: [{ id: sourceMessageId, senderKind: 'user', text: 'work' }], finalReceipts: [],
    recovery: { requestId, sourceMessageId, memberId, targetClassId: 'local-origin', providerId: 'tlo-chat' } }] };
  const restarted = createTloBackendRuntime({ active: true, owner: BACKEND,
    ownershipStore: f.ownershipStore,
    conversationStore: createTloConversationStore({ dirPath: path.join(f.dir, 'conversation') }),
    durability: f.durability, stateStore: { load: () => structuredClone(state) },
    streamChat: async () => { throw new Error('must not replay'); } });
  const fenced = restarted.fenceRestart();
  assert.equal(fenced.ownership.turn.phase, 'unknown');
  assert.equal(fenced.conversation.pending.phase, 'inferred');
  assert.equal(restarted.status().readiness.reason, 'uncertain');
  assert.throws(() => restarted.reconcileInferred(), { code: 'TLO_LEDGER_RECEIPT_UNVERIFIED' });
  assert.equal(restarted.status().readiness.reason, 'uncertain');
});

test('corrupt ownership state fails closed before target discovery', async t => {
  const f = fixture(t, { bootstrapBackend: true });
  fs.writeFileSync(path.join(f.dir, 'owners', 'default.json'), '{corrupt');
  assert.throws(() => f.runtime.status(), { code: 'TLO_OWNER_STORE_CORRUPT' });
  assert.deepEqual(await f.runtime.targetAdapter.listTargets(), []);
  assert.equal(f.transportCalls(), 0);
});

test('browser to backend to browser handoff preserves history and rejects stale owners', t => {
  const f = fixture(t);
  handoff(f.fence, f.conversationStore, BROWSER, BACKEND, 'gate2-handoff-secret-0002');
  assert.deepEqual(f.conversationStore.snapshot().history, HISTORY);
  assert.throws(() => f.fence.reserveTurn({ owner: BROWSER, requestId: 'dex-turn-gate2-stale-browser' }),
    { code: 'TLO_OWNER_STALE' });
  const browser3 = { kind: 'browser', id: BROWSER.id, generation: 3 };
  handoff(f.fence, f.conversationStore, BACKEND, browser3, 'gate2-handoff-secret-0003');
  assert.equal(f.fence.snapshot().state.generation, 3);
  assert.equal(f.conversationStore.snapshot().generation, 3);
  assert.throws(() => f.fence.reserveTurn({ owner: BACKEND, requestId: 'dex-turn-gate2-stale-backend' }),
    { code: 'TLO_OWNER_STALE' });
});

test('expired handoff evidence remains fenced and cannot change generation', t => {
  let clock = 10_000;
  const records = new Map();
  const fence = createTloOwnershipFence({ now: () => clock,
    read: scope => records.get(scope) || null,
    compareAndSwap(scope, revision, state) {
      const old = records.get(scope);
      if ((old?.revision ?? null) !== revision) return false;
      records.set(scope, { revision: (old?.revision || 0) + 1, state: structuredClone(state) }); return true;
    } });
  fence.claimInitialBrowser({ workspaceId: BROWSER.id });
  const prepared = fence.prepareHandoff({ from: BROWSER, to: BACKEND,
    conversationDigest: 'a'.repeat(64), sourceWorkspaceId: BROWSER.id,
    acknowledgementSecret: 'gate2-expirin' + 'g-secret-0001' });
  clock += HANDOFF_TTL_MS + 1;
  assert.throws(() => fence.acknowledgeHandoff({ handoffId: prepared.handoff.id,
    to: BACKEND, acknowledgementSecret: 'gate2-expirin' + 'g-secret-0001' }),
  { code: 'TLO_HANDOFF_EXPIRED' });
  assert.equal(fence.snapshot().state.generation, 1);
  assert.equal(fence.snapshot().state.handoff.status, 'prepared');
});

test('conversation finalization is exact, bounded and rejects late delivery', t => {
  const f = fixture(t, { bootstrapBackend: true });
  const requestId = 'dex-turn-gate2-history';
  f.conversationStore.beginTurn({ generation: 2, requestId, roomId: 'room-gate2-history',
    sourceMessageId: 'msg-source-gate2-history', dispatchId: 'tlo-dispatch-gate2-history', message: 'next' });
  f.conversationStore.markDispatched({ generation: 2, requestId });
  const inferred = f.conversationStore.markInferred({ generation: 2, requestId, response: 'result' });
  const args = { generation: 2, requestId, roomId: inferred.pending.roomId,
    sourceMessageId: inferred.pending.sourceMessageId, dispatchId: inferred.pending.dispatchId,
    responseDigest: inferred.pending.responseDigest, deliveryReceipt: { source: 'dex-durable-ledger',
      confirmed: true, requestId, roomId: inferred.pending.roomId,
      sourceMessageId: inferred.pending.sourceMessageId } };
  f.conversationStore.settleDelivered(args);
  assert.throws(() => f.conversationStore.settleDelivered(args), { code: 'TLO_HISTORY_TURN_STALE' });
  assert.ok(f.conversationStore.snapshot().history.length <= MAX_MESSAGES);
  assert.deepEqual(f.conversationStore.snapshot().history.slice(-2), [
    { role: 'user', content: 'next' }, { role: 'assistant', content: 'result' }
  ]);
});

test('readiness reports ownership lifecycle without premature ready claims', t => {
  const f = fixture(t);
  assert.equal(f.runtime.status().readiness.reason, 'browser-owned');
  const digest = f.conversationStore.proof('default', 1).digest;
  const prepared = f.fence.prepareHandoff({ from: BROWSER, to: BACKEND, conversationDigest: digest,
    sourceWorkspaceId: BROWSER.id, acknowledgementSecret: 'gate2-handof' + 'f-secret-0004' });
  assert.equal(f.runtime.status().readiness.reason, 'transferring');
  const acknowledged = f.fence.acknowledgeHandoff({ handoffId: prepared.handoff.id,
    to: BACKEND, acknowledgementSecret: 'gate2-handof' + 'f-secret-0004' });
  f.fence.completeHandoff({ handoffId: prepared.handoff.id, from: BROWSER });
  f.conversationStore.advanceGeneration({ handoffProof: acknowledged.handoff });
  assert.equal(f.runtime.status().readiness.reason, 'disabled');
  f.setActive(true);
  assert.equal(f.runtime.status().readiness.reason, 'backend-owned');
  assert.equal(f.runtime.status().readiness.ready, true);
});
