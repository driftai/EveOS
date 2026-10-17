(() => {
  const responsePolls = new Map();
  const completedRequests = new Set();

  function isAiStudioTarget(provider, tab) {
    if (provider?.id !== 'gemini') return false;
    const url = String(tab?.url || tab?.pendingUrl || '');
    if (url.startsWith('https://aistudio.google.com') || url.startsWith('http://aistudio.google.com')) return true;
    const title = String(tab?.title || '').toLowerCase();
    return title.includes('google ai studio') || title.includes('ai studio');
  }

  function rememberCompletedRequest(requestId) {
    if (!requestId) return;
    completedRequests.add(requestId);
    const cleanup = setTimeout(() => completedRequests.delete(requestId), 300000);
    cleanup?.unref?.();
  }

  function hasCompletedRequest(requestId) {
    return !!requestId && completedRequests.has(requestId);
  }

  function stopResponsePoll(requestId) {
    const entry = responsePolls.get(requestId);
    if (!entry) return;
    clearInterval(entry.timer);
    clearTimeout(entry.timeout);
    responsePolls.delete(requestId);
  }

  function stopAllResponsePolls() {
    for (const requestId of [...responsePolls.keys()]) stopResponsePoll(requestId);
  }

  function normalizeLoose(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function promptMatches(actual, expected) {
    const a = normalizeLoose(actual);
    const e = normalizeLoose(expected);
    if (!e) return true;
    return a === e || a.endsWith(e) || a.includes(e);
  }

  async function sampleAiStudioTab(tabId, scriptingApi = globalThis.chrome?.scripting, expectedPrompt = '') {
    if (!scriptingApi?.executeScript) {
      return {
        count: 0,
        userCount: 0,
        text: '',
        generating: false,
        ready: false,
        promptMatched: false,
        lastUserText: '',
        modelAfterUserCount: 0
      };
    }
    const [execution] = await scriptingApi.executeScript({
      target: { tabId },
      args: [String(expectedPrompt || '')],
      func: (expectedPromptValue) => {
        const answer = globalThis.BrowserAiBridgeGeminiAnswer;
        const input = globalThis.BrowserAiBridgeGeminiInput;
        const allTurns = [...document.querySelectorAll('ms-chat-turn')];
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

        const turnRole = (turn) => {
          const role = String(turn.getAttribute?.('data-turn-role') || '').toLowerCase();
          const classes = String(turn.className || '').toLowerCase();
          if (role === 'user' || classes.includes('user') || turn.querySelector?.('[data-turn-role="User"], [data-turn-role="user"], .chat-turn-container.user')) return 'user';
          if (role === 'model' || classes.includes('model') || turn.querySelector?.('[data-turn-role="Model"], [data-turn-role="model"], .chat-turn-container.model')) return 'model';
          return '';
        };

        const userText = (turn) => {
          const owned = turn.querySelector?.('[data-turn-role="User"], [data-turn-role="user"], .chat-turn-container.user, .turn-content') || turn;
          return normalize(owned.innerText || owned.textContent || '')
            .replace(/^User\s+\d{1,2}:\d{2}\s*(?:AM|PM)?\s*/i, '')
            .trim();
        };

        const modelText = (turn) => {
          if (answer?.assistantText) return String(answer.assistantText(turn, 'aistudio') || '').trim();
          const blocks = [...turn.querySelectorAll('ms-cmark-node.cmark-node, .turn-content ms-cmark-node, .turn-content .cmark-node')]
            .filter((node) => !node.closest?.('ms-thought-viewer, ms-thought-chunk, [data-turn-role="Thought"], .thinking-container'));
          return (blocks.length ? blocks : [turn])
            .map((node) => String(node.innerText || node.textContent || '').trim())
            .filter(Boolean)
            .join('\n\n')
            .replace(/^Model\s+\d{1,2}:\d{2}\s*(?:AM|PM)?\s*/i, '')
            .replace(/(?:^|\n)\s*\d+(?:\.\d+)?s\s*(?=\n|$)/gi, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        };

        const userTurns = [];
        const modelTurns = [];
        allTurns.forEach((turn, index) => {
          const role = turnRole(turn);
          if (role === 'user') userTurns.push({ turn, index, text: userText(turn) });
          if (role === 'model') modelTurns.push({ turn, index });
        });

        const lastUser = userTurns[userTurns.length - 1] || null;
        const expected = normalize(expectedPromptValue).toLowerCase();
        const actual = normalize(lastUser?.text || '').toLowerCase();
        const promptMatched = !expected || actual === expected || actual.endsWith(expected) || actual.includes(expected);
        const modelsAfterUser = lastUser
          ? modelTurns.filter((entry) => entry.index > lastUser.index)
          : [];
        let correlatedText = '';
        for (let index = modelsAfterUser.length - 1; index >= 0; index -= 1) {
          correlatedText = modelText(modelsAfterUser[index].turn);
          if (correlatedText) break;
        }

        const assistantNodes = answer?.assistantNodes
          ? answer.assistantNodes(document, 'aistudio')
          : modelTurns.map((entry) => entry.turn);
        const controls = [...document.querySelectorAll('button[aria-label], ms-run-button button')];
        const hasStop = controls.some((button) => /stop|cancel/i.test(String(button.getAttribute?.('aria-label') || '')));
        const ready = input?.submissionReady?.('aistudio') ?? controls.some((button) => {
          const label = String(button.getAttribute?.('aria-label') || '').trim().toLowerCase();
          return (label === 'run' || /\brun\b/.test(label) || button.closest?.('ms-run-button'))
            && !/stop|cancel/i.test(label);
        });
        return {
          count: assistantNodes.length,
          userCount: userTurns.length,
          text: correlatedText,
          generating: hasStop || !!input?.generationLooksActive?.('aistudio'),
          ready: !!ready,
          promptMatched,
          lastUserText: lastUser?.text || '',
          modelAfterUserCount: modelsAfterUser.length
        };
      }
    });
    return execution?.result || {
      count: 0,
      userCount: 0,
      text: '',
      generating: false,
      ready: false,
      promptMatched: false,
      lastUserText: '',
      modelAfterUserCount: 0
    };
  }

  // Compatibility helper retained for tests/callers. It is deliberately passive now.
  // Earlier builds toggled active tabs and repeatedly updated popup window state to "wake"
  // AI Studio. That created a foreground-arbitration loop on Windows and could surface
  // unrelated applications. Sampling must never mutate browser/OS focus state.
  async function pulseAiStudioTab(
    tabId,
    tabsApi = globalThis.chrome?.tabs,
    scriptingApi = globalThis.chrome?.scripting,
    delayMs = 0,
    expectedPrompt = ''
  ) {
    if (!tabsApi?.get) return null;
    const target = await tabsApi.get(tabId);
    if (!target || target.discarded) return null;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return sampleAiStudioTab(tabId, scriptingApi, expectedPrompt);
  }

  function isFreshAiStudioSample(sample = {}, baseline = {}, expectedPrompt = '') {
    const userAdvanced = Number(sample.userCount || 0) > Number(baseline.userCount || 0);
    const correlatedModel = Number(sample.modelAfterUserCount || 0) > 0;
    const matched = sample.promptMatched !== false && promptMatches(sample.lastUserText || '', expectedPrompt);
    return userAdvanced && correlatedModel && matched && !!String(sample.text || '').trim();
  }

  function shouldFinalizeAiStudioSample({ generating, ready, sawGenerating, stableForMs, generationEndedForMs }) {
    if (generating || !ready) return false;
    const stable = Number(stableForMs || 0);
    const ended = Number(generationEndedForMs || 0);
    if (sawGenerating) return stable >= 800 && ended >= 600;
    return stable >= 2000;
  }

  function startAiStudioResponsePoll({
    tabId,
    requestId,
    baseline = {},
    expectedPrompt = '',
    send,
    tabsApi = globalThis.chrome?.tabs,
    scriptingApi = globalThis.chrome?.scripting,
    intervalMs = 450,
    timeoutMs = 240000
  }) {
    stopResponsePoll(requestId);
    const now = Date.now();
    const state = {
      baselineCount: Number(baseline.count || 0),
      baselineUserCount: Number(baseline.userCount || 0),
      baselineText: String(baseline.text || ''),
      expectedPrompt: String(expectedPrompt || ''),
      lastText: '',
      lastChangedAt: now,
      generatingEndedAt: 0,
      sawGenerating: false,
      running: false
    };

    const finishPoll = (finalEvent) => {
      // Only enter completion dedupe after the transport accepts the terminal event.
      // An explicit false from safeSend means the socket is unavailable, so keep the
      // existing single poll alive and let its bounded tick retry delivery.
      if (finalEvent && send?.(finalEvent) === false) return false;
      rememberCompletedRequest(requestId);
      stopResponsePoll(requestId);
      return true;
    };

    const processSample = (sample) => {
      if (hasCompletedRequest(requestId) || !responsePolls.has(requestId)) return true;
      const sampledAt = Date.now();
      if (sample.generating) {
        state.sawGenerating = true;
        state.generatingEndedAt = 0;
      } else if (state.sawGenerating && !state.generatingEndedAt) {
        state.generatingEndedAt = sampledAt;
      }

      const fresh = isFreshAiStudioSample(sample, {
        count: state.baselineCount,
        userCount: state.baselineUserCount
      }, state.expectedPrompt);
      if (!fresh) return false;

      if (sample.text !== state.lastText) {
        state.lastText = sample.text;
        state.lastChangedAt = sampledAt;
        send?.({ type: 'response_partial', requestId, text: sample.text });
        return true;
      }

      const stableForMs = sampledAt - state.lastChangedAt;
      const generationEndedForMs = state.generatingEndedAt ? sampledAt - state.generatingEndedAt : 0;
      if (!shouldFinalizeAiStudioSample({
        generating: sample.generating,
        ready: sample.ready,
        sawGenerating: state.sawGenerating,
        stableForMs,
        generationEndedForMs
      })) return false;

      return finishPoll({ type: 'response_final', requestId, text: sample.text, providerId: 'gemini', providerName: 'Gemini' });
    };

    const tick = async () => {
      if (state.running || !responsePolls.has(requestId)) return;
      state.running = true;
      try {
        const tab = await tabsApi?.get?.(tabId);
        if (!tab || tab.discarded) return;
        const sample = await sampleAiStudioTab(tabId, scriptingApi, state.expectedPrompt);
        processSample(sample);
      } catch {
        // Retry transient sampling failures without activating tabs or mutating window state.
      } finally {
        state.running = false;
      }
    };

    const timer = setInterval(tick, intervalMs);
    const timeout = setTimeout(() => {
      // A stalled partial is not a settled final. Preserve exact-once and let
      // the scheduler's capture-only recovery inspect the unfinished turn.
      finishPoll({ type: 'adapter_error', requestId, code: 'RESPONSE_TIMEOUT',
        message: 'AI Studio response never reached a verifiably settled final before timeout.' });
    }, timeoutMs);
    responsePolls.set(requestId, { timer, timeout, state });
    tick();
  }

  const api = {
    isAiStudioTarget,
    rememberCompletedRequest,
    hasCompletedRequest,
    stopResponsePoll,
    stopAllResponsePolls,
    normalizeLoose,
    promptMatches,
    sampleAiStudioTab,
    pulseAiStudioTab,
    isFreshAiStudioSample,
    shouldFinalizeAiStudioSample,
    startAiStudioResponsePoll
  };

  if (typeof globalThis !== 'undefined') globalThis.BrowserAiBridgeGeminiBackgroundPoll = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
