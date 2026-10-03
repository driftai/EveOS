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
  const accepted = visiblePrompt || composerCleared || snapshot.generating === true;
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
    const targetedEnter = (candidate) => runner.runJson(
      ['ui', 'send-keys', 'enter', '--target', candidate,
        '--via', 'send-input', '-w', hwnd],
      { allowFailure: true, timeoutMs: 10000 }
    );
    const inspectAcceptance = async () => {
      const inspectStartedAt = wallNow();
      const snapshot = await inspectBound();
      timing.acceptanceInspectMs = (timing.acceptanceInspectMs || 0)
        + Math.max(0, wallNow() - inspectStartedAt);
      return { snapshot, state: acceptanceState(snapshot, text) };
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
    const stagedSnapshot = await inspectBound();
    timing.stagedInspectMs = Math.max(0, wallNow() - started);
    let sendSelector = stagedSnapshot.sendSelector;
    if (!sendSelector) {
      sendSelector = await recoverSend(stagedSnapshot,
        stagedSnapshot.composer || baselineSnapshot.composer);
    }

    started = wallNow();
    let submitResult = null;
    let submitMode = 'invoke';
    let committed = null;

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
      const currentComposer = stagedSnapshot.composerSelector || selector
        || await recoverComposer(stagedSnapshot);
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
              sendCandidates: stagedSnapshot.sendCandidates || [],
              composerCandidates: stagedSnapshot.composerCandidates || [],
              definitelyNotAccepted: true
            };
            throw error;
          }
          submitMode = 'focused-enter-recovery';
          submitResult = await targetedEnter(currentComposer);
          if (!submitResult.ok) {
            await sleepFn(80);
            const retried = await inspectAcceptance();
            if (retried.state.accepted) {
              committed = retried.snapshot;
            } else {
              const error = new Error('ChatGPT app focused recovery submit was not confirmed; no further submit will be attempted.');
              error.code = retried.state.definitelyNotAccepted
                ? 'APP_SEND_FAILED'
                : 'APP_SUBMIT_UNCERTAIN';
              error.detail = {
                mutation: 'focused-enter-recovery',
                definitelyNotAccepted: retried.state.definitelyNotAccepted,
                result: submitResult.json || submitResult.stderr || null
              };
              throw error;
            }
          }
        }
      }
    }

    timing.submitMs = Math.max(0, wallNow() - started);
    timing.submitMode = submitMode;

    if (!committed) {
      await sleepFn(80);
      const checked = await inspectAcceptance();
      committed = checked.snapshot;
      if (!checked.state.accepted) {
        const error = new Error('ChatGPT app input gesture was not confirmed by the app UI.');
        error.code = checked.state.definitelyNotAccepted
          ? 'APP_PROMPT_UNCONFIRMED'
          : 'APP_SUBMIT_UNCERTAIN';
        error.detail = {
          composerSelector: committed.composerSelector || null,
          sendSelector: committed.sendSelector || null,
          mutation: submitMode,
          definitelyNotAccepted: checked.state.definitelyNotAccepted
        };
        throw error;
      }
    }

    return { snapshot: committed, timing };
  };
}

module.exports = { acceptanceState, createSubmitter };
