(() => {
  if (typeof window !== 'undefined' && globalThis.__browserAiBridgeChatGptStreamNudgeLoaded) return;
  if (typeof window !== 'undefined') globalThis.__browserAiBridgeChatGptStreamNudgeLoaded = true;
  const ERROR_CODE = 'CHATGPT_MESSAGE_STREAM_ERROR', SETTLE_MS = 1600;
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
      if (dexActive || current < Number(globalThis.__browserAiBridgeChatGptDexStreamErrorUntil || 0)) dexOwned = true;
      if (!waiting || generating || dexOwned || current < suppressedUntil
        || key === lastSentKey || !lastUser) return false;
      const issue = pageState.findChangedIssue(baseline);
      if (issue?.code !== ERROR_CODE) { candidateAt = 0; return false; }
      if (!candidateAt) { candidateAt = current; return false; }
      if (current - candidateAt < SETTLE_MS) return false;
      waiting = false; candidateAt = 0; lastSentKey = key; attempts++;
      // No replay of the original user prompt, Dex turn, or any external action.
      // No original prompt or assistant text is sent to the service worker.
      try { send({ type: 'nexus_chatgpt_stream_error', reason: ERROR_CODE, turnKey: key }); }
      catch {} // The worker may be asleep; never automatically repeat uncertain sends.
      return true;
    }
    const diagnostics = () => ({ attempts, waiting, dexOwned, suppressed: now() < suppressedUntil });
    return { sample, suppressFor, diagnostics, ERROR_CODE, SETTLE_MS, SUPPRESS_MS };
  }
  const api = { createStreamNudgeController, ERROR_CODE, SETTLE_MS, SUPPRESS_MS };
  globalThis.BrowserAiBridgeChatGptStreamNudge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined' && document.body && typeof chrome !== 'undefined') {
    const pageState = globalThis.BrowserAiBridgeChatGptPageState;
    const answer = globalThis.BrowserAiBridgeChatGptAnswer;
    const input = globalThis.BrowserAiBridgeChatGptInput;
    if (pageState && answer && input) {
      const controller = createStreamNudgeController({ pageState, answer, input });
      api.suppressFor = controller.suppressFor;
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
