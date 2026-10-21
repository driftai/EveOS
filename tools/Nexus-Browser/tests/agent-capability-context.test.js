'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const capability = require('../dex/agent-capability-context');
const stateApi = require('../dex/server-scheduler-state');
const { createDexServerScheduler } = require('../dex/server-scheduler');

function ids(context) { return context.packs.map((pack) => pack.id); }

test('provider-neutral capability selection expands dependencies and requires verification for engineering work', () => {
  const context = capability.resolve('Use the Machine Space terminal to fix the bug and run the smoke test.');
  assert.deepEqual(ids(context), ['machine-spaces', 'supervised-terminal', 'engineering-verification']);
  assert.match(capability.promptText(context), /\[\[EVEOS:CAPABILITIES machine-spaces supervised-terminal engineering-verification\]\]/);
  assert.match(capability.promptText(context), /Do not claim \*\*GREEN\*\*/);
  const publicContext = capability.publicContext(context);
  assert.equal(publicContext.schema, 'eveos.agent-capability-context.v1');
  assert.equal(publicContext.digest.length, 64);
  assert.ok(publicContext.packs.every((pack) => !Object.hasOwn(pack, 'text')));
});

test('explicit capability selection is bounded and suppresses incidental relay vocabulary', () => {
  const context = capability.resolve('[[EVEOS:CAPABILITIES playwright-browser]] git terminal repair');
  assert.deepEqual(ids(context), ['machine-spaces', 'playwright-browser']);
  assert.throws(() => capability.resolve('[[EVEOS:CAPABILITIES unrestricted-shell]]'), /Unknown registered capability/);
});

test('Node and Python resolve the shared registry to identical public provenance', () => {
  const message = 'Run Playwright browser verification, repair failures, then commit the tested change.';
  const expected = capability.publicContext(capability.resolve(message));
  const code = 'import json; from server_modules import agent_capability_registry as r; print(json.dumps(r.public_context(r.resolve(' + JSON.stringify(message) + ')), separators=(",",":")))';
  const actual = JSON.parse(execFileSync('python', ['-c', code], { cwd: capability.ROOT, encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(actual, expected);
});

test('scheduler provenance accepts the registry maximum and rejects overflow', () => {
  const context = capability.publicContext(capability.resolve(
    'Machine Space terminal Playwright repair test git repository'
  ));
  assert.equal(context.packs.length, 7);
  assert.deepEqual(stateApi.capabilityContext(context), context);
  assert.equal(stateApi.capabilityContext({ ...context, packs: [...context.packs, context.packs[0]] }), null);
});

test('scheduler injects server-selected context and ignores spoofed response provenance', async () => {
  let value = { version: 1, activeRoomId: 'room-one', rooms: [{ id: 'room-one', name: 'Engineering',
    members: [{ id: 'agent-one', name: 'Agent', binding: { targetClassId: 'online-origin', providerId: 'provider-one', targetId: 9, url: 'https://example.invalid/chat' } }],
    messages: [{ id: 'source-one', senderKind: 'user', senderId: 'user', senderName: 'Drift', text: 'Fix the bug and run the smoke test.' }],
    settings: { maxTurns: 1 }, relay: { active: false, remaining: 0, waitingFor: null } }] };
  const store = { load: () => structuredClone(value), save: (next) => (value = structuredClone(next)) };
  const sent = [], incidents = [], timers = [], target = { id: 9, providerId: 'provider-one', url: 'https://example.invalid/chat' };
  const scheduler = createDexServerScheduler({ stateStore: store,
    durability: { beforeDispatch: async () => ({ ok: true }), query: () => ({ reliable: true }) },
    getOnlineTargets: () => [target], getSelectedOnlineTarget: () => target,
    getProviders: () => [{ id: 'provider-one', adapterContract: { operations: { send: true } } }],
    sendExtension: (payload) => (sent.push(payload), true), recordIncident: (entry) => incidents.push(entry),
    setTimer: (fn) => (timers.push(fn), timers.length), clearTimer() {} });
  assert.equal(scheduler.startRelay({ roomId: 'room-one', sourceMessageId: 'source-one', budget: 1 }).ok, true);
  await timers.shift()();
  const prompt = sent.find((entry) => entry.type === 'send_prompt')?.text || '';
  assert.match(prompt, /engineering-verification/);
  assert.match(prompt, /Do not claim \*\*GREEN\*\*/);
  assert.match(prompt, /DEX LIVE CONTROL CONTRACT/);
  assert.match(prompt, /Current room: Engineering \(room-one\)/);
  assert.match(prompt, /"action":"use_room","room":/);
  const requestId = scheduler.diagnostics().current.requestId;
  await scheduler.handleTransportEvent({ type: 'response_final', requestId, text: 'I am ready to proceed.', capabilityContext:
    { schema: capability.SCHEMA, digest: 'a'.repeat(64), packs: [] } });
  const reply = value.rooms[0].messages.at(-1);
  assert.ok(reply.capabilityContext.packs.some((pack) => pack.id === 'engineering-verification'));
  assert.equal(incidents.at(-1).code, 'AGENT_CAPABILITY_CONTEXT_MISMATCH');
  assert.match(value.rooms[0].relay.lastStopReason, /readiness-only turn/);
});
