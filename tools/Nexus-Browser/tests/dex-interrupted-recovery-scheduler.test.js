'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDexServerScheduler } = require('../dex/server-scheduler');
const { PASSIVE_GRACE_MS } = require('../dex/passive-recovery-lifecycle');

test('scheduler archives a timed-out recovery, drains one queued send, and isolates a late old final', async () => {
  let stamp = Date.parse('2026-09-18T23:50:20.000Z');
  const now = () => new Date(stamp).toISOString();
  let value = { rooms: [{
    id: 'room-1', name: 'Eve + Astro', settings: { maxTurns: 1 },
    members: [
      { id: 'eve', name: 'Eve', binding: { targetClassId: 'online-origin',
        providerId: 'chatgpt', targetId: 42, url: 'https://chatgpt.com/c/eve' } },
      { id: 'astro', name: 'Astro', binding: { targetClassId: 'online-origin',
        providerId: 'chatgpt', targetId: 43, url: 'https://chatgpt.com/c/astro' } }
    ],
    messages: [
      { id: 'old-source', senderKind: 'user', senderId: 'user', text: 'Original work' },
      { id: 'queued-message', senderKind: 'agent', senderId: 'eve', text: 'New handoff to Astro' }
    ],
    relay: { active: false, remaining: 0, waitingFor: null },
    recovery: { requestId: 'dex-turn-original', memberId: 'eve',
      sourceMessageId: 'old-source', dispatched: true, interruptedAt: now(),
      passiveAt: now() },
    deferredRelays: [{ requestId: 'ctl-1', messageId: 'queued-message',
      queuedAt: now(), budget: 1 }],
    deferredSendReceipts: [{ requestId: 'ctl-1', messageId: 'queued-message', phase: 'queued' }]
  }] };
  const sent = [], timers = [];
  const target = { id: 43, providerId: 'chatgpt', url: 'https://chatgpt.com/c/astro' };
  const scheduler = createDexServerScheduler({
    stateStore: {
      load: () => structuredClone(value),
      save(next) { value = structuredClone(next); return structuredClone(value); }
    },
    durability: {
      beforeDispatch: async () => ({ ok: true }),
      query: () => ({ reliable: true, entry: { state: 'accepted' } }),
      observe: async () => null, markFailed: async () => null
    },
    getOnlineTargets: () => [target],
    getSelectedOnlineTarget: () => target,
    getProviders: () => [{ id: 'chatgpt',
      adapterContract: { operations: { send: true, recover: true, captureLatest: true } } }],
    sendExtension(msg) { sent.push(msg); return true; },
    sendLocalPrompt: async () => {},
    captureLocalLatest: async () => ({ text: '' }),
    now, nowMs: () => stamp,
    setTimer(fn, delay) { const timer = { fn, delay }; timers.push(timer); return timer; },
    clearTimer() {}
  });
  await scheduler.process();
  assert.ok(value.rooms[0].recovery, 'grace must not be shortened');
  assert.ok(timers.some((item) => item.delay === PASSIVE_GRACE_MS));
  stamp += PASSIVE_GRACE_MS + 1;
  await scheduler.process();
  assert.equal(value.rooms[0].recovery, undefined);
  assert.equal(value.rooms[0].lateFinalWatches.length, 1);
  await scheduler.process();
  assert.equal(value.rooms[0].deferredRelays.length, 0);
  assert.equal(value.rooms[0].pendingTurn.memberId, 'astro');
  await scheduler.process();
  const prompts = sent.filter((event) => event.type === 'send_prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].text.includes('New handoff to Astro'), true);
  const newTurn = scheduler.diagnostics().current.requestId;
  assert.notEqual(newTurn, 'dex-turn-original');
  assert.equal(await scheduler.handleTransportEvent({
    type: 'response_final', requestId: 'dex-turn-original', text: 'Old result returned late.'
  }), true);
  assert.equal(scheduler.diagnostics().current.requestId, newTurn);
  assert.match(value.rooms[0].messages.at(-1).text, /Old result returned late/);
  assert.equal(value.rooms[0].deferredRelays.length, 0);
  assert.equal(sent.filter((event) => event.type === 'send_prompt').length, 1);
});
