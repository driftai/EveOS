'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { normalizeRateLimits, dispatchPolicy, appServerRpc, freshQuota, ensureCodexDispatch } = require('../local-targets/codex-quota');
const at = 1790000000;

test('maps rate buckets by duration, not primary vs secondary labels', () => {
  const x = normalizeRateLimits({ rateLimits: { primary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: at }, secondary: { usedPercent: 95, windowDurationMins: 300, resetsAt: at + 42 } } });
  assert.equal(x.fiveHour.remainingPercent, 5);
  assert.equal(x.weekly.remainingPercent, 69);
  assert.equal(x.fiveHour.resetAt, new Date((at + 42) * 1000).toISOString());
});

test('does not invent a missing five-hour window or assume weekly is secondary', () => {
  const x = normalizeRateLimits({ rateLimits: { primary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: at }, secondary: null } });
  assert.equal(x.fiveHour, null);
  assert.equal(x.incomplete, true);
  assert.equal(dispatchPolicy(x, { unattended: true }).permitted, false);
  assert.equal(dispatchPolicy(x, { unattended: false }).permitted, true);
});

test('exhausted quota blocks manual and unattended sends; low quota warns manual', () => {
  const low = normalizeRateLimits({ rateLimits: { primary: { usedPercent: 95, windowDurationMins: 300, resetsAt: at }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: at } } });
  assert.equal(dispatchPolicy(low, { unattended: true }).permitted, false);
  assert.equal(dispatchPolicy(low, { unattended: false }).permitted, true);
  const exhausted = { ...low, reached: true };
  assert.equal(dispatchPolicy(exhausted, { unattended: false }).permitted, false);
});

test('malformed quota percentages are unavailable, never zero or guessed', () => {
  const x = normalizeRateLimits({ rateLimits: { primary: { usedPercent: 200, windowDurationMins: 300, resetsAt: 0 } } });
  assert.equal(x.state, 'UNAVAILABLE');
  assert.equal(x.fiveHour, null);
});

test('app-server performs initialization then one read-only rate-limit request', async () => {
  const calls = [];
  let child;
  const spawnImpl = (command, args, options) => {
    assert.deepEqual(args, ['app-server', '--stdio']);
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.resume = () => {};
    child.stdin = { write(data) {
      const frame = JSON.parse(data);
      calls.push(frame);
      queueMicrotask(() => {
        if (frame.id === 1) child.stdout.emit('data', JSON.stringify({ id: 1, result: {} }) + '\n');
        if (frame.id === 2) child.stdout.emit('data', JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: at } } } }) + '\n');
      });
    }, end() {} };
    child.kill = () => {};
    return child;
  };
  const result = await appServerRpc({ launch: { command: 'codex', shell: false }, spawnImpl });
  assert.equal(result.rateLimits.primary.usedPercent, 20);
  assert.deepEqual(calls.map((x) => x.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.ok(calls.every((x) => !JSON.stringify(x).includes('consume')));
});

test('quota read errors become unavailable snapshots, without leaking error content', async () => {
  const value = await freshQuota({ reader: () => Promise.reject(Error('PRIVATE_TOKEN_SHOULD_NOT_LEAK')), now: () => 100000, maxAgeMs: 0 });
  assert.equal(value.state, 'UNAVAILABLE');
  assert.ok(!JSON.stringify(value).includes('PRIVATE_TOKEN_SHOULD_NOT_LEAK'));
});


test('unattended handoff blocks low quota while manual handoff permits it', async () => {
  const read = async () => normalizeRateLimits({ rateLimits: {
    primary: { usedPercent: 96, windowDurationMins: 300, resetsAt: at },
    secondary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: at },
  } });
  await assert.rejects(ensureCodexDispatch({ read, unattended: true }), { code: 'CODEX_QUOTA_BLOCKED' });
  const manual = await ensureCodexDispatch({ read });
  assert.equal(manual.policy.permitted, true);
  assert.equal(manual.policy.state, 'LOW');
});
