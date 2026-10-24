'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTloConversationStore, historyDigest } = require('../dex/tlo-conversation-store');
const { createTloBackendChatAdapter, MAX_PARTIAL_CHARS, MAX_PARTIAL_EVENTS } = require('../local-targets/tlo-backend-chat');
const { TLO_TARGET, TLO_PROVIDER } = require('../dex/tlo-dex-ledger-gate');
const { BACKEND_TRANSPORT } = require('../dex/tlo-backend-ownership-seam');
const { createTloDispatchCapabilityBroker } = require('../dex/tlo-dispatch-capability');

const OWNER = { kind: 'backend', id: 'tlo-backend-chat-test', generation: 2 };
const REQUEST = 'dex-turn-backend-chat-0001';
const CORRELATION = { roomId: 'room-backend-chat-0001', sourceMessageId: 'msg-source-backend-chat-0001' };

function fixture(t, { active = true, streamChat = async () => ({ text: 'done' }) } = {}) {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'eve3d-chat-'));
  t.after(() => fs.rmSync(dirPath, { recursive: true, force: true }));
  const conversationStore = createTloConversationStore({ dirPath });
  const dispatchCapabilities = createTloDispatchCapabilityBroker();
  const history = [{ role: 'user', content: 'prior question' }, { role: 'assistant', content: 'prior answer' }];
  conversationStore.initialize({ scopeId: 'default', generation: 2, history,
    expectedDigest: historyDigest({ scopeId: 'default', generation: 2, history }) });
  const readiness = ({ requestId = null } = {}) => {
    const record = conversationStore.snapshot();
    return active && (!record?.pending || record.pending.requestId === requestId)
      ? { ready: true } : { ready: false };
  };
  const adapter = createTloBackendChatAdapter({ active, conversationStore,
    dispatchCapabilities, readiness, owner: OWNER, streamChat });
  return { dirPath, conversationStore, dispatchCapabilities, adapter, history };
}

async function selected(adapter) {
  const targets = await adapter.listTargets();
  assert.equal(targets.length, 1);
  return targets[0];
}
function authorized(f, target, requestId = REQUEST) {
  return { correlation: CORRELATION, dispatchCapability: f.dispatchCapabilities.issue({
    scopeId: 'default', owner: OWNER, requestId, ...CORRELATION,
    targetId: target.id, transport: target.transport
  }) };
}

test('disabled adapter exposes no backend target and invokes no transport', async t => {
  let calls = 0;
  const f = fixture(t, { active: false, streamChat: async () => { calls += 1; } });
  assert.deepEqual(await f.adapter.listTargets(), []);
  assert.equal(f.adapter.status().state, 'backend_disabled');
  await assert.rejects(f.adapter.sendPrompt({ requestId: REQUEST, text: 'x', target: {}, emit() {} }),
  { code: 'TLO_BACKEND_DISABLED' });
  assert.equal(calls, 0);
});

test('enabled adapter exposes one exact server-owned TLO target', async t => {
  const f = fixture(t);
  const target = await selected(f.adapter);
  assert.deepEqual({ id: target.id, providerId: target.providerId, transport: target.transport,
    ownerGeneration: target.ownerGeneration }, {
    id: TLO_TARGET, providerId: TLO_PROVIDER, transport: BACKEND_TRANSPORT, ownerGeneration: 2
  });
  assert.equal(f.adapter.status().state, 'ready');
});

test('one authorized request receives prior history and retains inferred final until Dex delivery', async t => {
  const seen = [];
  const f = fixture(t, { streamChat: async (input) => {
    seen.push({ message: input.message, history: input.history });
    input.onPartial('working');
    return { text: 'finished', capabilityContext: { schema: 'test-context' } };
  } });
  const target = await selected(f.adapter);
  const events = [];
  const result = await f.adapter.sendPrompt({ requestId: REQUEST, text: 'new question', target, ...authorized(f, target),
    emit: (event) => events.push(event) });
  assert.equal(result, 'finished');
  assert.deepEqual(seen, [{ message: 'new question', history: f.history }]);
  assert.deepEqual(events.map((event) => [event.type, event.requestId, event.text]), [
    ['response_partial', REQUEST, 'working'], ['response_final', REQUEST, 'finished']
  ]);
  assert.deepEqual(f.conversationStore.snapshot().history, f.history);
  assert.equal(f.conversationStore.snapshot().pending.phase, 'inferred');
  assert.equal(f.conversationStore.snapshot().pending.requestId, REQUEST);
});

