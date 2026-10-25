'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const submit = require('../extension/gemini-studio-submit.js');

const fast = { delay: async () => {}, composerTimeoutMs: 10, runTimeoutMs: 1, verifyTimeoutMs: 1 };

test('submission proof requires a matching committed user turn or a true generation transition', () => {
  assert.equal(submit.submissionObserved({ userTurns: 3, lastUserText: 'other', generating: false }, 'hello', 2), false);
  assert.equal(submit.submissionObserved({ userTurns: 3, lastUserText: 'other', generating: true }, 'hello', 2), false);
  assert.equal(submit.submissionObserved({ userTurns: 3, lastUserText: 'hello', generating: false }, 'hello', 2), true);
  assert.equal(submit.submissionObserved({ userTurns: 2, lastUserText: '', generating: true }, 'hello', 2), true);
  assert.equal(submit.submissionObserved({ userTurns: 2, lastUserText: '', generating: true }, 'hello', 2, true), false);
  assert.equal(submit.submissionObserved({ userTurns: 2, lastUserText: 'hello', generating: false }, 'hello', 2), false);
});

test('one Run invocation returns committed proof only after matching user turn is observed', async () => {
  let clicked = 0;
  const ops = {
    async inspect() {
      return { composerFound: true, runFound: true, userTurns: clicked ? 3 : 2,
        lastUserText: clicked ? 'hello' : 'previous', generating: false };
    },
    async setPrompt(text) { assert.equal(text, 'hello'); return { ok: true, value: text }; },
    async clickRun() { clicked++; return { ok: true }; },
    async enter() { throw new Error('must never try Enter after Run'); },
    async shortcut() { throw new Error('must never try shortcut after Run'); }
  };
  const result = await submit.submitAiStudioPrompt({ tabId: 42, text: 'hello', ops, ...fast });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'run');
  assert.deepEqual(result.deliveryProof, { committed: true, signal: 'user-turn-or-generation-transition' });
  assert.equal(clicked, 1);
});

test('uncommitted Run stays uncertain and never retries Enter or shortcut', async () => {
  let clicks = 0, alternates = 0;
  const ops = {
    inspect: async () => ({ composerFound: true, runFound: true, userTurns: 2, lastUserText: 'previous', generating: false }),
    setPrompt: async () => ({ ok: true, value: 'hello' }),
    clickRun: async () => { clicks++; return { ok: true }; },
    enter: async () => { alternates++; return { ok: true }; },
    shortcut: async () => { alternates++; return { ok: true }; }
  };
  const result = await submit.submitAiStudioPrompt({ tabId: 42, text: 'hello', ops, ...fast });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROMPT_DELIVERY_UNCOMMITTED');
  assert.equal(clicks, 1);
  assert.equal(alternates, 0);
});

test('disabled/rejected Run does not fall through to another submission method', async () => {
  let run = 0, fallback = 0;
  const ops = {
    inspect: async () => ({ composerFound: true, runFound: true, runDisabled: true, userTurns: 2, generating: false }),
    setPrompt: async () => ({ ok: true, value: 'hello' }),
    clickRun: async () => { run++; return { ok: false, reason: 'run_disabled' }; },
    enter: async () => { fallback++; return { ok: true }; }
  };
  const result = await submit.submitAiStudioPrompt({ tabId: 42, text: 'hello', ops, ...fast });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROMPT_DELIVERY_UNCOMMITTED');
  assert.equal(run, 1);
  assert.equal(fallback, 0);
});

test('if Run never appears, a single Enter attempt is allowed without a second shortcut', async () => {
  let enter = 0, shortcut = 0;
  const ops = {
    inspect: async () => ({ composerFound: true, runFound: false, userTurns: enter ? 2 : 1,
      lastUserText: enter ? 'hello' : 'old', generating: false }),
    setPrompt: async () => ({ ok: true, value: 'hello' }),
    enter: async () => { enter++; return { ok: true }; },
    shortcut: async () => { shortcut++; return { ok: true }; }
  };
  const result = await submit.submitAiStudioPrompt({ tabId: 42, text: 'hello', ops, ...fast });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'enter');
  assert.equal(enter, 1);
  assert.equal(shortcut, 0);
});

