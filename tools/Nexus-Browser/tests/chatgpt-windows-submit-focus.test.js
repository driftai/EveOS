'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { acceptanceState, createSubmitter } = require('../app-targets/chatgpt-windows-submit');

function snapshot(overrides = {}) {
  return {
    hwnd: 3880200,
    pid: 95192,
    title: 'ChatGPT',
    texts: [],
    composerSelector: '',
    composerValue: '',
    composer: null,
    sendSelector: '',
    sendCandidates: [],
    composerCandidates: [],
    generating: false,
    ...overrides
  };
}

function harness({ inspectSnapshots = [], runJson } = {}) {
  const calls = [];
  let inspectIndex = 0;
  const runner = {
    async runJson(args, options) {
      calls.push([...args]);
      return runJson ? runJson(args, options, calls) : { ok: true, json: {} };
    }
  };
  const inspect = async () => {
    const value = inspectSnapshots[Math.min(inspectIndex, inspectSnapshots.length - 1)];
    inspectIndex += 1;
    return value;
  };
  const submit = createSubmitter({
    runner,
    inspect,
    recoverComposer: async () => '',
    recoverSend: async () => '',
    sleepFn: async () => {}
  });
  return { submit, calls, inspections: () => inspectIndex };
}

const baseline = snapshot({
  composerSelector: 'composer-exact',
  composerValue: '',
  composer: { selector: 'composer-exact' }
});

test('prompt text exposed only by the live composer is not accepted', () => {
  const text = 'still an unsent draft';
  const state = acceptanceState(snapshot({ texts: [text], composerValue: text }), text);
  assert.equal(state.visiblePrompt, true);
  assert.equal(state.composerStillPrompt, true);
  assert.equal(state.accepted, false);
  assert.equal(state.definitelyNotAccepted, true);
});

test('background submit targets the bound composer without foreground focus', async () => {
  const text = 'background focus race test';
  const h = harness({
    inspectSnapshots: [
      snapshot({ composerValue: text }),
      snapshot({ texts: [text], composerValue: 'Ask ChatGPT', generating: true })
    ],
    runJson(args) {
      if (args[1] === 'focus') assert.fail('background hot path must not require focus');
      return { ok: true, json: {} };
    }
  });

  const result = await h.submit(text, baseline);
  const sends = h.calls.filter((args) => args[1] === 'send-keys');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].slice(0, 3), ['ui', 'send-keys', 'enter']);
  assert.ok(sends[0].includes('composer-exact'));
  assert.ok(sends[0].includes(String(baseline.hwnd)));
  assert.ok(sends[0].includes('post-message'));
  assert.equal(result.timing.submitMode, 'targeted-enter');
});

test('staging replaces a pre-existing native draft before any submit gesture', async () => {
  const text = 'exact replacement prompt';
  const wrong = snapshot({ composerSelector: 'composer-exact', composerValue: `old draft ${text}` });
  const h = harness({
    inspectSnapshots: [
      wrong, wrong, wrong, wrong, wrong, wrong,
      snapshot({ composerSelector: 'composer-exact', composerValue: text }),
      snapshot({ texts: [text], composerValue: 'Ask ChatGPT', generating: true })
    ]
  });

  await h.submit(text, baseline);
  const keys = h.calls.filter((args) => args[1] === 'send-keys');
  assert.deepEqual(keys.map((args) => args[2]), ['ctrl+a delete', 'enter']);
  assert.ok(keys[0].includes('composer-exact') && keys[0].includes('send-input'));
  assert.equal(h.calls.filter((args) => args[1] === 'set-value').length, 2,
    'replacement clears first, then sets the exact value on the empty rich editor');
});

test('staging waits for delayed rich-editor value convergence before submitting', async () => {
  const text = 'eventually exact prompt';
  const duplicatedTail = `${text}t`;
  const h = harness({
    inspectSnapshots: [
      snapshot({ composerSelector: 'composer-exact', composerValue: `old ${text}` }),
      snapshot({ composerSelector: 'composer-exact', composerValue: duplicatedTail }),
      snapshot({ composerSelector: 'composer-exact', composerValue: duplicatedTail }),
      snapshot({ composerSelector: 'composer-exact', composerValue: text }),
      snapshot({ texts: [text], composerValue: 'Ask ChatGPT', generating: true })
    ]
  });

  await h.submit(text, baseline);
  assert.equal(h.calls.filter((args) => args[1] === 'set-value').length, 1);
  assert.equal(h.calls.filter((args) => args[1] === 'send-keys' && args[2] === 'ctrl+a delete').length, 0);
  assert.equal(h.calls.filter((args) => args[1] === 'send-keys' && args[2] === 'enter').length, 1);
});

