// AudioFlix Mode Checks v0.4.2: passive enhancement of v0.4.1's existing inline panel.
// Only reads the already-available verified EveOS native device bridge. Never changes routing,
// policies, Spotify sessions, or audio processes. Does not assume a successful dependency probe
// means Spotify audio has played successfully.
(function () {
    'use strict';
    if (window.EveAudioflixModeSensorsV042?.ready) return;

    function result(label, detail) { return { label, detail }; }
    function resolveRows(payload, selectedNativeId = '') {
        const caps = payload?.modeCapabilitiesV042;
        if (caps?.schemaVersion !== 1) {
            const unknown = result('Not checked', 'Restart the EveOS backend to enable v0.4.2 host detection.');
            return { 'Edge Beta': unknown, 'Windows app routing adapter': unknown,
                'Managed Engine prerequisites': result('Not checked', 'Managed session and audio were not tested.'),
                'Official Embed prerequisites': unknown };
        }
        const edge = caps.edgeBeta || {}, adapter = caps.windowsAppRouting || {};
        const named = (value, positive) => value === positive ? 'Detected' :
            value === 'missing' ? 'Missing' : value === 'unsupported' ? 'Unsupported' : 'Not checked';
        const playable = Array.isArray(payload.devices) ? payload.devices.filter(d => d.playable === true && d.kind === 'output') : [];
        const selected = !!selectedNativeId && playable.some(d => d.id === selectedNativeId);
        const present = edge.status === 'detected' && adapter.status === 'installed';
        let official;
        if (edge.status === 'missing' || adapter.status === 'missing') {
            official = result('Needs setup', 'One or more Official Embed dependencies are missing. No playback attempt was made.');
        } else if (present && payload.playbackAvailable === true && selected) {
            official = result('Dependencies detected', 'Prerequisites detected, but Spotify login, DRM, session routing and audible playback remain untested.');
        } else {
            official = result('Not checked', 'Official Embed requires Edge Beta, pinned Windows app routing and a selected playable native output. Playback was not tested.');
        }
        return {
            'Edge Beta': result(named(edge.status, 'detected'), edge.detail || 'Edge Beta detection has no details.'),
            'Windows app routing adapter': result(adapter.status === 'installed' ? 'Module detected' :
                adapter.status === 'missing' ? 'Missing' : adapter.status === 'unsupported' ? 'Unsupported' : 'Not checked',
                adapter.detail || 'Routing adapter check has no details.'),
            'Managed Engine prerequisites': result('Not checked', 'This passive test cannot establish an authenticated/running Spotify Engine or audible playback.'),
            'Official Embed prerequisites': official,
        };
    }

    const STATUSES = new Set(['Not verified', 'Not checked', 'Detected', 'Missing', 'Needs setup',
        'Unavailable', 'Unsupported', 'Ready', 'Module detected', 'Dependencies detected']);
    function leaves(root) {
        return [...root.querySelectorAll('*')].filter(node =>
            node.children?.length === 0 && typeof node.textContent === 'string');
    }
    function replaceExistingRow(panel, label, reading) {
        const labelLeaf = leaves(panel).find(node => node.textContent.trim() === label);
        if (!labelLeaf) return false;
        for (let row = labelLeaf.parentElement, hops = 0; row && row !== panel && hops < 4;
            row = row.parentElement, hops++) {
            const statuses = leaves(row).filter(node => node !== labelLeaf && STATUSES.has(node.textContent.trim()));
            if (statuses.length !== 1) continue;
            statuses[0].textContent = reading.label;
            statuses[0].title = reading.detail;
            statuses[0].dataset.afSensorV042 = '1';
            return true;
        }
        return false;
    }
    function selectedId() {
        try { return String(window.EveAudioflixState?.ensure?.()?.nativeOutputId || ''); }
        catch (_) { return ''; }
    }
    async function reconcile(panel) {
        // No forced rescan: PortAudio refresh could disrupt a running stream.
        let payload;
        try { payload = await window.EveAudioflixNative?.listSystemOutputs?.(false); }
        catch (_) { payload = null; }
        const rows = resolveRows(payload, selectedId());
        // The v0.4.1 action may render the panel asynchronously or replace its DOM.
        // Reuse the same read-only snapshot; never re-run audio discovery during retries.
        for (const delay of [0, 90, 240, 550, 1000]) {
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            const active = panel?.isConnected ? panel : [...document.querySelectorAll('.audioflix-policy-panel')]
                .find(el => [...el.querySelectorAll('button')].some(isModeButton));
            if (!active) continue;
            const matched = Object.entries(rows).map(([label, reading]) =>
                replaceExistingRow(active, label, reading));
            if (matched.every(Boolean)) break;
        }
        return rows;
    }
    function isModeButton(button) {
        return button?.tagName === 'BUTTON' && button.textContent.trim() === 'Check mode requirements';
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('click', event => {
            const button = event.target?.closest?.('button');
            if (!isModeButton(button)) return;
            const panel = button.closest('.audioflix-policy-panel');
            if (!panel) return;
            // Let v0.4.1 first render its result; enhance only the four uncertain rows.
            setTimeout(() => reconcile(panel).catch(() => {}), 0);
        }, true);
    }
    window.EveAudioflixModeSensorsV042 = { ready: true, resolveRows, reconcile };
})();

