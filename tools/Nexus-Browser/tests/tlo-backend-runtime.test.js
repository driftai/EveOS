'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTloBackendRuntime } = require('../dex/tlo-backend-runtime');
const { createDurableTloOwnershipStore } = require('../dex/tlo-ownership-durable-store');
const { createTloConversationStore, historyDigest } = require('../dex/tlo-conversation-store');
const { createServerDurability } = require('../dex/server-durability');
const { createTurnLedger } = require('../dex/turn-ledger');
const { createServerLocalRelay } = require('../dex/server-local-relay');

const OWNER = { kind: 'backend', id: 'tlo-backend-runtime-test', generation: 2 };
const IDS = {
  requestId: 'dex-turn-runtime-0001',
  roomId: 'room-runtime-0001',
  sourceMessageId: 'msg-source-runtime-0001',
  memberId: 'member-tlo-runtime-0001'
};
const META = { targetClassId: 'local-origin', targetId: 'local:tlo-chat:default', providerId: 'tlo-chat' };

function memoryState() {
  let value = { version: 1, activeRoomId: IDS.roomId, rooms: [{
    id: IDS.roomId,
    members: [{ id: IDS.memberId, binding: { targetClassId: 'local-origin',
      targetId: META.targetId, providerId: META.providerId } }],
    messages: [{ id: IDS.sourceMessageId, senderKind: 'user', text: 'work' }],
    finalReceipts: [],
    recovery: { requestId: IDS.requestId, sourceMessageId: IDS.sourceMessageId,
      memberId: IDS.memberId, targetClassId: 'local-origin', providerId: 'tlo-chat' }
  }] };
  return {
    load: () => structuredClone(value),
    save: (next) => { value = structuredClone(next); return structuredClone(value); }
  };
}

function fixture(t, { active = true, streamChat = async () => ({ text: 'final' }) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve3d-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ownershipStore = createDurableTloOwnershipStore({ dirPath: path.join(dir, 'owners') });
  const conversationStore = createTloConversationStore({ dirPath: path.join(dir, 'history') });
  const ledger = createTurnLedger({ filePath: path.join(dir, 'turns.jsonl') });
  const durability = createServerDurability({ ledger,
    incidents: { record() {}, stats() { return {}; } } });
  const stateStore = memoryState();
  const history = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'context' }];
  const digest = historyDigest({ scopeId: 'default', generation: 1, history });
  conversationStore.initialize({ scopeId: 'default', generation: 1, history,
    expectedDigest: digest });

  const bootstrap = createTloOwnershipFenceForTest(ownershipStore, conversationStore, digest);
  const runtime = createTloBackendRuntime({ active, owner: OWNER, ownershipStore,
    conversationStore, durability, stateStore, streamChat });
  return { dir, ownershipStore, conversationStore, durability, ledger, stateStore, runtime, bootstrap };
}

function createTloOwnershipFenceForTest(store, conversationStore, conversationDigest) {
  const { createTloOwnershipFence } = require('../dex/tlo-ownership-fence');
  const fence = createTloOwnershipFence(store);
  fence.claimInitialBrowser({ workspaceId: 'search-monitor-runtime-test' });
  const acknowledgementSecret = 'runtime-handoff-secret-0001';
  const prepared = fence.prepareHandoff({
    from: { kind: 'browser', id: 'search-monitor-runtime-test', generation: 1 },
    to: { kind: 'backend', id: OWNER.id }, conversationDigest,
    sourceWorkspaceId: 'search-monitor-runtime-test', acknowledgementSecret
  });
  const acknowledged = fence.acknowledgeHandoff({ handoffId: prepared.handoff.id,
    to: { kind: 'backend', id: OWNER.id }, acknowledgementSecret });
  fence.completeHandoff({ handoffId: prepared.handoff.id,
    from: { kind: 'browser', id: 'search-monitor-runtime-test', generation: 1 } });
  conversationStore.advanceGeneration({ handoffProof: acknowledged.handoff });
  return fence;
}

async function target(runtime) {
  const targets = await runtime.targetAdapter.listTargets();
  assert.equal(targets.length, 1);
  return targets[0];
}

test('inactive composed runtime remains source-only and exposes no target', async t => {
  let calls = 0;
  const f = fixture(t, { active: false, streamChat: async () => { calls += 1; } });
  assert.deepEqual(await f.runtime.targetAdapter.listTargets(), []);
  assert.equal(f.runtime.status().active, false);
  assert.equal(calls, 0);
  assert.equal(f.runtime.ownerFence.snapshot().state.turn, null);
});

