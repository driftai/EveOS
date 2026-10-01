const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../public/dex-failure-policy.js');

test('failure policy retries only known pre-dispatch transient failures', () => {
  const first = policy.decision('EXTENSION_OFFLINE', { dispatched: false, retryCount: 0 });
  assert.equal(first.retry, true);
  assert.equal(first.delayMs, 500);
  const afterDispatch = policy.decision('EXTENSION_OFFLINE', { dispatched: true, retryCount: 0 });
  assert.equal(afterDispatch.retry, false);
  assert.equal(afterDispatch.action, 'recover');
});

test('failure policy distinguishes deterministic pause and incident classes', () => {
  assert.equal(policy.decision('HOST_ACCESS_REQUIRED').action, 'pause');
  assert.equal(policy.decision('SOMETHING_NEW').action, 'incident');
});

test('failure policy recognizes all states where replay could duplicate a side effect', () => {
  for (const state of ['dispatching', 'accepted', 'responding', 'completed', 'failed']) {
    assert.equal(policy.dispatchMayHaveOccurred(state), true);
  }
  assert.equal(policy.dispatchMayHaveOccurred(null), false);
});


test('provider health failures pause instead of retrying or resending', () => {
  for (const code of [
    'PROVIDER_RATE_LIMITED',
    'PROVIDER_CONVERSATION_LIMIT',
    'PROVIDER_AUTH_REQUIRED',
    'PROVIDER_UNAVAILABLE'
  ]) {
    const value = policy.decision(code, { dispatched: false, retryCount: 0 });
    assert.equal(value.action, 'pause', code);
    assert.equal(value.retry, false, code);
  }
});


test('provider connection interruption codes enter capture recovery without provider-name special cases', () => {
  for (const code of ['CHATGPT_CONNECTION_INTERRUPTED', 'MUSE_CONNECTION_INTERRUPTED', 'FUTURE_PROVIDER_CONNECTION_INTERRUPTED']) {
    assert.equal(policy.canonicalCode(code), 'PROVIDER_CONNECTION_INTERRUPTED', code);
    const value = policy.decision(code, { dispatched: true, retryCount: 0 });
    assert.equal(value.action, 'recover', code);
    assert.equal(value.retry, false, code);
  }
});

test('prompt send failure enters capture recovery instead of stopping the room', () => {
  const value = policy.decision('PROMPT_SEND_FAILED', { dispatched: true, retryCount: 0 });
  assert.equal(value.action, 'recover');
  assert.equal(value.retry, false);
});


test('native App-Origin busy retries only before dispatch ownership is claimed', () => {
  const preDispatch = policy.decision('APP_TARGET_BUSY', { dispatched: false, retryCount: 0 });
  assert.equal(preDispatch.action, 'retry');
  assert.equal(preDispatch.retry, true);
  assert.equal(preDispatch.delayMs, 300);

  const afterDispatch = policy.decision('APP_TARGET_BUSY', { dispatched: true, retryCount: 0 });
  assert.equal(afterDispatch.action, 'recover');
  assert.equal(afterDispatch.retry, false);
});
