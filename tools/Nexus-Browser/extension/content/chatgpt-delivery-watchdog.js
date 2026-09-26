(() => {
  if (typeof window !== 'undefined' && globalThis.__browserAiBridgeChatGptDeliveryWatchdogLoaded) return;
  if (typeof window !== 'undefined') globalThis.__browserAiBridgeChatGptDeliveryWatchdogLoaded = true;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Retry only readiness/reseeding BEFORE any submission gesture. A click,
  // requestSubmit or synthetic Enter is irreversible if its outcome is unknown.
  function createDeliveryWatchdog({ input, now = Date.now, wait = sleep,
    pollMs = 120, staleAfterMs = 4000, maxReseeds = 2 } = {}) {
    if (!input) throw Error('ChatGPT input helper required.');
    const pending = new Map(), terminal = new Map(), stats = { ready: 0, blocked: 0, staleDrafts: 0,
      safeReseeds: 0, confirmed: 0, uncertain: 0, foreignDrafts: 0, last: null };
    const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const info = (entry) => ({ requestId: entry.id, phase: entry.phase,
      elapsedMs: Math.max(0, now() - entry.startedAt), reseeds: entry.reseeds,
      gesture: entry.gesture || null, stale: !!entry.stale,
      reason: entry.reason || null }); // Never expose payload or draft contents.
    function setPhase(entry, phase, reason = null) {
      entry.phase = phase; entry.reason = reason; stats.last = info(entry);
    }
    function start(id) {
      const key = String(id || 'anonymous');
      if (terminal.has(key)) throw Error('Dex delivery previously attempted or completed; never replay the same request.');
      const old = pending.get(key);
      if (old && old.gesture) throw Error('Dex delivery already attempted a submission gesture; never replay.');
      if (old && old.phase === 'confirmed') return old;
      const entry = old || { id: key, startedAt: now(), reseeds: 0, gesture: null,
        stale: false, phase: 'waiting', reason: null };
      pending.set(key, entry); setPhase(entry, 'waiting'); return entry;
    }
    async function ready(composer, text, timeoutMs = 2000, id = null, isCommitted = null) {
      const entry = start(id), deadline = now() + Math.max(1, timeoutMs);
      let seededAt = now();
      while (now() <= deadline) {
        if (isCommitted?.()) { setPhase(entry, 'confirmed', 'already-committed'); stats.confirmed++;
          pending.delete(entry.id); terminal.set(entry.id, 'confirmed'); return { composer, control: null, committed: true }; }
        const latest = input.findComposer();
        if (latest) composer = latest;
        if (!composer) { setPhase(entry, 'waiting', 'composer-hydrating'); await wait(pollMs); continue; }
        const actual = clean(input.composerText(composer)), wanted = clean(text);
        if (actual && actual !== wanted) {
          stats.foreignDrafts++; setPhase(entry, 'blocked', 'foreign-draft');
          pending.delete(entry.id);
          throw Error('ChatGPT composer contains a different draft; refusing to replace it.');
        }
        if (!actual) {
          if (isCommitted?.()) { setPhase(entry, 'confirmed', 'already-committed');
            stats.confirmed++; pending.delete(entry.id); terminal.set(entry.id, 'confirmed');
            return { composer, control: null, committed: true }; }
          input.setComposerText(composer, text);
          seededAt = now();
        }
        if (!input.composerContainsText(composer, text)) {
          setPhase(entry, 'waiting', 'composer-hydrating'); await wait(pollMs); continue;
        }
        let generating = false;
        try { generating = !!input.generationLooksActive?.(); } catch { /* No DOM in isolated tests. */ }
        const control = input.findSendControl(composer);
        const form = composer?.closest?.('form');
        if (!generating && (control || (form && typeof form.requestSubmit === 'function'))) {
          setPhase(entry, 'ready'); stats.ready++; return { composer, control };
        }
        if (now() - seededAt >= staleAfterMs) {
          if (!entry.stale) { entry.stale = true; stats.staleDrafts++; }
          if (!generating && !control && entry.reseeds < maxReseeds
            && clean(input.composerText(composer)) === wanted && !isCommitted?.()) {
            // Same exact text only: re-trigger React input hydration. Never
            // overwrite a changed or unrelated draft; never click here.
            entry.reseeds++; stats.safeReseeds++; seededAt = now();
            input.setComposerText(composer, text);
          }
        }
        setPhase(entry, 'waiting', generating ? 'generation-active' : 'send-control-not-ready');
        await wait(pollMs);
      }
      stats.blocked++; setPhase(entry, 'blocked', 'pre-gesture-timeout');
      pending.delete(entry.id);
      return { composer, control: composer ? input.findSendControl(composer) : null, timedOut: true };
    }
    function gesture(id, kind) {
      const entry = pending.get(String(id || 'anonymous'));
      if (!entry) return;
      if (entry.gesture) throw Error('Second submission gesture refused for same Dex delivery.');
      entry.gesture = kind; setPhase(entry, 'gesture-attempted'); // Never retry after this point.
    }
    function finish(id, success, reason = null) {
      const entry = pending.get(String(id || 'anonymous'));
      if (!entry) return;
      if (success) { stats.confirmed++; setPhase(entry, 'confirmed', reason); }
      else if (entry.gesture) { stats.uncertain++; setPhase(entry, 'uncertain', reason || 'gesture-outcome-unknown'); }
      else { stats.blocked++; setPhase(entry, 'blocked', reason || 'pre-gesture-failure'); }
      if (success || entry.gesture) {
        terminal.set(entry.id, success ? 'confirmed' : 'uncertain');
        if (terminal.size > 128) terminal.delete(terminal.keys().next().value);
      }
      pending.delete(entry.id);
    }
    function diagnostics() {
      return { ...stats, terminalCount: terminal.size, pending: [...pending.values()].map(info) };
    }
    return { ready, gesture, finish, diagnostics };
  }
  const api = { createDeliveryWatchdog };
  globalThis.BrowserAiBridgeChatGptDeliveryWatchdog = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage)
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg?.type === 'dex_delivery_watchdog_status')
        reply({ ok: true, watchdog: globalThis.BrowserAiBridgeChatGptDeliveryWatchdog?.active?.diagnostics?.() || null });
    });
})();