test('composed source path settles only after history and exact Dex final receipt', async t => {
  let calls = 0;
  const f = fixture(t, { streamChat: async ({ history, onPartial }) => {
    calls += 1;
    assert.equal(history.at(-1).content, 'context');
    onPartial('working');
    return { text: 'verified final' };
  } });
  assert.equal((await f.durability.beforeDispatch({ type: 'send_prompt', requestId: IDS.requestId }, META)).ok, true);
  const selected = await target(f.runtime);
  const events = [];
  const relay = createServerLocalRelay({
    tloBackendOwnership: f.runtime.ownershipSeam,
    localTargets: {
      async getLocalTarget() { return selected; },
      async sendLocalPrompt(input) {
        input.emit({ type: 'prompt_accepted', requestId: input.requestId });
        return f.runtime.targetAdapter.sendPrompt({ ...input, target: selected });
      }
    }
  });
  await relay.sendLocalPrompt({ targetId: selected.id, requestId: IDS.requestId,
    text: 'new work', correlation: { ...IDS, turnId: IDS.requestId },
    async emit(payload) {
      events.push(payload.type);
      await f.durability.observe(payload, META);
      if (payload.type === 'response_final') {
        const snapshot = f.stateStore.load(), room = snapshot.rooms[0];
        delete room.recovery;
        room.finalReceipts.push({ requestId: IDS.requestId, sourceMessageId: IDS.sourceMessageId,
          messageId: 'msg-response-runtime-0001', committedAt: '2026-10-24T00:00:00Z' });
        f.stateStore.save(snapshot);
      }
    }
  });
  assert.equal(calls, 1);
  assert.deepEqual(events, ['prompt_accepted', 'response_partial', 'response_final']);
  assert.equal(f.ledger.entry(IDS.requestId).state, 'completed');
  assert.equal(f.runtime.ownerFence.snapshot().state.turn, null);
  assert.equal(f.conversationStore.snapshot().pending, null);
  assert.equal(f.conversationStore.snapshot().history.at(-1).content, 'verified final');
});

test('composed transport failure fences both execution and conversation as unknown', async t => {
  const f = fixture(t, { streamChat: async () => { throw new Error('transport lost'); } });
  assert.equal((await f.durability.beforeDispatch({ type: 'send_prompt', requestId: IDS.requestId }, META)).ok, true);
  const selected = await target(f.runtime);
  const relay = createServerLocalRelay({ tloBackendOwnership: f.runtime.ownershipSeam,
    localTargets: { async getLocalTarget() { return selected; },
      async sendLocalPrompt(input) { return f.runtime.targetAdapter.sendPrompt({ ...input, target: selected }); } } });
  await assert.rejects(relay.sendLocalPrompt({ targetId: selected.id, requestId: IDS.requestId,
    text: 'new work', correlation: { ...IDS, turnId: IDS.requestId }, emit() {} }), /transport lost/);
  assert.equal(f.runtime.ownerFence.snapshot().state.turn.phase, 'unknown');
  assert.equal(f.conversationStore.snapshot().pending.phase, 'unknown');
  const restarted = f.runtime.fenceRestart();
  assert.equal(restarted.ownership.turn.phase, 'unknown');
  assert.equal(restarted.conversation.pending.phase, 'unknown');
});

test('crash after inference and Dex receipt reconciles exact correlated result without replay', async t => {
  let calls = 0;
  const f = fixture(t, { streamChat: async () => { calls += 1; return { text: 'durable final' }; } });
  assert.equal((await f.durability.beforeDispatch({ type: 'send_prompt', requestId: IDS.requestId }, META)).ok, true);
  const selected = await target(f.runtime);
  const relay = createServerLocalRelay({ tloBackendOwnership: f.runtime.ownershipSeam,
    localTargets: { async getLocalTarget() { return selected; },
      async sendLocalPrompt(input) { return f.runtime.targetAdapter.sendPrompt({ ...input, target: selected }); } } });
  await assert.rejects(relay.sendLocalPrompt({ targetId: selected.id, requestId: IDS.requestId,
    text: 'new work', correlation: { ...IDS, turnId: IDS.requestId },
    async emit(payload) {
      await f.durability.observe(payload, META);
      if (payload.type === 'response_final') {
        const snapshot = f.stateStore.load(), room = snapshot.rooms[0];
        delete room.recovery;
        room.finalReceipts.push({ requestId: IDS.requestId, sourceMessageId: IDS.sourceMessageId,
          messageId: 'msg-response-runtime-0002', committedAt: '2026-10-24T00:00:00Z' });
        f.stateStore.save(snapshot);
        throw new Error('simulated supervisor crash after durable receipt');
      }
    } }), /simulated supervisor crash/);
  assert.equal(calls, 1);
  assert.equal(f.runtime.ownerFence.snapshot().state.turn.phase, 'unknown');
  assert.equal(f.conversationStore.snapshot().pending.phase, 'inferred');
  assert.deepEqual(f.runtime.reconcileInferred(), { reconciled: true, requestId: IDS.requestId });
  assert.equal(f.conversationStore.snapshot().pending, null);
  assert.equal(f.runtime.ownerFence.snapshot().state.turn, null);
  assert.equal(f.runtime.reconcileInferred().reconciled, false);
  assert.equal(calls, 1);
});