test('failed targeted submit is never repeated when read-only evidence already proves acceptance', async () => {
  const text = 'accepted despite helper failure';
  let enterCalls = 0;
  const h = harness({
    inspectSnapshots: [
      snapshot({ composerValue: text }),
      snapshot({ texts: [text], composerValue: 'Ask ChatGPT', generating: true })
    ],
    runJson(args) {
      if (args[1] === 'send-keys') {
        enterCalls += 1;
        return { ok: false, stderr: 'foreground changed' };
      }
      if (args[1] === 'focus') assert.fail('accepted mutation must not be retried through focus');
      return { ok: true, json: {} };
    }
  });

  const result = await h.submit(text, baseline);
  assert.equal(enterCalls, 1);
  assert.equal(result.snapshot.generating, true);
});

test('focus recovery is allowed only after the exact prompt is proven unsent', async () => {
  const text = 'safe focus recovery';
  let enterCalls = 0;
  let focusCalls = 0;
  const h = harness({
    inspectSnapshots: [
      snapshot({ composerValue: text }),
      snapshot({ composerValue: text }),
      snapshot({ texts: [text], composerValue: 'Ask ChatGPT', generating: true })
    ],
    runJson(args) {
      if (args[1] === 'send-keys') {
        enterCalls += 1;
        return enterCalls === 1
          ? { ok: false, stderr: 'background target rejected input' }
          : { ok: true, json: {} };
      }
      if (args[1] === 'focus') {
        focusCalls += 1;
        return { ok: true, json: {} };
      }
      return { ok: true, json: {} };
    }
  });

  const result = await h.submit(text, baseline);
  assert.equal(enterCalls, 2);
  assert.equal(focusCalls, 1);
  assert.equal(result.timing.submitMode, 'focused-enter-recovery');
});

test('successful no-op background Enter gets one focused retry after exact unsent proof', async () => {
  const text = 'background command can lie';
  let enterCalls = 0;
  let focusCalls = 0;
  const h = harness({
    inspectSnapshots: [
      snapshot({ composerValue: text }),
      snapshot({ texts: [text], composerValue: text }),
      snapshot({ texts: [text], composerValue: 'Ask ChatGPT', generating: true })
    ],
    runJson(args) {
      if (args[1] === 'send-keys' && args[2] === 'enter') enterCalls += 1;
      if (args[1] === 'focus') focusCalls += 1;
      return { ok: true, json: {} };
    }
  });

  const result = await h.submit(text, baseline);
  assert.equal(enterCalls, 2);
  assert.equal(focusCalls, 1);
  assert.equal(result.timing.submitMode, 'focused-enter-recovery');
});

test('successful no-op Send invoke falls back to exact-HWND Enter after unsent proof', async () => {
  const text = 'invoke command can lie';
  let invokeCalls = 0;
  let enterCalls = 0;
  let focusCalls = 0;
  const h = harness({
    inspectSnapshots: [
      snapshot({ composerSelector: 'composer-exact', composerValue: text, sendSelector: 'send-exact' }),
      snapshot({ texts: [text], composerValue: text, sendSelector: 'send-exact' }),
      snapshot({ texts: [text], composerValue: 'Ask ChatGPT', generating: true })
    ],
    runJson(args) {
      if (args[1] === 'invoke') invokeCalls += 1;
      if (args[1] === 'send-keys' && args[2] === 'enter') enterCalls += 1;
      if (args[1] === 'focus') focusCalls += 1;
      return { ok: true, json: {} };
    }
  });

  const result = await h.submit(text, baseline);
  assert.equal(invokeCalls, 1);
  assert.equal(enterCalls, 1);
  assert.equal(focusCalls, 0);
  assert.equal(result.timing.submitMode, 'post-message-enter-recovery');
});

test('ambiguous post-submit state fails closed without a second mutation', async () => {
  const text = 'do not duplicate me';
  let enterCalls = 0;
  let focusCalls = 0;
  const h = harness({
    inspectSnapshots: [
      snapshot({ composerValue: text }),
      snapshot({ composerValue: 'changed but not proven accepted' })
    ],
    runJson(args) {
      if (args[1] === 'send-keys') {
        enterCalls += 1;
        return { ok: false, stderr: 'foreground changed mid-submit' };
      }
      if (args[1] === 'focus') {
        focusCalls += 1;
        return { ok: true, json: {} };
      }
      return { ok: true, json: {} };
    }
  });

  await assert.rejects(() => h.submit(text, baseline), (error) => {
    assert.equal(error.code, 'APP_SUBMIT_UNCERTAIN');
    return true;
  });
  assert.equal(enterCalls, 1);
  assert.equal(focusCalls, 0);
});
