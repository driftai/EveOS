'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAdapter,
  monotonicPartial,
  authoritativePartial,
  currentTurnComplete,
  shouldRunOffscreenRescue
} = require('../app-targets/chatgpt-windows');

function inspection(windowInfo, title = 'Native Eve Test') {
  return {
    windows: [{
      ...windowInfo,
      elements: [{
        selector: 'root', type: 'Pane', x: 0, y: 0, width: 1000, height: 700,
        children: [{
          selector: 'chat-title', type: 'Heading', name: title,
          x: 180, y: 45, width: 240, height: 26, children: []
        }]
      }]
    }]
  };
}

test('repeated target verification proves cached PID/HWND directly before global discovery', async () => {
  const windowInfo = { hwnd: 777, pid: 4242, title: 'ChatGPT', x: 0, y: 0, width: 1000, height: 700 };
  let listWindowsCalls = 0;
  let inspectCalls = 0;
  const runner = {
    async availability() { return { available: true, command: 'winapp.exe' }; },
    async runJson(args) {
      if (args[1] === 'list-windows') {
        listWindowsCalls += 1;
        return { ok: true, json: { windows: [windowInfo] }, stderr: '', stdout: '' };
      }
      if (args[1] === 'inspect') {
        inspectCalls += 1;
        return { ok: true, json: inspection(windowInfo), stderr: '', stdout: '' };
      }
      throw new Error('Unexpected command: ' + args.join(' '));
    }
  };

  const adapter = createAdapter({ runner, platform: 'win32' });
  const first = await adapter.listTargets();
  const second = await adapter.listTargets();

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(second[0].windowHandle, 777);
  assert.equal(second[0].pid, 4242);
  assert.equal(second[0].concreteTargetIdentity.conversationTitle, 'Native Eve Test');
  assert.equal(listWindowsCalls, 1, 'hot verification must not enumerate all windows again');
  assert.equal(inspectCalls, 2, 'hot verification should use one exact-HWND shallow inspect');
});

test('cached verification falls back to full discovery when the bound PID changes', async () => {
  const original = { hwnd: 777, pid: 4242, title: 'ChatGPT', x: 0, y: 0, width: 1000, height: 700 };
  const replacement = { ...original, pid: 5252 };
  let listWindowsCalls = 0;
  let inspectCalls = 0;
  const runner = {
    async availability() { return { available: true, command: 'winapp.exe' }; },
    async runJson(args) {
      if (args[1] === 'list-windows') {
        listWindowsCalls += 1;
        const live = listWindowsCalls === 1 ? original : replacement;
        return { ok: true, json: { windows: [live] }, stderr: '', stdout: '' };
      }
      if (args[1] === 'inspect') {
        inspectCalls += 1;
        const live = inspectCalls === 1 ? original : replacement;
        return { ok: true, json: inspection(live), stderr: '', stdout: '' };
      }
      throw new Error('Unexpected command: ' + args.join(' '));
    }
  };

  const adapter = createAdapter({ runner, platform: 'win32' });
  const [first] = await adapter.listTargets();
  const [second] = await adapter.listTargets();

  assert.equal(first.pid, 4242);
  assert.equal(second.pid, 5252);
  assert.equal(listWindowsCalls, 2, 'identity mismatch must escalate to full discovery');
  assert.ok(inspectCalls >= 3, 'fallback should re-inspect the newly discovered exact window');
});

test('offscreen rescue is bounded per stalled response segment and remains available after first text', () => {
  const incomplete = {
    correlated: true,
    text: 'partial answer',
    nativeTurn: { completeHint: false },
    provisional: false
  };
  assert.equal(shouldRunOffscreenRescue({
    observed: incomplete,
    candidate: 'partial answer',
    lastText: 'partial answer',
    acceptedAt: 1000,
    lastChangedAt: 1200,
    observedAt: 2100,
    attemptsSinceProgress: 0,
    visiblePollsSinceProgress: 2,
    lastRescueAt: 0,
    rescueAfterMs: 700,
    rescueIntervalMs: 1500,
    rescueMaxAttempts: 3
  }), true, 'a stalled incomplete turn should still get offscreen rescue after first text');

  assert.equal(shouldRunOffscreenRescue({
    observed: incomplete,
    candidate: 'partial answer extended',
    lastText: 'partial answer',
    acceptedAt: 1000,
    lastChangedAt: 1200,
    observedAt: 2100,
    attemptsSinceProgress: 0,
    visiblePollsSinceProgress: 2,
    rescueAfterMs: 700,
    rescueIntervalMs: 1500,
    rescueMaxAttempts: 3
  }), false, 'visible forward progress should stay on the cheap poll path');

  assert.equal(shouldRunOffscreenRescue({
    observed: incomplete,
    candidate: 'partial answer',
    lastText: 'partial answer',
    acceptedAt: 1000,
    lastChangedAt: 1200,
    observedAt: 5000,
    attemptsSinceProgress: 3,
    visiblePollsSinceProgress: 2,
    rescueAfterMs: 700,
    rescueIntervalMs: 1500,
    rescueMaxAttempts: 3
  }), false, 'one stalled segment must have a bounded deep-inspect budget');

  assert.equal(shouldRunOffscreenRescue({
    observed: incomplete,
    candidate: 'partial answer',
    lastText: 'partial answer',
    acceptedAt: 1000,
    lastChangedAt: 1200,
    observedAt: 2100,
    attemptsSinceProgress: 0,
    visiblePollsSinceProgress: 1
  }), false, 'one fresh visible sample is not enough evidence of a stalled segment');
});

test('authoritative current turn completion ignores unrelated stale global generating chrome', () => {
  const complete = {
    correlated: true,
    text: 'done',
    nativeTurn: { completeHint: true, isAssistant: true },
    provisional: false
  };
  assert.equal(currentTurnComplete(complete), true);
  assert.equal(shouldRunOffscreenRescue({
    observed: complete,
    candidate: 'done',
    lastText: 'done',
    acceptedAt: 1000,
    lastChangedAt: 1000,
    observedAt: 5000,
    attemptsSinceProgress: 0
  }), false);
});

test('published partials never shrink or oscillate while final truth may be shorter', () => {
  const p1843 = 'A'.repeat(1843);
  const p1902 = `${p1843}${'B'.repeat(59)}`;
  const p1841 = 'A'.repeat(1841);
  let published = '';
  const emitted = [];
  for (const candidate of [p1843, p1902, p1843, p1902, p1843, p1841]) {
    const next = monotonicPartial(published, candidate);
    if (next !== published) emitted.push(next.length);
    published = next;
  }
  assert.deepEqual(emitted, [1843, 1902]);
  assert.equal(published.length, 1902);
  const authoritativeFinal = 'A'.repeat(1839);
  assert.equal(authoritativeFinal.length, 1839, 'response_final remains free to correct UIA duplication');
  assert.equal(authoritativePartial(published, authoritativeFinal, {
    correlated: true, nativeTurn: { completeHint: true }, provisional: false
  }), authoritativeFinal, 'one completed native reconstruction may replace the stream before final');
  assert.equal(authoritativePartial(published, authoritativeFinal, {
    correlated: true, nativeTurn: { completeHint: false }, provisional: false
  }), published, 'an incomplete reconstruction must remain monotonic');
});
