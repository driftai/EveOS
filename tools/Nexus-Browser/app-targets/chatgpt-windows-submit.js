'use strict';

const { normalizeCandidate } = require('./chatgpt-windows-uia');

function acceptanceState(snapshot = {}, text = '') {
  const prompt = normalizeCandidate(text);
  const texts = Array.isArray(snapshot.texts) ? snapshot.texts : [];
  const visiblePrompt = texts.some((candidate) => normalizeCandidate(candidate) === prompt);
  const composerValue = normalizeCandidate(snapshot.composerValue);
  const composerCleared = !composerValue
    || /^(?:Ask ChatGPT|Message ChatGPT|Do anything)$/i.test(composerValue);
  const composerStillPrompt = !!prompt && composerValue === prompt;
  // The rich editor is also exposed in snapshot.texts. Seeing the prompt there
  // is not acceptance while the exact same text is still in the composer.
  const accepted = composerCleared || snapshot.generating === true
    || (visiblePrompt && !composerStillPrompt);
  return {
    accepted,
    definitelyNotAccepted: !accepted && composerStillPrompt,
    visiblePrompt,
    composerCleared,
    composerStillPrompt,
    generating: snapshot.generating === true
  };
}

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
    const inspectBound = () => inspect({
      hwnd: baselineSnapshot.hwnd,
      pid: baselineSnapshot.pid,
      title: baselineSnapshot.title
    });
    const setValue = (candidate) => runner.runJson(
      ['ui', 'set-value', candidate, String(text), '-w', hwnd],
      { allowFailure: true, timeoutMs: 12000 }
    );
    const replaceWithKeyboard = async (candidate) => {
      const focused = await runner.runJson(
        ['ui', 'focus', candidate, '-w', hwnd],
        { allowFailure: true, timeoutMs: 10000 }
      );
      if (!focused.ok) return focused;
      const cleared = await runner.runJson(
        ['ui', 'send-keys', 'ctrl+a delete', '--target', candidate,
          '--via', 'send-input', '-w', hwnd],
        { allowFailure: true, timeoutMs: 10000 }
      );
      if (!cleared.ok) return cleared;
      const programmatic = await setValue(candidate);
      if (programmatic.ok) return programmatic;
      return runner.runJson(
        ['ui', 'send-keys', String(text), '--verbatim', '--target', candidate,
          '--via', 'send-input', '-w', hwnd],
        { allowFailure: true, timeoutMs: 20000 }
      );
    };
    const targetedEnter = (candidate, via = 'post-message') => runner.runJson(
      ['ui', 'send-keys', 'enter', '--target', candidate,
        '--via', via, '-w', hwnd],
      { allowFailure: true, timeoutMs: 10000 }
    );
    const inspectAcceptance = async () => {
      const inspectStartedAt = wallNow();
      const snapshot = await inspectBound();
      timing.acceptanceInspectMs = (timing.acceptanceInspectMs || 0)
        + Math.max(0, wallNow() - inspectStartedAt);
      return { snapshot, state: acceptanceState(snapshot, text) };
    };
    const focusedEnterRecovery = async (currentComposer, sourceSnapshot) => {
      const focusStartedAt = wallNow();
      const focused = await runner.runJson(
        ['ui', 'focus', currentComposer, '-w', hwnd],
        { allowFailure: true, timeoutMs: 10000 }
      );
      timing.focusRecoveryMs = Math.max(0, wallNow() - focusStartedAt);
      if (!focused.ok) {
        const error = new Error('ChatGPT app background submit failed and the composer could not be focused safely.');
        error.code = 'APP_SEND_CONTROL_NOT_FOUND';
        error.detail = {
          sendCandidates: sourceSnapshot.sendCandidates || [],
          composerCandidates: sourceSnapshot.composerCandidates || [],
          definitelyNotAccepted: true
        };
        throw error;
      }
      submitMode = 'focused-enter-recovery';
      const result = await targetedEnter(currentComposer, 'send-input');
      await sleepFn(80);
      const checked = await inspectAcceptance();
      if (!checked.state.accepted) {
        const error = new Error('ChatGPT app focused recovery submit was not confirmed; no further submit will be attempted.');
        error.code = checked.state.definitelyNotAccepted
          ? 'APP_SEND_FAILED'
          : 'APP_SUBMIT_UNCERTAIN';
        error.detail = {
          mutation: 'focused-enter-recovery',
          definitelyNotAccepted: checked.state.definitelyNotAccepted,
          result: result.json || result.stderr || null
        };
        throw error;
      }
      return checked.snapshot;
    };
    const backgroundEnterRecovery = async (currentComposer, sourceSnapshot) => {
      submitMode = 'post-message-enter-recovery';
      const result = await targetedEnter(currentComposer);
      await sleepFn(80);
      const checked = await inspectAcceptance();
      if (checked.state.accepted) return checked.snapshot;
      if (checked.state.definitelyNotAccepted) {
        return focusedEnterRecovery(currentComposer, sourceSnapshot);
      }
      const error = new Error('ChatGPT app background recovery submit may have occurred; refusing another mutation.');
      error.code = 'APP_SUBMIT_UNCERTAIN';
      error.detail = {
        mutation: 'post-message-enter-recovery',
        definitelyNotAccepted: false,
        result: result.json || result.stderr || null
      };
      throw error;
    };

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
      staged = await replaceWithKeyboard(selector);
    }
    timing.textStageMs = Math.max(0, wallNow() - started);
    if (!staged.ok) {
      const error = new Error('ChatGPT app composer rejected programmatic text entry.');
      error.code = 'APP_INPUT_FAILED';
      error.detail = staged.json || staged.stderr || null;
      throw error;
    }

    await sleepFn(80);
    started = wallNow();
    let stagedSnapshot = await inspectBound();
    timing.stagedInspectMs = Math.max(0, wallNow() - started);
    for (const delay of [250, 500, 1000, 1500, 2500]) {
      if (normalizeCandidate(stagedSnapshot.composerValue) === normalizeCandidate(text)) break;
      await sleepFn(delay);
      started = wallNow();
      stagedSnapshot = await inspectBound();
      timing.stagedInspectMs += Math.max(0, wallNow() - started);
    }
    if (normalizeCandidate(stagedSnapshot.composerValue) !== normalizeCandidate(text)) {
      const exactComposer = stagedSnapshot.composerSelector || selector
        || await recoverComposer(stagedSnapshot);
      started = wallNow();
      staged = exactComposer ? await replaceWithKeyboard(exactComposer) : { ok: false };
      timing.textStageMs += Math.max(0, wallNow() - started);
      if (!staged.ok) {
        const error = new Error('ChatGPT app composer could not replace its existing draft safely.');
        error.code = 'APP_INPUT_FAILED';
        throw error;
      }
      await sleepFn(180);
      started = wallNow();
      stagedSnapshot = await inspectBound();
      timing.stagedInspectMs += Math.max(0, wallNow() - started);
      if (normalizeCandidate(stagedSnapshot.composerValue) !== normalizeCandidate(text)) {
        started = wallNow();
        staged = await replaceWithKeyboard(exactComposer);
        timing.textStageMs += Math.max(0, wallNow() - started);
        if (!staged.ok) {
          const error = new Error('ChatGPT app composer could not retry exact draft replacement safely.');
          error.code = 'APP_INPUT_FAILED';
          throw error;
        }
        await sleepFn(250);
        started = wallNow();
        stagedSnapshot = await inspectBound();
        timing.stagedInspectMs += Math.max(0, wallNow() - started);
      }
      for (const delay of [500, 1000, 1500, 2500, 3500]) {
        if (normalizeCandidate(stagedSnapshot.composerValue) === normalizeCandidate(text)) break;
        await sleepFn(delay);
        started = wallNow();
        stagedSnapshot = await inspectBound();
        timing.stagedInspectMs += Math.max(0, wallNow() - started);
      }
      if (normalizeCandidate(stagedSnapshot.composerValue) !== normalizeCandidate(text)) {
        const error = new Error('ChatGPT app composer did not contain the exact requested prompt; nothing was submitted.');
        error.code = 'APP_INPUT_MISMATCH';
        error.detail = { composerSelector: stagedSnapshot.composerSelector || exactComposer };
        throw error;
      }
    }
    let sendSelector = stagedSnapshot.sendSelector;
    if (!sendSelector) {
      sendSelector = await recoverSend(stagedSnapshot,
        stagedSnapshot.composer || baselineSnapshot.composer);
    }

    started = wallNow();
    let submitResult = null;
    let submitMode = 'invoke';
    let committed = null;
    let currentComposer = stagedSnapshot.composerSelector || selector;

    if (sendSelector) {
      submitResult = await runner.runJson(
        ['ui', 'invoke', sendSelector, '--action', 'invoke', '-w', hwnd],
        { allowFailure: true, timeoutMs: 10000 }
      );
      if (!submitResult.ok) {
        await sleepFn(80);
        const checked = await inspectAcceptance();
        if (checked.state.accepted) {
          committed = checked.snapshot;
        } else if (checked.state.definitelyNotAccepted && currentComposer) {
          committed = await backgroundEnterRecovery(currentComposer, stagedSnapshot);
        } else {
          const error = new Error('ChatGPT app Send control invocation failed without confirmed acceptance.');
          error.code = checked.state.definitelyNotAccepted
            ? 'APP_SEND_FAILED'
            : 'APP_SUBMIT_UNCERTAIN';
          error.detail = {
            mutation: 'invoke',
            definitelyNotAccepted: checked.state.definitelyNotAccepted,
            result: submitResult.json || submitResult.stderr || null
          };
          throw error;
        }
      }
    } else {
      currentComposer ||= await recoverComposer(stagedSnapshot);
      if (!currentComposer) {
        const error = new Error('ChatGPT app Send control and exact composer target were unavailable.');
        error.code = 'APP_SEND_CONTROL_NOT_FOUND';
        error.detail = {
          sendCandidates: stagedSnapshot.sendCandidates || [],
          composerCandidates: stagedSnapshot.composerCandidates || []
        };
        throw error;
      }

      // Prefer the exact HWND/selector without changing foreground focus. This keeps
      // Nexus sends stable while the user is actively clicking in another app.
      submitMode = 'targeted-enter';
      submitResult = await targetedEnter(currentComposer);
      if (!submitResult.ok) {
        await sleepFn(80);
        const checked = await inspectAcceptance();
        if (checked.state.accepted) {
          committed = checked.snapshot;
        } else if (!checked.state.definitelyNotAccepted) {
          const error = new Error('ChatGPT app submit may have occurred; refusing to repeat the mutation.');
          error.code = 'APP_SUBMIT_UNCERTAIN';
          error.detail = {
            mutation: 'targeted-enter',
            definitelyNotAccepted: false,
            result: submitResult.json || submitResult.stderr || null
          };
          throw error;
        } else {
          // A retry is safe only after read-only evidence proves the exact prompt is
          // still in the composer and no prompt/generation acceptance signal exists.
          committed = await focusedEnterRecovery(currentComposer, stagedSnapshot);
        }
      }
    }

    if (!committed) {
      await sleepFn(80);
      const checked = await inspectAcceptance();
      committed = checked.snapshot;
      if (!checked.state.accepted && checked.state.definitelyNotAccepted
          && currentComposer && submitMode === 'invoke') {
        committed = await backgroundEnterRecovery(currentComposer, stagedSnapshot);
      } else if (!checked.state.accepted && checked.state.definitelyNotAccepted
          && currentComposer && submitMode === 'targeted-enter') {
        committed = await focusedEnterRecovery(currentComposer, stagedSnapshot);
      }
      const accepted = acceptanceState(committed, text);
      if (!accepted.accepted) {
        const error = new Error('ChatGPT app input gesture was not confirmed by the app UI.');
        error.code = accepted.definitelyNotAccepted
          ? 'APP_PROMPT_UNCONFIRMED'
          : 'APP_SUBMIT_UNCERTAIN';
        error.detail = {
          composerSelector: committed.composerSelector || null,
          sendSelector: committed.sendSelector || null,
          mutation: submitMode,
          definitelyNotAccepted: accepted.definitelyNotAccepted
        };
        throw error;
      }
    }

    timing.submitMs = Math.max(0, wallNow() - started);
    timing.submitMode = submitMode;
    return { snapshot: committed, timing };
  };
}

module.exports = { acceptanceState, createSubmitter };
