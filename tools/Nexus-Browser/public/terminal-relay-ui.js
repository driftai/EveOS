(() => {
  const COMMANDS = {
    standard: 'npm run relay:dev',
    noPull: 'npm run relay:dev -- --no-pull',
    full: 'npm run relay:dev -- --full',
    localOnly: 'npm run relay:dev -- --local-only'
  };

  function fallbackCopy(text, done) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try { document.execCommand('copy'); done(); } finally { area.remove(); }
  }

  function copyText(text, status) {
    const done = () => {
      if (!status) return;
      const previous = status.textContent;
      status.textContent = 'Command copied. Paste it once into PowerShell.';
      setTimeout(() => { status.textContent = previous; }, 2400);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
      return;
    }
    fallbackCopy(text, done);
  }

  function setText(selector, value) {
    const node = document.querySelector(selector);
    if (node) node.textContent = value;
  }

  async function latest() {
    try {
      const response = await fetch('/terminal-relay/status', { cache: 'no-store' });
      return response.ok ? await response.json() : { available: false };
    } catch {
      return { available: false };
    }
  }

  function formatDuration(ms) {
    const value = Math.max(0, Number(ms) || 0);
    const seconds = Math.floor(value / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  }

  function ensureTrace(status) {
    let trace = document.querySelector('#terminalRelayTrace');
    if (trace) return trace;
    trace = document.createElement('div');
    trace.id = 'terminalRelayTrace';
    trace.className = 'terminal-relay-status';
    trace.hidden = true;
    trace.setAttribute('aria-live', 'polite');
    status?.insertAdjacentElement('afterend', trace);
    return trace;
  }

  function activateAppOrigin(progress) {
    if (!progress?.active || progress.targetClassId !== 'app-origin' || !progress.targetId) return;
    const select = document.querySelector('#targetClassSelect');
    if (!select || select.value === 'app-origin') return;
    select.value = 'app-origin';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function traceText(progress) {
    if (!progress) return '';
    const started = Date.parse(progress.startedAt || '');
    const stageStarted = Date.parse(progress.stageStartedAt || progress.startedAt || '');
    const elapsed = Number.isFinite(started) ? Date.now() - started : 0;
    const stageElapsed = Number.isFinite(stageStarted) ? Date.now() - stageStarted : 0;
    const step = Math.max(0, Number(progress.step) || 0);
    const total = Math.max(step, Number(progress.totalSteps) || 0);
    let eta = 'estimating…';
    if (!progress.active || progress.status === 'COMPLETE') eta = 'done';
    else if (progress.etaKind === 'estimate' && Number.isFinite(Number(progress.etaMs))) {
      eta = `~${formatDuration(Math.max(0, Number(progress.etaMs) - stageElapsed))} this step`;
    } else if (progress.etaKind === 'provider') eta = 'provider timing varies';
    else if (progress.etaKind === 'user') eta = 'waiting for input';
    const detail = progress.detail ? `\n${progress.detail}` : '';
    const chars = Number(progress.replyChars || 0) > 0 ? ` · ${Number(progress.replyChars)} chars` : '';
    return `[${step}/${total}] ${progress.label || progress.stage || 'Terminal Relay'} · ${formatDuration(elapsed)} elapsed · ${eta}${chars}${detail}`;
  }

  function create() {
    const panel = document.querySelector('#terminalRelayPanel');
    if (!panel) return;
    const status = document.querySelector('#terminalRelayStatus');
    const appStatus = document.querySelector('#appTargetStatus');
    const targetClass = document.querySelector('#targetClassSelect');
    const trace = ensureTrace(status);

    panel.querySelectorAll('[data-terminal-command]').forEach((button) =>
      button.addEventListener('click', () => {
        const command = COMMANDS[button.dataset.terminalCommand];
        if (command) copyText(command, status);
      }));

    async function render() {
      const snapshot = await latest();
      const progress = snapshot.progress || null;
      activateAppOrigin(progress);

      const appMode = targetClass?.value === 'app-origin';
      const appText = String(appStatus?.textContent || '');
      const uiConnected = /^Connected to/i.test(appText);
      const relayBound = progress?.targetClassId === 'app-origin' && !!progress?.targetId;
      const connected = uiConnected || relayBound;

      panel.dataset.ready = connected ? 'true' : 'false';
      if (progress?.active) {
        setText('#terminalRelayProvider', `${progress.providerName || 'ChatGPT App'} · Running ${progress.step || 0}/${progress.totalSteps || 0}`);
      } else {
        setText('#terminalRelayProvider', connected ? 'ChatGPT App · Connected'
          : appMode ? 'ChatGPT App · Not connected' : 'Select App-Origin');
      }

      if (status) {
        status.textContent = progress?.active
          ? `Relay running · ${progress.label || progress.stage || 'working'}.`
          : connected
            ? 'Ready · Terminal Relay is scoped to the verified ChatGPT App conversation.'
            : appMode
              ? 'Ready for auto-bind · relay:dev can connect the single verified ChatGPT App conversation automatically.'
              : 'Select App-Origin above to use Terminal Relay.';
      }

      if (trace) {
        trace.hidden = !progress;
        if (progress) trace.textContent = traceText(progress);
      }

      if (!snapshot.available) {
        setText('#terminalRelayLastRun', 'Never');
        setText('#terminalRelayLastRelay', '—');
        return;
      }
      setText('#terminalRelayLastRun', snapshot.counts
        ? (snapshot.counts.fail ? 'FAIL' : 'PASS') + ' · ' + (snapshot.branch || 'detached')
        : 'Unknown');
      setText('#terminalRelayLastRelay', snapshot.relay?.status || progress?.status || 'Unknown');
      setText('#terminalRelayLastPath', snapshot.runPath || 'data/runtime/nexus-browser/terminal-relay');
    }

    targetClass?.addEventListener('change', render);
    if (appStatus) new MutationObserver(render).observe(appStatus, {
      childList: true, subtree: true, characterData: true
    });
    document.querySelector('#terminalRelayRefresh')?.addEventListener('click', render);
    render();
    setInterval(render, 1000);
  }

  document.addEventListener('DOMContentLoaded', create, { once: true });
})();