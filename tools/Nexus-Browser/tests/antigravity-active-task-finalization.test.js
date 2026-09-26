'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { looksReadyForInput } = require('../local-targets/terminal-reply-parser');
const { sendPrompt, TARGET_PREFIX } = require('../local-targets/antigravity-existing');
test('an empty prompt with active Antigravity /tasks is not a completed relay turn', () => {
  assert.equal(looksReadyForInput('Running suite\n>\n? for shortcuts Gemini 3.8 Flash · high · 1 task(s) · /tasks'), false);
  assert.equal(looksReadyForInput('Running suite\n>\n? for shortcuts Gemini 3.8 Flash · high · 3 task(s) · /tasks'), false);
  assert.equal(looksReadyForInput('Qualification complete.\n>\n? for shortcuts Gemini 3.8 Flash · high · 0 task(s) · /tasks'), true);
});
test('existing-session observer waits through active tasks before emitting a single final report', async () => {
  const before = 'Earlier work\n>\n? for shortcuts';
  const running = 'Running full Nexus tests...\n>\n? for shortcuts Gemini 3.8 Flash · high · 1 task(s) · /tasks';
  const finished = 'Qualification complete: two failing assertions need alignment.\n>\n? for shortcuts Gemini 3.8 Flash · high · 0 task(s) · /tasks';
  const screens = [before, running, running, finished];
  const events = [], sent = [];
  let clock = 0;
  const code = await sendPrompt({
    requestId: 'dex-turn-active-tests',
    text: 'qualify',
    target: { id: TARGET_PREFIX + '4242', pid: 4242,
      providerId: 'local-antigravity-existing', providerName: 'Antigravity CLI' },
    emit: event => events.push(event),
    snapshotImpl: () => ({ ok: true, text: screens.shift() || finished }),
    sendImpl: (_pid, message) => { sent.push(message); return { ok: true }; },
    sleepImpl: async () => {},
    nowImpl: () => ++clock,
    timeoutMs: 100, pollMs: 0, stableMs: 0
  });
  assert.equal(code, 0);
  assert.deepEqual(sent, ['qualify']);
  const finals = events.filter(event => event.type === 'response_final');
  assert.equal(finals.length, 1);
  assert.match(finals[0].text, /Qualification complete/);
  assert.equal(finals[0].requestId, 'dex-turn-active-tests');
});
