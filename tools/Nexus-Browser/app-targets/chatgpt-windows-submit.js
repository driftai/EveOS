'use strict';

const { normalizeCandidate } = require('./chatgpt-windows-uia');

function createSubmitter({ runner, inspect, recoverComposer, recoverSend, sleepFn,
  wallNow = () => Date.now() } = {}) {
  return async function stageAndSubmit(text, baselineSnapshot) {
    const timing = {};
    let started = wallNow();
    let selector = baselineSnapshot.composerSelector;
    if (!selector) selector = await recoverComposer(baselineSnapshot);
    timing.composerResolveMs = Math.max(0, wallNow() - started);
    if (!selector) {
      const error = new Error('ChatGPT app composer was not found in the UI Automation tree.');
      error.code = 'APP_COMPOSER_NOT_FOUND';
      error.detail = { composerCandidates: baselineSnapshot.composerCandidates || [] };
      throw error;
    }
    const hwnd = String(baselineSnapshot.hwnd);
    const setValue = (candidate) => runner.runJson(
      ['ui', 'set-value', candidate, String(text), '-w', hwnd],
      { allowFailure: true, timeoutMs: 12000 }
    );
    started = wallNow();
    let staged = await setValue(selector);
    if (!staged.ok) {
      const recovered = await recoverComposer(baselineSnapshot);
      if (recovered && recovered !== selector) {
        selector = recovered;
        staged = await setValue(selector);
      }
    }
    if (!staged.ok) {
      const focused = await runner.runJson(
        ['ui', 'focus', selector, '-w', hwnd],
        { allowFailure: true, timeoutMs: 10000 }
      );
      if (focused.ok) {
        staged = await runner.runJson(
          ['ui', 'send-keys', String(text), '--verbatim', '--target', selector,
            '--via', 'send-input', '-w', hwnd],
          { allowFailure: true, timeoutMs: 20000 }
        );
      }
    }
    timing.textStageMs = Math.max(0, wallNow() - started);
    if (!staged.ok) {
      const error = new Error('ChatGPT app composer rejected programmatic text entry.');
      error.code = 'APP_INPUT_FAILED';
      error.detail = staged.json || staged.stderr || null;
      throw error;
    }
    started = wallNow();
    const stagedSnapshot = await inspect({
      hwnd: baselineSnapshot.hwnd,
      pid: baselineSnapshot.pid,
      title: baselineSnapshot.title
    });
    timing.stagedInspectMs = Math.max(0, wallNow() - started);
    let sendSelector = stagedSnapshot.sendSelector;
    if (!sendSelector) {
      sendSelector = await recoverSend(stagedSnapshot,
        stagedSnapshot.composer || baselineSnapshot.composer);
    }
    started = wallNow();
    if (sendSelector) {
      const invoked = await runner.runJson(
        ['ui', 'invoke', sendSelector, '--action', 'invoke', '-w', hwnd],
        { allowFailure: true, timeoutMs: 10000 }
      );
      if (!invoked.ok) {
        const error = new Error('ChatGPT app Send control could not be invoked.');
        error.code = 'APP_SEND_FAILED';
        error.detail = invoked.json || invoked.stderr || null;
        throw error;
      }
    } else {
      const currentComposer = stagedSnapshot.composerSelector || selector
        || await recoverComposer(stagedSnapshot);
      const focused = currentComposer
        ? await runner.runJson(
            ['ui', 'focus', currentComposer, '-w', hwnd],
            { allowFailure: true, timeoutMs: 10000 }
          )
        : { ok: false };
      if (!focused.ok) {
        const error = new Error('ChatGPT app Send control was not found and the composer could not be focused safely.');
        error.code = 'APP_SEND_CONTROL_NOT_FOUND';
        error.detail = {
          sendCandidates: stagedSnapshot.sendCandidates || [],
          composerCandidates: stagedSnapshot.composerCandidates || []
        };
        throw error;
      }
      const enter = await runner.runJson(
        ['ui', 'send-keys', 'enter', '--target', currentComposer,
          '--via', 'send-input', '-w', hwnd],
        { allowFailure: true, timeoutMs: 10000 }
      );
      if (!enter.ok) {
        const error = new Error('ChatGPT app has no invokable Send control and focused Enter fallback failed.');
        error.code = 'APP_SEND_FAILED';
        error.detail = enter.json || enter.stderr || null;
        throw error;
      }
    }
    timing.submitMs = Math.max(0, wallNow() - started);
    await sleepFn(80);
    started = wallNow();
    const committed = await inspect({
      hwnd: baselineSnapshot.hwnd,
      pid: baselineSnapshot.pid,
      title: baselineSnapshot.title
    });
    timing.acceptanceInspectMs = Math.max(0, wallNow() - started);
    const prompt = normalizeCandidate(text);
    const visiblePrompt = committed.texts.some((candidate) =>
      normalizeCandidate(candidate) === prompt);
    const committedComposer = normalizeCandidate(committed.composerValue);
    const composerCleared = !committedComposer
      || /^(?:Ask ChatGPT|Message ChatGPT|Do anything)$/i.test(committedComposer);
    if (!visiblePrompt && !composerCleared && !committed.generating) {
      const error = new Error('ChatGPT app input gesture was not confirmed by the app UI.');
      error.code = 'APP_PROMPT_UNCONFIRMED';
      error.detail = {
        composerSelector: committed.composerSelector || null,
        sendSelector: committed.sendSelector || null
      };
      throw error;
    }
    return { snapshot: committed, timing };
  };
}

module.exports = { createSubmitter };
