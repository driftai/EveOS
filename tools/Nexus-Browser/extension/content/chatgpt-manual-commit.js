(() => {
  'use strict';
  // An unconfirmed Dex Send gesture keeps its request owner and response watcher in an
  // awaiting-manual-commit state. Nothing is replayed: no second gesture and no automatic resend.
  // If the user then presses Enter by hand, the committed user turn marks the prompt accepted
  // ('manual') and the reply is captured normally. The window is bounded, so an abandoned draft
  // cannot hold the tab or route a much later, unrelated reply.
  const MANUAL_COMMIT_WINDOW_MS = 5 * 60 * 1000, POLL_MS = 500;
  const UNCONFIRMED = /unconfirmed; draft preserved/;

  function recoverable(error, stage, dexDelivery) {
    return !!dexDelivery && stage === 'pre-gesture' && UNCONFIRMED.test(String(error?.message || ''));
  }

  function sendDiagnostics(input, composer, sendControl) {
    return {
      controlConnected: !!sendControl && sendControl.isConnected !== false,
      controlDisabled: !!sendControl && !!input?.isDisabledControl?.(sendControl),
      composerConnected: !!composer && composer.isConnected !== false,
      composerTextLength: String(input?.composerText?.(composer) || '').length
    };
  }

  function create({ active, stopWatcher, emit, now = () => Date.now(),
    timers = { setInterval, clearInterval, setTimeout, clearTimeout } } = {}) {
    function arm(requestId, committed, windowMs = MANUAL_COMMIT_WINDOW_MS) {
      const watcher = active?.get?.(requestId);
      if (!watcher || typeof committed !== 'function') return false;
      watcher.awaitingManualCommit = true;
      watcher.manualPoll = timers.setInterval(() => {
        if (!active.has(requestId) || !committed()) return;
        timers.clearInterval(watcher.manualPoll); timers.clearTimeout(watcher.manualDeadline);
        watcher.awaitingManualCommit = false; watcher.promptCommitted = true; watcher.submissionMode = 'manual';
        emit({ type: 'response_activity', requestId, isGenerating: true, generationState: 'active',
          submissionMode: 'manual', observedAt: now() });
      }, POLL_MS);
      watcher.manualDeadline = timers.setTimeout(() => {
        if (watcher.awaitingManualCommit) stopWatcher(requestId);
      }, windowMs);
      return true;
    }
    function release(watcher) {
      if (!watcher) return;
      timers.clearInterval(watcher.manualPoll); timers.clearTimeout(watcher.manualDeadline);
    }
    return { arm, release };
  }

  const api = { MANUAL_COMMIT_WINDOW_MS, POLL_MS, recoverable, sendDiagnostics, create };
  if (typeof globalThis !== 'undefined') globalThis.BrowserAiBridgeChatGptManualCommit = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
