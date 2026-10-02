'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const runner = require('../app-targets/winapp-runner');

test('read-only UI inspect retries a transient stale element and then succeeds', async () => {
  let calls = 0;
  const exec = async () => {
    calls += 1;
    if (calls === 1) return {
      ok: false, stdout: '{"error":{"code":"stale_element","message":"Element is no longer accessible"}}',
      stderr: '', exitCode: 1, signal: null
    };
    return { ok: true, stdout: '{"windows":[]}', stderr: '', exitCode: 0, signal: null };
  };
  const result = await runner.runJson(['ui', 'inspect', '-w', '123'], {
    command: 'winapp', exec, transientRetries: 2
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test('mutating UI commands never retry stale-element failures automatically', async () => {
  let calls = 0;
  const exec = async () => {
    calls += 1;
    return {
      ok: false, stdout: '{"error":{"code":"stale_element","message":"Element is no longer accessible"}}',
      stderr: '', exitCode: 1, signal: null
    };
  };
  const result = await runner.runJson(['ui', 'invoke', 'send-button'], {
    command: 'winapp', exec, allowFailure: true
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});

test('non-transient inspect failures are not replayed', async () => {
  let calls = 0;
  const exec = async () => {
    calls += 1;
    return {
      ok: false, stdout: '{"error":{"code":"access_denied","message":"Denied"}}',
      stderr: '', exitCode: 1, signal: null
    };
  };
  const result = await runner.runJson(['ui', 'inspect', '-w', '123'], {
    command: 'winapp', exec, allowFailure: true
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});