test('welcome, consent or sign-in guard fires even when composer is absent; no setup clicks', async () => {
  let mutations = 0;
  const ops = {
    inspect: async () => ({ composerFound: false, blocker: 'first_run_welcome' }),
    setPrompt: async () => { mutations++; return { ok: true }; },
    clickRun: async () => { mutations++; return { ok: true }; }
  };
  const result = await submit.submitAiStudioPrompt({ tabId: 42, text: 'hello', ops, ...fast });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_SETUP_REQUIRED');
  assert.match(result.error, /complete setup manually/);
  assert.equal(mutations, 0);
});

test('setup appearing after prompt insertion blocks the only planned submit', async () => {
  let inserted = false, clicks = 0;
  const ops = {
    inspect: async () => ({ composerFound: true, runFound: true, blocker: inserted ? 'setup_required' : '',
      userTurns: 1, generating: false }),
    setPrompt: async () => { inserted = true; return { ok: true, value: 'hello' }; },
    clickRun: async () => { clicks++; return { ok: true }; }
  };
  const result = await submit.submitAiStudioPrompt({ tabId: 42, text: 'hello', ops, ...fast });
  assert.equal(result.code, 'PROVIDER_SETUP_REQUIRED');
  assert.equal(clicks, 0);
});

test('in-flight generation finishes before the next prompt is inserted', async () => {
  let inspections = 0, clicked = 0, inserts = 0;
  const ops = {
    inspect: async () => {
      inspections++;
      return { composerFound: true, runFound: true, userTurns: clicked ? 3 : 2,
        lastUserText: clicked ? 'next prompt' : 'old',
        generating: !clicked && inspections === 1 };
    },
    setPrompt: async () => { inserts++; return { ok: true, value: 'next prompt' }; },
    clickRun: async () => { clicked++; return { ok: true }; }
  };
  const result = await submit.submitAiStudioPrompt({ tabId: 42, text: 'next prompt', ops,
    ...fast, waitGeneratingTimeoutMs: 10 });
  assert.equal(result.ok, true);
  assert.equal(inspections >= 3, true);
  assert.equal(inserts, 1);
  assert.equal(clicked, 1);
});

test('MAIN-world inspection remains scoped to the authorized tab', async () => {
  let injection;
  await submit.inspectAiStudio(42, {
    executeScript: async (options) => {
      injection = options;
      return [{ result: { composerFound: false } }];
    }
  });
  assert.equal(injection.target.tabId, 42);
  assert.equal(injection.world, 'MAIN');
});

test('legacy keep-active shim is intentionally inert; no focus, visibility or worker spoofing', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'gemini-studio-submit.js'), 'utf8');
  assert.equal(await submit.ensureAiStudioActive(42, { executeScript: async () => { throw new Error('unexpected script'); } }), false);
  assert.doesNotMatch(source, /__browserAiBridgeKeepActive|Object\.defineProperty\(document, 'visibilityState'|new Worker\(/);
  assert.doesNotMatch(source, /composer\.focus\(\)|run\.removeAttribute\?\.\('disabled'\)/);
});

test('service worker routes AI Studio through exactly one unfocused window transaction', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'extension', 'service-worker.js'), 'utf8');
  assert.match(worker, /withAiStudioSubmissionWindow\(tab/);
  assert.match(worker, /const baseline = await sampleAiStudioTab\(tab\.id\)/);
  assert.match(worker, /submitted\?\.deliveryProof\?\.committed !== true/);
  assert.match(worker, /startAiStudioResponsePoll/);
  assert.doesNotMatch(worker, /minimizeOnFinish: false/);
});

test('expired polling budget still inspects once, proves one committed Run, and never tries a fallback', async () => {
  let inspected = 0, clicked = 0, alternates = 0;
  const ops = {
    inspect: async () => {
      inspected++;
      return { composerFound: true, runFound: true, userTurns: clicked ? 2 : 1,
        lastUserText: clicked ? 'hello' : 'previous', generating: false };
    },
    setPrompt: async (text) => ({ ok: true, value: text }),
    clickRun: async () => { clicked++; return { ok: true }; },
    enter: async () => { alternates++; return { ok: true }; },
    shortcut: async () => { alternates++; return { ok: true }; }
  };
  const result = await submit.submitAiStudioPrompt({
    tabId: 42, text: 'hello', ops, delay: async () => {},
    composerTimeoutMs: 0, runTimeoutMs: 0, verifyTimeoutMs: 0
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'run');
  assert.equal(clicked, 1);
  assert.equal(alternates, 0);
  assert.equal(inspected, 3);
});