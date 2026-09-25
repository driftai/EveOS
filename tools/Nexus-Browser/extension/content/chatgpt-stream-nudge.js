(() => {
  if (typeof window !== 'undefined' && globalThis.__browserAiBridgeChatGptStreamNudgeLoaded) return;
  if (typeof window !== 'undefined') globalThis.__browserAiBridgeChatGptStreamNudgeLoaded = true;
  const ERROR_CODE = 'CHATGPT_MESSAGE_STREAM_ERROR', SETTLE_MS = 1600;
  const RECOVERABLE = new Set([ERROR_CODE, 'CHATGPT_STREAM_CACHE_EXPIRED']);
  const SUPPRESS_MS = 15 * 60 * 1000;
  function createStreamNudgeController({
    pageState, answer, input, getRuntime = () => globalThis.BrowserAiBridgeChatGptRuntime,
    send = (msg) => globalThis.chrome?.runtime?.sendMessage?.(msg),
    now = Date.now
  } = {}) {
    let baseline = pageState.issueSnapshot();
    let lastUser = answer.userNodes().at(-1) || null;
    let generation = !!input.generationLooksActive();
    let waiting = generation, dexOwned = !!getRuntime()?.responsePending?.();
    let key = 'native-initial-' + now(), sequence = 0, candidateAt = 0;
    let suppressedUntil = 0, lastSentKey = '', attempts = 0;
    function suppressFor(ms = SUPPRESS_MS) {
      suppressedUntil = Math.max(suppressedUntil, now() + Math.min(SUPPRESS_MS, Math.max(0, ms)));
      waiting = false; candidateAt = 0; baseline = pageState.issueSnapshot();
    }
    function sendOnce(turnKey, reason = ERROR_CODE) {
      if (!RECOVERABLE.has(reason) || !turnKey || now() < suppressedUntil || lastSentKey === turnKey) return false;
      lastSentKey = turnKey; waiting = false; candidateAt = 0; attempts++;
      // The content script reports only a reason and bounded turn key, NEVER
      // the failed prompt, agent reply, room data or any executable command.
      try { send({ type: 'nexus_chatgpt_stream_error',
        reason, turnKey }); } catch {}
      return true;
    }
    function reportDexError(requestId, reason = ERROR_CODE) {
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) return false;
      // The regular watcher has already seen an exact provider error. It may
      // stop its Dex turn before a DOM-based idle scan can observe the same UI.
      if (!waiting && lastSentKey) return false;
      return sendOnce(waiting ? key : 'dex-' + requestId.slice(0, 120), reason);
    }
    function sample() {
      const current = now(), user = answer.userNodes().at(-1) || null;
      const generating = !!input.generationLooksActive();
      const runtime = getRuntime(), dexActive = !!runtime?.responsePending?.();
      if (user && user !== lastUser) {
        lastUser = user; sequence++;
        key = 'native-user-' + sequence + '-' + current;
        waiting = true; dexOwned = dexActive; candidateAt = 0;
        baseline = pageState.issueSnapshot();
      }
      if (generating && !generation && !waiting) {
        waiting = true; dexOwned = dexActive; candidateAt = 0;
        key = 'native-generation-' + (++sequence) + '-' + current;
        baseline = pageState.issueSnapshot();
      }
      generation = generating;
      if (dexActive) dexOwned = true; // Diagnostic only: server checks ALL rooms before injection.
      if (!waiting || generating || current < suppressedUntil
        || key === lastSentKey || !lastUser) return false;
      const issue = pageState.findChangedIssue(baseline);
      if (!RECOVERABLE.has(issue?.code)) { candidateAt = 0; return false; }
      // A user or agent discussing the error string in ordinary rendered
      // markdown is not evidence of an actual ChatGPT stream failure.
      const element = issue.element;
      const errorSurface = element?.closest?.('[role="alert"], [data-testid*="error" i]');
      const quoted = element?.closest?.('.markdown, .prose, [class*="DilResponseRoot"]');
      if (quoted && !errorSurface) { candidateAt = 0; return false; }
      if (!candidateAt) { candidateAt = current; return false; }
      if (current - candidateAt < SETTLE_MS) return false;
      return sendOnce(key, issue.code);
    }
    const diagnostics = () => ({ attempts, waiting, dexOwned, suppressed: now() < suppressedUntil });
    return { sample, reportDexError, suppressFor, diagnostics, ERROR_CODE, RECOVERABLE, SETTLE_MS, SUPPRESS_MS };
  }
  const api = { createStreamNudgeController, ERROR_CODE, RECOVERABLE, SETTLE_MS, SUPPRESS_MS };
  globalThis.BrowserAiBridgeChatGptStreamNudge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined' && document.body && typeof chrome !== 'undefined') {
    const pageState = globalThis.BrowserAiBridgeChatGptPageState;
    const answer = globalThis.BrowserAiBridgeChatGptAnswer;
    const input = globalThis.BrowserAiBridgeChatGptInput;
    if (pageState && answer && input) {
      const controller = createStreamNudgeController({ pageState, answer, input });
      api.suppressFor = controller.suppressFor;
      api.reportDexError = controller.reportDexError;
      api.diagnostics = controller.diagnostics;
      const schedule = () => {
        clearTimeout(api.scanTimer);
        api.scanTimer = setTimeout(() => controller.sample(), 350);
      };
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      const timer = setInterval(() => controller.sample(), 700);
      api.stop = () => { observer.disconnect(); clearTimeout(api.scanTimer); clearInterval(timer); };
      chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
        if (msg?.type !== 'nexus_stream_nudge_suppress') return;
        controller.suppressFor(SUPPRESS_MS);
        respond({ ok: true });
        return true;
      });
    }
  }
})();
