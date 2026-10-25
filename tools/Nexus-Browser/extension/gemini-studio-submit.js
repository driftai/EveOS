(() => {
  const COMPOSER_SELECTORS = [
    '.testing-request textarea[aria-label="Type something"]',
    'textarea[aria-label="Type something"]',
    '#chat-input-field',
    'ms-prompt-box textarea[aria-label="Enter a prompt"]',
    'textarea[aria-label="Enter a prompt"]',
    'ms-prompt-box ms-autosize-textarea textarea',
    'ms-prompt-box textarea',
    'ms-autosize-textarea textarea'
  ];

  const RUN_SELECTORS = [
    '.testing-request button.run-button[aria-label="Run"]',
    'ms-prompt-box button.run-button[aria-label="Run"]',
    'button.run-button[aria-label="Run"]',
    'ms-prompt-box ms-run-button button[aria-label="Run"]',
    'ms-run-button button[aria-label="Run"]',
    'button[aria-label="Run"]',
    'button.run-button',
    'ms-run-button button'
  ];

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalized(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function submissionObserved(snapshot, text, baselineUserTurns, wasGenerating = false) {
    if (!snapshot) return false;
    const expected = normalized(text);
    const latest = normalized(snapshot.lastUserText);
    const matchingTurn = !!expected && !!latest && (latest === expected || latest.endsWith(expected));
    const userAdvanced = Number(snapshot.userTurns || 0) > Number(baselineUserTurns || 0);
    const startedGenerating = !wasGenerating && !!snapshot.generating;
    return userAdvanced ? matchingTurn : startedGenerating;
  }

  async function executeMain(tabId, func, args = [], scriptingApi = globalThis.chrome?.scripting) {
    if (!scriptingApi?.executeScript) throw new Error('Chrome scripting API is unavailable.');
    const [execution] = await scriptingApi.executeScript({
      target: { tabId },
      world: 'MAIN',
      func,
      args
    });
    return execution?.result ?? null;
  }

  // No visibility/focus spoofing or worker-driven animation clock.
  async function ensureAiStudioActive() { return false; }

  async function inspectAiStudio(tabId, scriptingApi = globalThis.chrome?.scripting) {
    return executeMain(tabId, (composerSelectors, runSelectors) => {
      const composer = composerSelectors
        .map((selector) => document.querySelector(selector))
        .find((node) => node && !node.disabled) || null;
      const scope = composer?.closest?.('.testing-request, ms-prompt-box, form') || document;
      const run = runSelectors
        .map((selector) => scope.querySelector?.(selector) || document.querySelector(selector))
        .find(Boolean) || null;
      const scopeButtons = [...scope.querySelectorAll('ms-run-button button, button.run-button, button[aria-label]')];
      const stop = scopeButtons.find((button) => {
        const aria = String(button.getAttribute?.('aria-label') || '').toLowerCase();
        return /stop|cancel/i.test(aria) && !/\brun\b/.test(aria);
      });
      const welcome = document.querySelector('ms-g1-welcome-dialog');
      const welcomeVisible = !!welcome && (() => {
        const style = getComputedStyle(welcome);
        return welcome.hidden !== true && welcome.getAttribute?.('aria-hidden') !== 'true'
          && style.display !== 'none' && style.visibility !== 'hidden';
      })();
      const userTurnNodes = [...document.querySelectorAll('ms-chat-turn')].filter((turn) => {
        const role = String(turn.getAttribute?.('data-turn-role') || '').toLowerCase();
        return role === 'user'
          || !!turn.querySelector?.('[data-turn-role="User"], [data-turn-role="user"], .chat-turn-container.user')
          || String(turn.className || '').toLowerCase().includes('user');
      });
      const userTurns = userTurnNodes.length;
      const lastUserTurn = userTurnNodes[userTurnNodes.length - 1];
      const lastUserText = String(lastUserTurn?.querySelector?.('.turn-content, [data-turn-role="User"], [data-turn-role="user"]')?.textContent || lastUserTurn?.textContent || '').replace(/^User\s*\d{1,2}:\d{2}\s*(?:AM|PM)?\s*/i, '').trim();
      const blockingDialog = [...document.querySelectorAll('dialog, [role="dialog"]')].some((dialog) => {
        const style = getComputedStyle(dialog);
        if (dialog.hidden || dialog.getAttribute?.('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
        const description = String(dialog.getAttribute?.('aria-label') || '') + ' ' + String(dialog.textContent || '');
        return /sign in|log in|consent|welcome|agree to|accept terms|choose an account|first.run/i.test(description.slice(0, 1500));
      });
      return {
        composerFound: !!composer,
        value: String(composer?.value || ''),
        runFound: !!run,
        runDisabled: !!run?.disabled || run?.getAttribute?.('aria-disabled') === 'true',
        userTurns,
        lastUserText,
        generating: !!stop,
        blocker: welcomeVisible ? 'first_run_welcome' : blockingDialog ? 'setup_required' : ''
      };
    }, [COMPOSER_SELECTORS, RUN_SELECTORS], scriptingApi);
  }

  async function setAiStudioPrompt(tabId, text, scriptingApi = globalThis.chrome?.scripting) {
    return executeMain(tabId, (composerSelectors, value) => {
      const composer = composerSelectors
        .map((selector) => document.querySelector(selector))
        .find((node) => node && !node.disabled) || null;
      if (!composer) return { ok: false, reason: 'composer_missing' };
      // AI Studio's Angular form state currently reacts most consistently when the real
      // textarea value is updated and then receives plain input/change events.
      try { composer.value = value; }
      catch {
        const proto = Object.getPrototypeOf(composer);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
          || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(composer, value);
      }
      try { composer.dispatchEvent(new Event('input', { bubbles: true, cancelable: true })); } catch {}
      try { composer.dispatchEvent(new Event('change', { bubbles: true, cancelable: true })); } catch {}
      return { ok: true, value: String(composer.value || '') };
    }, [COMPOSER_SELECTORS, text], scriptingApi);
  }

  async function clickAiStudioRun(tabId, scriptingApi = globalThis.chrome?.scripting) {
    return executeMain(tabId, async (composerSelectors, runSelectors) => {
      const composer = composerSelectors
        .map((selector) => document.querySelector(selector))
        .find((node) => node && !node.disabled) || null;
      const scope = composer?.closest?.('.testing-request, ms-prompt-box, form') || document;
      const run = runSelectors
        .map((selector) => scope.querySelector?.(selector) || document.querySelector(selector))
        .find(Boolean) || null;
      if (!run) return { ok: false, reason: 'run_missing' };

      try {
        // Refresh Angular form state without activating a browser window.
        if (composer) {
          composer.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          composer.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        }
        await new Promise((resolve) => setTimeout(resolve, 180));
        if (run.disabled || run.getAttribute?.('aria-disabled') === 'true') return { ok: false, reason: 'run_disabled' };
        // Exactly one invocation; don't synthesize an extra pointer click.
        run.click();
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error?.message || 'run_click_failed' };
      }
    }, [COMPOSER_SELECTORS, RUN_SELECTORS], scriptingApi);
  }

  async function shortcutAiStudioSubmit(tabId, scriptingApi = globalThis.chrome?.scripting, modified = false) {
    return executeMain(tabId, (composerSelectors, useModifiedShortcut) => {
      const composer = composerSelectors
        .map((selector) => document.querySelector(selector))
        .find((node) => node && !node.disabled) || null;
      if (!composer) return { ok: false, reason: 'composer_missing' };
      const isMac = /mac|iphone|ipad|ipod/i.test(String(navigator.platform || navigator.userAgent || ''));
      const options = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        ctrlKey: useModifiedShortcut && !isMac,
        metaKey: useModifiedShortcut && isMac,
        bubbles: true,
        cancelable: true,
        composed: true
      };
      composer.dispatchEvent(new KeyboardEvent('keydown', options));
      composer.dispatchEvent(new KeyboardEvent('keypress', options));
      composer.dispatchEvent(new KeyboardEvent('keyup', options));
      return { ok: true };
    }, [COMPOSER_SELECTORS, modified], scriptingApi);
  }

  function createDefaultOps(tabId, scriptingApi) {
    return {
      inspect: () => inspectAiStudio(tabId, scriptingApi),
      setPrompt: (text) => setAiStudioPrompt(tabId, text, scriptingApi),
      clickRun: () => clickAiStudioRun(tabId, scriptingApi),
      enter: () => shortcutAiStudioSubmit(tabId, scriptingApi, false),
      shortcut: () => shortcutAiStudioSubmit(tabId, scriptingApi, true)
    };
  }

  async function waitFor(predicate, { timeoutMs, intervalMs, delay = sleep }) {
    const started = Date.now();
    let last = null;
    let firstProbe = true;
    while (firstProbe || Date.now() - started < timeoutMs) {
      firstProbe = false;
      last = await predicate();
      if (last?.ok) return last.value;
      await delay(intervalMs);
    }
    return last?.value ?? null;
  }

  async function verifyAfter(runtime, baselineUserTurns, text, timeoutMs, delay, wasGenerating = false) {
    const observed = await waitFor(async () => {
      const snapshot = await runtime.inspect();
      return {
        ok: !!snapshot?.blocker || submissionObserved(snapshot, text, baselineUserTurns, wasGenerating),
        value: snapshot
      };
    }, { timeoutMs, intervalMs: 120, delay });
    return {
      committed: submissionObserved(observed, text, baselineUserTurns, wasGenerating),
      blocker: observed?.blocker || ''
    };
  }

  function setupRequired() {
    return { ok: false, code: 'PROVIDER_SETUP_REQUIRED', error: 'Google AI Studio is blocked by sign-in, consent, or its first-run welcome screen. Open the tab and complete setup manually before retrying.' };
  }

  async function submitAiStudioPrompt({
    tabId,
    text,
    scriptingApi = globalThis.chrome?.scripting,
    ops = null,
    delay = sleep,
    composerTimeoutMs = 12000,
    waitGeneratingTimeoutMs = 15000,
    runTimeoutMs = 5000,
    verifyTimeoutMs = 5000
  }) {
    const runtime = ops || createDefaultOps(tabId, scriptingApi);
    const initial = await waitFor(async () => {
      const snapshot = await runtime.inspect();
      return { ok: !!snapshot?.composerFound || !!snapshot?.blocker, value: snapshot };
    }, { timeoutMs: composerTimeoutMs, intervalMs: 150, delay });
    if (initial?.blocker) return setupRequired();
    if (!initial?.composerFound) {
      return { ok: false, code: 'PROMPT_DELIVERY_UNCOMMITTED', error: 'Google AI Studio composer did not become ready in the bridge popup.' };
    }

    let readySnapshot = initial;
    if (initial.generating) {
      readySnapshot = await waitFor(async () => {
        const snapshot = await runtime.inspect();
        return { ok: !!snapshot?.blocker || (!!snapshot?.runFound && !snapshot?.generating), value: snapshot };
      }, { timeoutMs: waitGeneratingTimeoutMs, intervalMs: 250, delay });
      if (readySnapshot?.blocker) return setupRequired();
      if (!readySnapshot?.runFound || readySnapshot?.generating) {
        return { ok: false, code: 'PROMPT_DELIVERY_UNCOMMITTED', error: 'Google AI Studio is still busy generating the previous prompt.' };
      }
    }

    const baselineUserTurns = Number(readySnapshot.userTurns || 0);
    const wasGenerating = !!readySnapshot.generating;
    const inserted = await runtime.setPrompt(text);
    if (!inserted?.ok || (typeof inserted.value === 'string' && normalized(inserted.value) !== normalized(text))) {
      return { ok: false, code: 'PROMPT_DELIVERY_UNCOMMITTED', error: 'Google AI Studio composer rejected the prompt text.' };
    }

    const runnable = await waitFor(async () => {
      const snapshot = await runtime.inspect();
      return { ok: !!snapshot?.blocker || !!snapshot?.runFound, value: snapshot };
    }, { timeoutMs: runTimeoutMs, intervalMs: 120, delay });
    if (runnable?.blocker) return setupRequired();
    if (runnable?.generating && !wasGenerating) {
      return { ok: false, code: 'PROMPT_DELIVERY_UNCOMMITTED', error: 'AI Studio began another generation before Nexus submitted; no additional click was made.' };
    }
    // Select exactly one submission mechanism. A click reporting success is NOT a
    // delivery receipt; waiting for proof must never trigger a fallback attempt.
    let attempt, method;
    if (runnable?.runFound) {
      method = 'run';
      attempt = await runtime.clickRun();
    } else if (runtime.enter) {
      method = 'enter';
      attempt = await runtime.enter();
    } else if (runtime.shortcut) {
      method = 'shortcut';
      attempt = await runtime.shortcut();
    } else {
      return { ok: false, code: 'PROMPT_DELIVERY_UNCOMMITTED', error: 'AI Studio has no available submission control.' };
    }
    if (!attempt?.ok) {
      return { ok: false, code: 'PROMPT_DELIVERY_UNCOMMITTED', error: 'AI Studio ' + method + ' control did not dispatch (' + (attempt?.reason || 'unknown') + ').' };
    }
    const evidence = await verifyAfter(runtime, baselineUserTurns, text, verifyTimeoutMs, delay, wasGenerating);
    if (evidence.blocker) return setupRequired();
    if (evidence.committed) return { ok: true, method, deliveryProof: { committed: true, signal: 'user-turn-or-generation-transition' } };
    return {
      ok: false, code: 'PROMPT_DELIVERY_UNCOMMITTED',
      error: 'AI Studio submission is uncommitted/uncertain; no retry or alternate shortcut was attempted.'
    };
  }

  const api = {
    COMPOSER_SELECTORS,
    RUN_SELECTORS,
    normalized,
    submissionObserved,
    executeMain,
    ensureAiStudioActive,
    inspectAiStudio,
    setAiStudioPrompt,
    clickAiStudioRun,
    shortcutAiStudioSubmit,
    submitAiStudioPrompt
  };

  if (typeof globalThis !== 'undefined') globalThis.BrowserAiBridgeGeminiStudioSubmit = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
