'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const pageState = require('../extension/content/chatgpt-page-state');
const returnApi = require('../extension/content/chatgpt-return');
const { createServerTurnLease, TURN_IDLE_TIMEOUT_MS, TURN_ABSOLUTE_TIMEOUT_MS } = require('../dex/server-turn-lease');

test('ChatGPT transient statuses emit bounded server-visible activity through long tool work', () => {
  let stamp = 1000;
  let status = 'Thinking...';
  let tick = null;
  const sent = [];
  const context = {
    module: { exports: {} },
    BrowserAiBridgeChatGptInput: { generationLooksActive: () => false },
    BrowserAiBridgeChatGptDeliveryWatchdog: require('../extension/content/chatgpt-delivery-watchdog'),
    BrowserAiBridgeChatGptAnswer: {
      responseTextForUserPrompt: () => status,
      assistantNodes: () => [], userNodes: () => [],
      normalizeText: (value) => String(value || '')
    },
    BrowserAiBridgeResponseDeadline: {
      DEFAULT_RESPONSE_DEADLINES: { idleTimeoutMs: 240000 },
      nextResponseDeadline: () => ({ action: 'wait', delayMs: 240000 }),
      minutes: () => 4
    },
    BrowserAiBridgeChatGptPageState: pageState,
    BrowserAiBridgeChatGptReturn: returnApi,
    Date: { now: () => stamp },
    MutationObserver: class { constructor(cb) { tick = cb; } observe() {} disconnect() {} },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage(event) { sent.push(event); } } },
    document: { body: {} },
    setInterval(fn) { tick = fn; return 1; }, clearInterval() {},
    setTimeout() { return 1; }, clearTimeout() {}
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../extension/content/chatgpt.js'), 'utf8');
  vm.runInNewContext(source, context);
  context.module.exports.watchResponse('dex-turn-tools', { count: 0, text: '', prompt: 'Investigate the repo', userCount: 1 });
  assert.equal(context.BrowserAiBridgeChatGptRuntime.responsePending(), true);
  for (let i = 0; i <= 20; i += 1) { stamp = 1000 + i * 15000; tick(); }
  const activity = sent.filter((event) => event.type === 'response_activity' && event.isGenerating === true);
  assert.ok(activity.length >= 19, 'status-only work must renew the lease, not vanish after four minutes');
  assert.equal(sent.some((event) => event.type === 'response_final'), false);
  status = 'Completed the review.';
  stamp += 4000; tick();
  stamp += 4000; tick();
  assert.equal(sent.filter((event) => event.type === 'response_final').length, 1);
  assert.equal(context.BrowserAiBridgeChatGptRuntime.responsePending(), false);
  assert.equal(context.module.exports.substantiveAssistantText('Thinking...'), '');
});

test('no stale or unowned text generates a ChatGPT tool heartbeat', () => {
  assert.equal(pageState.substantiveAssistantText('I am thinking about the fix.'), 'I am thinking about the fix.');
  assert.equal(pageState.substantiveAssistantText('● Thinking...'), '');
  assert.equal(pageState.transientStatusLine('Thought for 7s'), true);
  assert.equal(pageState.transientStatusLine('The actual review is complete.'), false);
});

test('server lease accepts verified provider activity and still enforces its independent absolute ceiling', async () => {
  let stamp = 1000, current = { requestId: 'dex-turn-tools', roomId: 'room-1' };
  let snapshot = { rooms: [{ id: 'room-1', recovery: {} }] };
  const timers = [], failures = [], clone = (v) => JSON.parse(JSON.stringify(v));
  const lease = createServerTurnLease({
    load: () => clone(snapshot), save: (next) => (snapshot = clone(next)),
    roomById: (value, id) => value.rooms.find((entry) => entry.id === id),
    getCurrent: () => current, nowMs: () => stamp, now: () => new Date(stamp).toISOString(),
    onTimeout: (event) => failures.push(event),
    setTimer(fn, delay) { const timer = { fn, delay, due: stamp + delay }; timers.push(timer); return timer; },
    clearTimer() {}
  });
  lease.begin();
  for (let i = 0; i < 20; i++) {
    stamp += 15000;
    lease.touch({ event: 'response_activity', generating: true });
  }
  assert.ok(stamp - 1000 > TURN_IDLE_TIMEOUT_MS);
  assert.equal(failures.length, 0);
  assert.equal(snapshot.rooms[0].recovery.generationState, 'active');
  stamp += TURN_IDLE_TIMEOUT_MS;
  await timers.at(-1).fn();
  assert.equal(failures.at(-1).code, 'RESPONSE_TIMEOUT_ACTIVE');
  assert.equal(TURN_ABSOLUTE_TIMEOUT_MS, 30 * 60 * 1000);
});
