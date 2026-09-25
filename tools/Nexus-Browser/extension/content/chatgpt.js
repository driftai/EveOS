(() => {
  if (typeof window !== 'undefined' && globalThis.__browserAiBridgeChatGptLoaded) return;
  if (typeof window !== 'undefined') globalThis.__browserAiBridgeChatGptLoaded = true;

  const input = globalThis.BrowserAiBridgeChatGptInput
    || (typeof module !== 'undefined' && module.exports ? require('./chatgpt-input.js') : null);
  const answer = globalThis.BrowserAiBridgeChatGptAnswer
    || (typeof module !== 'undefined' && module.exports ? require('./chatgpt-answer.js') : null);
  const deadline = globalThis.BrowserAiBridgeResponseDeadline
    || (typeof module !== 'undefined' && module.exports ? require('./response-deadline.js') : null);
  const pageState = globalThis.BrowserAiBridgeChatGptPageState
    || (typeof module !== 'undefined' && module.exports ? require('./chatgpt-page-state.js') : null);

  if (!input || !answer || !deadline || !pageState) throw new Error('ChatGPT bridge modules were not loaded in the expected order.');

  const { DEFAULT_RESPONSE_DEADLINES, nextResponseDeadline, minutes } = deadline;
  const active = new Map();
  const RELIABLE_GENERATION_SETTLE_MS = 1500;
  const STATUS_SIGNAL_SETTLE_MS = 3000;
  const NO_SIGNAL_SETTLE_MS = 5000;
  const INCOMPLETE_NO_SIGNAL_SETTLE_MS = 60000;
  const SUBMIT_ATTEMPT_SETTLE_MS = 600;
  const SUBMIT_FINAL_SETTLE_MS = 1200;
  const DEX_CONTROL_SEND_WAIT_MS = 12000, GENERATION_HEARTBEAT_MS = 15000;
  const { transientStatusLine, substantiveAssistantText } = pageState;

  const { looksCompleteAssistantText, obviouslyPartialAssistantText } = pageState;
  const generationSettleMs = (options) => pageState.generationSettleMs(options, {
    RELIABLE_GENERATION_SETTLE_MS, STATUS_SIGNAL_SETTLE_MS, INCOMPLETE_NO_SIGNAL_SETTLE_MS
  });
  const returnApi = globalThis.BrowserAiBridgeChatGptReturn
    || (typeof module !== 'undefined' && module.exports ? require('./chatgpt-return.js') : null);
  if (!returnApi) throw new Error('ChatGPT return capture helper missing.');

  function emit(payload) {
    try { return chrome.runtime.sendMessage(payload); } catch { return null; }
  }

  function stopWatcher(requestId) {
    const watcher = active.get(requestId);
    if (!watcher) return;
    watcher.observer?.disconnect();
    clearInterval(watcher.timer);
    clearTimeout(watcher.timeout);
    active.delete(requestId);
  }

  function reportGenerationActivity(watcher, requestId, isGenerating, force = false) {
    const stamp = Date.now();
    const state = isGenerating ? 'active' : 'idle';
    if (isGenerating) {
      if (!force && watcher.lastGenerationState === 'active'
          && stamp - watcher.lastHeartbeatAt < GENERATION_HEARTBEAT_MS) return;
    } else if (!force && watcher.lastGenerationState !== 'active') {
      return;
    }
    watcher.lastGenerationState = state;
    watcher.lastHeartbeatAt = stamp;
    emit({ type: 'response_activity', requestId, isGenerating, generationState: state, observedAt: stamp });
  }

  function watchResponse(requestId, baseline) {
    const watcher = {
      baselineCount: baseline.count,
      assistantBaseline: baseline.assistantBaseline || null,
      promptCommitted: false,
      finalPending: false,
      baselineText: baseline.text,
      baselineIssues: baseline.issues || new Map(),
      userBaselineCount: Number(baseline.userCount || 0), prompt: String(baseline.prompt || ''),
      lastText: '',
      lastChangedAt: Date.now(),
      startedAt: Date.now(),
      started: false,
      sawGenerating: false,
      sawReliableGenerating: false,
      generatingEndedAt: 0,
      issueFingerprint: null,
      issueSince: 0,
      lastIssue: null,
      lastHeartbeatAt: 0,
      lastGenerationState: 'unknown',
      observer: null,
      timer: null,
      timeout: null
    };

    function finalize({ allowUnpunctuated = false } = {}) {
      const anchored = answer.responseTextForUserPrompt(watcher.prompt, watcher.userBaselineCount);
      const current = substantiveAssistantText(anchored || (watcher.promptCommitted
        ? returnApi.freshReply(answer, watcher.assistantBaseline) : ''));
      const finalText = current || watcher.lastText;
      if (returnApi.trailingReturn(finalText) && !returnApi.exactReturn(finalText, requestId)) return false;
      if (!finalText || (!looksCompleteAssistantText(finalText) && (!allowUnpunctuated || obviouslyPartialAssistantText(finalText)))) return false;
      if (allowUnpunctuated && finalText !== watcher.lastText) { watcher.lastText = finalText; watcher.lastChangedAt = Date.now(); return false; }
      if (watcher.finalPending) return false;
      const observedAt = Date.now();
      watcher.finalPending = true;
      const result = emit({ type: 'response_final', requestId, text: finalText, observedAt, detail: {
        adapterSettleMs: Math.max(0, observedAt - (watcher.generatingEndedAt || watcher.lastChangedAt)),
        stableForMs: Math.max(0, observedAt - watcher.lastChangedAt), reliableGeneration: watcher.sawReliableGenerating,
        returnRequested: returnApi.exactReturn(finalText, requestId)
      } });
      if (result?.then) result.then((receipt) => {
        if (receipt?.ok === true) stopWatcher(requestId);
        else watcher.finalPending = false;
      }).catch(() => { watcher.finalPending = false; });
      else stopWatcher(requestId);
      return true;
    }

    function emitProviderIssue(issue) {
      const observedForMs = watcher.issueSince ? Date.now() - watcher.issueSince : 0;
      emit({
        type: 'adapter_error',
        requestId,
        code: issue.code || 'CHATGPT_PROVIDER_ERROR',
        message: issue.message || issue.providerText || 'ChatGPT reported an error.',
        detail: {
          category: issue.category || 'provider',
          providerText: issue.providerText || '',
          retryable: !!issue.retryable,
          rebindRecommended: !!issue.rebindRecommended,
          transient: !issue.terminal,
          observedForMs,
          elapsedMs: Date.now() - watcher.startedAt
        }
      });
      stopWatcher(requestId);
    }

    function providerIssueBlocksFinalization() {
      const issue = pageState.findChangedIssue(watcher.baselineIssues);
      if (!issue) {
        if (watcher.issueFingerprint) {
          watcher.issueFingerprint = null;
          watcher.issueSince = 0;
          watcher.lastIssue = null;
          watcher.lastChangedAt = Date.now();
          watcher.generatingEndedAt = 0;
        }
        return false;
      }

      const now = Date.now();
      if (issue.fingerprint !== watcher.issueFingerprint) {
        watcher.issueFingerprint = issue.fingerprint;
        watcher.issueSince = now;
      }
      watcher.lastIssue = issue;
      const graceMs = Number.isFinite(issue.graceMs) ? issue.graceMs : 0;
      if (issue.terminal || now - watcher.issueSince >= graceMs) {
        emitProviderIssue(issue);
      }
      return true;
    }

    function sample() {
      if (watcher.finalPending) return;
      const reportedGenerating = input.generationLooksActive();
      if (reportedGenerating) {
        watcher.sawGenerating = true;
        watcher.sawReliableGenerating = true;
        watcher.generatingEndedAt = 0;
      }

      if (providerIssueBlocksFinalization()) return;

      const anchored = answer.responseTextForUserPrompt(watcher.prompt, watcher.userBaselineCount);
      const rawText = anchored || (watcher.promptCommitted
        ? returnApi.freshReply(answer, watcher.assistantBaseline) : '');
      const text = substantiveAssistantText(rawText);
      if (returnApi.trailingReturn(text) && !returnApi.exactReturn(text, requestId)) return;
      const transientOnly = !!String(rawText || '').trim() && !text;
      // Status-only text belongs to the current prompt: it is visible work,
      // even when ChatGPT's stop-button generation signal is temporarily absent.
      reportGenerationActivity(watcher, requestId, reportedGenerating || transientOnly);
      if (transientOnly) {
        watcher.sawGenerating = true;
        watcher.generatingEndedAt = 0;
        return;
      }
      if (!reportedGenerating && watcher.sawGenerating && !watcher.generatingEndedAt) {
        watcher.generatingEndedAt = Date.now();
        reportGenerationActivity(watcher, requestId, false, true);
      }

      if (!text) return;

      watcher.started = true;
      if (text !== watcher.lastText) {
        watcher.lastText = text;
        watcher.lastChangedAt = Date.now();
        emit({ type: 'response_partial', requestId, text });
        return;
      }

      if (reportedGenerating || obviouslyPartialAssistantText(watcher.lastText)) return;
      const now = Date.now();
      if (returnApi.exactReturn(watcher.lastText, requestId)
          && now - watcher.lastChangedAt >= RELIABLE_GENERATION_SETTLE_MS) {
        finalize(); return;
      }
      const stableFor = now - watcher.lastChangedAt;
      if (watcher.sawGenerating) {
        const settleMs = generationSettleMs({
          sawReliableGenerating: watcher.sawReliableGenerating,
          text: watcher.lastText
        });
        if (
          watcher.generatingEndedAt
          && now - watcher.generatingEndedAt >= settleMs
          && stableFor >= settleMs
        ) finalize({ allowUnpunctuated: !looksCompleteAssistantText(watcher.lastText) });
        return;
      }
      const settleMs = looksCompleteAssistantText(watcher.lastText)
        ? NO_SIGNAL_SETTLE_MS
        : INCOMPLETE_NO_SIGNAL_SETTLE_MS;
      if (stableFor >= settleMs) finalize({ allowUnpunctuated: !looksCompleteAssistantText(watcher.lastText) });
    }

    function handleDeadline() {
      const decision = nextResponseDeadline({
        startedAt: watcher.startedAt,
        isGenerating: input.generationLooksActive() || (watcher.lastGenerationState === 'active'
          && Date.now() - watcher.lastHeartbeatAt < 60000),
        hasText: !!watcher.lastText
      });
      if (decision.action === 'wait') {
        watcher.timeout = setTimeout(handleDeadline, decision.delayMs);
        return;
      }
      if (decision.action === 'finalize') {
        sample();
        if (active.has(requestId)) watcher.timeout = setTimeout(handleDeadline, 15000);
        return;
      }
      if (watcher.lastIssue) {
        emitProviderIssue(watcher.lastIssue);
        return;
      }
      const generating = input.generationLooksActive();
      if (generating) reportGenerationActivity(watcher, requestId, true, true);
      watcher.timeout = setTimeout(handleDeadline, 30000);
    }

    watcher.observer = new MutationObserver(sample);
    watcher.observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-busy', 'data-testid', 'role', 'aria-live']
    });
    watcher.timer = setInterval(sample, 350);
    watcher.timeout = setTimeout(handleDeadline, DEFAULT_RESPONSE_DEADLINES.idleTimeoutMs);
    active.set(requestId, watcher);
    return watcher;
  }

  const dispatchComposerEnter = input.dispatchComposerEnter;

  async function waitForComposerText(composer, text, timeoutMs = 900) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (input.composerContainsText(composer, text)) return true;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return input.composerContainsText(composer, text);
  }

  async function waitForPromptDeparture(composer, text, timeoutMs = SUBMIT_ATTEMPT_SETTLE_MS, isCommitted = null) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!input.composerContainsText(composer, text) || isCommitted?.()) return true;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return !input.composerContainsText(composer, text) || !!isCommitted?.();
  }
  async function waitForSendControl(composer, timeoutMs = 2000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const control = input.findSendControl(composer);
      if (control) return control;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return input.findSendControl(composer);
  }
  async function waitForReadyComposer(composer, text, timeoutMs = 2000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const latest = input.findComposer();
      if (latest) composer = latest;
      if (!composer) { await new Promise((resolve) => setTimeout(resolve, 50)); continue; }
      if (!input.composerContainsText(composer, text)) {
        input.setComposerText(composer, text);
        if (!(await waitForComposerText(composer, text))) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
      }
      const control = input.findSendControl(composer);
      if (control) return { composer, control };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { composer, control: composer ? input.findSendControl(composer) : null };
  }
  function requestComposerSubmit(composer) {
    const form = composer?.closest?.('form');
    if (!form || typeof form.requestSubmit !== 'function') return false;
    try {
      form.requestSubmit();
      return true;
    } catch {
      return false;
    }
  }

  async function submitComposer(composer, text, sendControl, { exactOnce = false, isCommitted = null } = {}) {
    if (sendControl) {
      sendControl.click();
      if (await waitForPromptDeparture(composer, text, SUBMIT_ATTEMPT_SETTLE_MS, isCommitted)) return 'click';
      if (exactOnce) throw new Error('ChatGPT qualification prompt was not committed after the single allowed send-button click.');
    }
    if (exactOnce) {
      dispatchComposerEnter(composer);
      if (await waitForPromptDeparture(composer, text, SUBMIT_FINAL_SETTLE_MS, isCommitted)) return 'enter';
      throw new Error('ChatGPT qualification prompt was not committed after the single allowed Enter submission.');
    }

    if (requestComposerSubmit(composer)) {
      if (await waitForPromptDeparture(composer, text, SUBMIT_ATTEMPT_SETTLE_MS, isCommitted)) return 'requestSubmit';
    }

    dispatchComposerEnter(composer);
    if (await waitForPromptDeparture(composer, text, SUBMIT_FINAL_SETTLE_MS, isCommitted)) return 'enter';
    throw new Error('ChatGPT prompt remained in the composer after click, form, and Enter submission attempts.');
  }

  async function submitPrompt(requestId, text, { qualification = null, delivery = null } = {}) {
    let composer = input.findComposer();
    const beforeNodes = answer.assistantNodes(), userBaselineCount = answer.userNodes().length;
    const baseline = {
      count: beforeNodes.length,
      text: substantiveAssistantText(answer.getTurnAssistantText(beforeNodes, beforeNodes.length)),
      issues: pageState.issueSnapshot(), userCount: userBaselineCount, prompt: text,
      assistantBaseline: returnApi.baseline(beforeNodes)
    };

    const sendWaitMs = ['dex-control-result', 'dex-done-watch'].includes(delivery?.kind) ? DEX_CONTROL_SEND_WAIT_MS : 5000;
    const ready = await waitForReadyComposer(composer, text, sendWaitMs);
    composer = ready.composer;
    if (!composer || !input.composerContainsText(composer, text)) {
      throw new Error('ChatGPT composer did not become ready with the prompt text after hydration/reseed.');
    }
    const sendControl = ready.control;

    if (sendControl && input.isUnsafeSendControl?.(sendControl)) {
      throw new Error('Refusing to click a ChatGPT voice/upload control as the send button.');
    }

    const watcher = watchResponse(requestId, baseline);
    return submitComposer(composer, text, sendControl, { exactOnce: qualification?.exactOnce === true, isCommitted: () => answer.normalizeText(answer.getTurnUserText(answer.userNodes(), userBaselineCount)).includes(answer.normalizeText(text)) })
      .then((mode) => { watcher.promptCommitted = true; return mode; });
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'bridge_ping') {
        sendResponse({ ok: true, adapter: 'chatgpt' });
        return;
      }
      if (msg.type === 'capture_latest') {
        const anchored = msg.expectedPrompt ? answer.responseTextForUserPrompt(msg.expectedPrompt, 0) : answer.latestAssistantText();
        const latest = !anchored && msg.originalTurnRequestId ? answer.latestAssistantText() : '';
        const text = substantiveAssistantText(anchored || (returnApi.exactReturn(latest, msg.originalTurnRequestId) ? latest : ''));
        const isGenerating = !!input.generationLooksActive();
        sendResponse({
          ok: true,
          text,
          isGenerating,
          generationState: isGenerating ? 'active' : 'idle',
          observedAt: Date.now(),
          completenessHint: isGenerating ? 'unknown'
            : looksCompleteAssistantText(text) ? 'complete'
              : text && obviouslyPartialAssistantText(text) ? 'incomplete' : 'unknown'
        });
        return;
      }
      if (msg.type === 'send_prompt') {
        submitPrompt(msg.requestId, msg.text, { qualification: msg.qualification || null, delivery: msg.delivery || null })
          .then((submissionMode) => sendResponse({ ok: true, submissionMode }))
          .catch((error) => {
            stopWatcher(msg.requestId);
            emit({ type: 'adapter_error', requestId: msg.requestId, code: 'PROMPT_SEND_FAILED', message: error.message });
            sendResponse({ ok: false, error: error.message });
          });
        return true;
      }
    });
  }

  // The command watcher must not dispatch a marker before response_final.
  globalThis.BrowserAiBridgeChatGptRuntime = { responsePending: () => active.size > 0 };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      ...input,
      ...answer,
      ...pageState,
      RELIABLE_GENERATION_SETTLE_MS,
      STATUS_SIGNAL_SETTLE_MS,
      NO_SIGNAL_SETTLE_MS,
      INCOMPLETE_NO_SIGNAL_SETTLE_MS,
      SUBMIT_ATTEMPT_SETTLE_MS,
      SUBMIT_FINAL_SETTLE_MS,
      DEX_CONTROL_SEND_WAIT_MS,
      transientStatusLine,
      substantiveAssistantText,
      looksCompleteAssistantText,
      obviouslyPartialAssistantText,
      generationSettleMs,
      watchResponse,
      submitPrompt,
      submitComposer,
      requestComposerSubmit,
      waitForPromptDeparture,
      waitForSendControl,
      waitForReadyComposer,
      stopWatcher,
      dispatchComposerEnter,
      waitForComposerText
    };
  }
})();
