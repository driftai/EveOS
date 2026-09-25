'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('../public/dex-failure-policy');
const { sendPrompt, TARGET_PREFIX } = require('../local-targets/antigravity-existing');
const { TURN_ABSOLUTE_TIMEOUT_MS } = require('../dex/server-turn-lease');
const parser = require('../local-targets/terminal-reply-parser');

const target = { id: TARGET_PREFIX + '670819', pid: 670819,
  providerId: 'local-antigravity-existing', providerName: 'Antigravity CLI' };
const prior = 'Previous turn\n>\n? for shortcuts          Gemini 3.8 Flash · medium';
const working = (step) => [
  '> Read "C:\\Users\\alvin\\inbox\\dex-turn-long.md" as my exact user message.',
  '● ManageTask(status task-582-' + step + ')',
  '  Full regression suite still running...',
  '▸ Thought for ' + step + 's'
].join('\n');
const completed = [
  '● ManageTask(status task-582-6)',
  '### Consolidated Qualification Report',
  'Commit: 26e98f4578af95a288d9f3959715e27f0bb82f24',
  'Nexus Browser: 938 passed, 0 failed',
  'Root gates: 3/3 passed',
  '>',
  '? for shortcuts          Gemini 3.8 Flash · medium'
].join('\n');

test('a six-minute tool-running terminal emits liveness and returns its ORIGINAL final once', async () => {
  let clock = 0, tick = 0;
  const sends = [], events = [];
  const result = await sendPrompt({
    requestId: 'dex-turn-long-qualification',
    text: 'Run the long qualification and send one report.',
    target,
    snapshotImpl: async () => {
      if (tick === 0) { tick += 1; return { ok: true, text: prior }; }
      tick += 1;
      return { ok: true, text: tick < 8 ? working(tick) : completed };
    },
    sendImpl: (pid, message) => { sends.push({ pid, message }); return { ok: true }; },
    emit: (event) => events.push(event),
    nowImpl: () => clock,
    sleepImpl: async () => { clock += 60_000; },
    pollMs: 0, stableMs: 0
  });
  assert.equal(result, 0);
  assert.ok(clock > 180_000, 'must exceed the previous three-minute adapter cutoff');
  assert.ok(clock < TURN_ABSOLUTE_TIMEOUT_MS, 'must finish within the independent server cap');
  assert.equal(sends.length, 1);
  assert.ok(events.filter((event) => event.type === 'activity_update').length >= 3);
  assert.equal(events.filter((event) => event.type === 'response_final').length, 1);
  assert.equal(events.filter((event) => event.type === 'error').length, 0);
  assert.match(events.find((event) => event.type === 'response_final').text, /938 passed, 0 failed/);
});

test('a static terminal expires into capture-only recovery without replaying the prompt', async () => {
  let clock = 0, first = true;
  const events = [], sends = [];
  const code = await sendPrompt({
    requestId: 'dex-turn-timeout-proof', text: 'One existing terminal prompt.', target,
    snapshotImpl: async () => {
      if (first) { first = false; return { ok: true, text: prior }; }
      return { ok: true, text: working(1) };
    },
    sendImpl: (pid, message) => { sends.push(message); return { ok: true }; },
    emit: (event) => events.push(event), nowImpl: () => clock,
    sleepImpl: async () => { clock += 35_000; },
    pollMs: 0, stableMs: 1600, timeoutMs: 90_000
  });
  assert.equal(code, 1);
  assert.equal(sends.length, 1);
  assert.equal(events.filter((event) => event.type === 'error').length, 1);
  assert.equal(events.at(-1).code, 'LOCAL_EXISTING_TIMEOUT');
  assert.equal(policy.decision('LOCAL_EXISTING_TIMEOUT', { dispatched: true }).action, 'recover');
  assert.equal(policy.decision('LOCAL_EXISTING_TIMEOUT', { dispatched: true }).retry, false);
});

test('structured reply selection and terminal source remain modular and bounded', () => {
  assert.equal(parser.selectReadyReply('### Final report', 'partial'), '### Final report');
  assert.equal(parser.selectReadyReply('', 'accumulated final'), 'accumulated final');
  const dir = path.resolve(__dirname, '..');
  for (const file of ['local-targets/antigravity-existing.js', 'local-targets/terminal-reply-parser.js']) {
    const count = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r?\n$/, '').split(/\r?\n/).length;
    assert.ok(count <= 440, file + ' exceeds the 440-line source headroom cap (' + count + ')');
  }
});