test('stale target generation never reaches transport', async t => {
  let calls = 0;
  const f = fixture(t, { streamChat: async () => { calls += 1; return { text: 'bad' }; } });
  const target = { ...(await selected(f.adapter)), ownerGeneration: 1 };
  await assert.rejects(f.adapter.sendPrompt({ requestId: REQUEST, text: 'x', target, emit() {} }),
  { code: 'TLO_BACKEND_TARGET_STALE' });
  assert.equal(calls, 0);
  assert.equal(f.conversationStore.snapshot().pending, null);
});

test('direct adapter invocation without an issued capability never reaches transport', async t => {
  let calls = 0;
  const f = fixture(t, { streamChat: async () => { calls += 1; return { text: 'bad' }; } });
  const target = await selected(f.adapter);
  await assert.rejects(f.adapter.sendPrompt({ requestId: REQUEST, text: 'bypass', target,
    correlation: CORRELATION, emit() {} }), { code: 'TLO_DISPATCH_CAPABILITY_REQUIRED' });
  assert.equal(calls, 0);
  assert.equal(f.conversationStore.snapshot().pending, null);
});

test('transport failure leaves durable unknown work and cannot retry', async t => {
  let calls = 0;
  const f = fixture(t, { streamChat: async () => { calls += 1; throw Object.assign(new Error('lost'), { code: 'LINK_LOST' }); } });
  const target = await selected(f.adapter);
  await assert.rejects(f.adapter.sendPrompt({ requestId: REQUEST, text: 'question', target,
    ...authorized(f, target), emit() {} }),
  { code: 'LINK_LOST' });
  assert.equal(f.conversationStore.snapshot().pending.phase, 'unknown');
  await assert.rejects(f.adapter.sendPrompt({ requestId: 'dex-turn-backend-chat-0002',
    text: 'retry', target, emit() {} }), { code: 'TLO_BACKEND_NOT_READY' });
  assert.equal(calls, 1);
});

test('empty final response is unknown rather than inferred successful', async t => {
  const f = fixture(t, { streamChat: async () => ({ text: '' }) });
  const target = await selected(f.adapter);
  await assert.rejects(f.adapter.sendPrompt({ requestId: REQUEST, text: 'question', target,
    ...authorized(f, target), emit() {} }),
  { code: 'TLO_BACKEND_FINAL_MISSING' });
  assert.equal(f.conversationStore.snapshot().pending.phase, 'unknown');
});

test('an existing unresolved journal suppresses target readiness', async t => {
  const f = fixture(t);
  f.conversationStore.beginTurn({ scopeId: 'default', generation: 2,
    requestId: REQUEST, message: 'pending', ...CORRELATION, dispatchId: 'tlo-dispatch-backend-chat-pending' });
  assert.deepEqual(await f.adapter.listTargets(), []);
  assert.equal(f.adapter.status().busy, true);
  assert.equal(f.adapter.status().state, 'backend_prepared');
});

test('partial projection is deduplicated, length-capped and event-bounded', async t => {
  const f = fixture(t, { streamChat: async ({ onPartial }) => {
    for (let index = 0; index < MAX_PARTIAL_EVENTS + 20; index += 1) onPartial(`${index}:${'x'.repeat(MAX_PARTIAL_CHARS + 20)}`);
    return { text: 'bounded final' };
  } });
  const target = await selected(f.adapter), events = [];
  await f.adapter.sendPrompt({ requestId: REQUEST, text: 'question', target,
    ...authorized(f, target), emit: event => events.push(event) });
  const partials = events.filter(event => event.type === 'response_partial');
  assert.equal(partials.length, MAX_PARTIAL_EVENTS);
  assert.equal(Math.max(...partials.map(event => event.text.length)), MAX_PARTIAL_CHARS);
  assert.equal(events.at(-1).type, 'response_final');
});