// EVEOS_MANAGED_RUNTIME_STATUS_V050: passive status overlay for local v0.4.2 sensors.
(function () {
  'use strict';
  if (window.EveAudioflixManagedRuntimeStatus?.ready) return;
  const ns = window.EveAudioflixManagedRuntimeStatus = { ready: true };
  const label = 'Managed Engine prerequisites';
  function classify(s) {
    if (s?.ok !== true) return ['Error', String(s?.reason || 'Status unavailable')];
    if (!s.nodeAvailable || !s.playwrightAvailable || !s.helperExists)
      return ['Unavailable', String(s.reason || 'Node, Playwright, or browser helper missing')];
    if (!s.browserRunning) return ['Stopped (available)', 'Dependencies installed; opening this panel will not launch Spotify'];
    if (!s.helperReachable || !s.pageAttached || !s.sessionPresent)
      return ['Starting / disconnected', String(s.lastError || 'Engine is not ready yet')];
    if (s.authState !== 'signed-in')
      return ['Sign-in required', 'Managed Edge Beta browser is active but Spotify is not authenticated'];
    return ['Ready', 'Managed browser, page, private session, and Spotify sign-in verified'];
  }
  ns.classify = classify;
  if (typeof document === 'undefined' || !document.addEventListener) return;
  function target() {
    const nodes = document.querySelectorAll('span,dt,div,td');
    for (const n of nodes) {
      if (n.children.length || n.textContent.trim() !== label) continue;
      const row = n.closest('tr,li,[class*="requirements-row"],[class*="requirement-row"]') || n.parentElement;
      const last = row?.lastElementChild;
      if (last && last !== n && !last.contains(n) && !n.contains(last)) return last;
    }
    return null;
  }
  let running = false;
  async function refresh() {
    if (running || !target()) return;
    running = true;
    try {
      const bridge = window.EveAudioflixNative;
      if (typeof bridge?.request !== 'function') throw new Error('Local EveOS bridge unavailable');
      const status = await bridge.request('/api/audioflix/spotify-browser/status',
        { method: 'GET', timeout: 7000 });
      const [value, reason] = classify(status);
      const cell = target();
      if (cell) { cell.textContent = value; cell.title = reason; cell.dataset.managedRuntimeStatus = value; }
    } catch (error) {
      const cell = target();
      if (cell) { cell.textContent = 'Status unavailable'; cell.title = String(error.message || error); }
    } finally { running = false; }
  }
  ns.refresh = refresh;
  document.addEventListener('click', event => {
    if (!event.target?.closest?.('button')) return;
    if (event.target.closest('button').textContent.trim() !== 'Check mode requirements') return;
    for (const delay of [200, 950, 2500, 4500]) setTimeout(refresh, delay);
  }, true);
  window.addEventListener('load', () => setTimeout(refresh, 400), { once: true });
})();
