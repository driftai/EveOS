window.EveWatchFusion = window.EveWatchFusion || {};
(function () {
    'use strict';
    const api = window.EveWatchFusion;
    if (api.ready) return;

    const WATCH_URL = 'http://127-0-0-1.sslip.io:9085/';
    let overlay = null;
    let frame = null;
    let status = null;
    let busy = false;

    function controlBase() {
        if (window.EveOSLocalControl?.baseUrl) return window.EveOSLocalControl.baseUrl();
        const port = Number(window.config?.bridges?.localControlPort || window.config?.bridges?.geminiControlPort) || 9082;
        return `http://127.0.0.1:${port}`;
    }

    async function request(path, options = {}) {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 6000);
        try {
            const response = await fetch(`${controlBase()}${path}`, {
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
                ...options,
                signal: controller.signal
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok && !payload?.message) throw new Error(`WatchFusion request failed (${response.status})`);
            return payload;
        } finally {
            window.clearTimeout(timer);
        }
    }

    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[char]));
    }

    function setExpanded(expanded) {
        document.querySelectorAll('.topbar-watchfusion-btn').forEach((button) => {
            button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        });
    }

    function stateLabel() {
        if (busy) return 'Working…';
        if (status?.running) return 'Online';
        if (status?.state === 'blocked') return 'Port blocked';
        if (status?.setupRequired) return 'Setup needed';
        if (status?.installed === false) return 'Needs hydration';
        return 'Offline';
    }

    function renderStatus() {
        if (!overlay) return;
        const badge = overlay.querySelector('[data-wf-status]');
        const message = overlay.querySelector('[data-wf-message]');
        const start = overlay.querySelector('[data-wf-action="start"]');
        const stop = overlay.querySelector('[data-wf-action="stop"]');
        const external = overlay.querySelector('[data-wf-action="external"]');
        const setup = overlay.querySelector('[data-wf-setup]');
        const running = status?.running === true;
        overlay.dataset.state = running ? 'running' : (status?.state || 'stopped');
        if (badge) badge.textContent = stateLabel();
        if (message) message.textContent = status?.message || 'Checking WatchFusion…';
        if (start) start.hidden = running;
        if (stop) stop.hidden = !running;
        if (external) external.disabled = !running;
        if (setup) {
            setup.hidden = !(status?.setupRequired || status?.installed === false);
            setup.innerHTML = status?.installed === false
                ? '<strong>WatchFusion source is not hydrated yet.</strong><span>Copy the standalone WatchFusion tree into <code>tools/WatchFusion</code>.</span>'
                : '<strong>WatchFusion dependencies are not ready.</strong><span>Run <code>npm ci</code> inside <code>tools/WatchFusion</code>, then retry.</span>';
        }
        if (frame) {
            frame.hidden = !running;
            if (running && frame.dataset.loaded !== '1') {
                frame.dataset.loaded = '1';
                frame.src = `${status?.url || WATCH_URL}?eveos=1`;
            }
        }
    }

    function ensureOverlay() {
        if (overlay) return overlay;
        overlay = document.createElement('section');
        overlay.id = 'watchfusion-overlay';
        overlay.className = 'watchfusion-overlay';
        overlay.hidden = true;
        overlay.innerHTML = `
            <div class="watchfusion-shell" role="dialog" aria-modal="true" aria-labelledby="watchfusion-title">
                <header class="watchfusion-shell-head">
                    <div class="watchfusion-brand">
                        <span class="watchfusion-brand-mark">◉</span>
                        <div><strong id="watchfusion-title">WatchFusion</strong><span>Watch, convert, and sync together inside EveOS</span></div>
                    </div>
                    <div class="watchfusion-head-actions">
                        <span class="watchfusion-status" data-wf-status>Checking…</span>
                        <button type="button" data-wf-action="refresh">Refresh</button>
                        <button type="button" data-wf-action="external">Open separate</button>
                        <button type="button" data-wf-action="close" class="watchfusion-close" aria-label="Close WatchFusion">×</button>
                    </div>
                </header>
                <div class="watchfusion-service-bar">
                    <span data-wf-message>Checking WatchFusion…</span>
                    <div>
                        <button type="button" data-wf-action="start">Start WatchFusion</button>
                        <button type="button" data-wf-action="stop" hidden>Stop</button>
                    </div>
                </div>
                <div class="watchfusion-setup" data-wf-setup hidden></div>
                <div class="watchfusion-frame-wrap">
                    <iframe class="watchfusion-frame" title="WatchFusion" allow="autoplay; encrypted-media; fullscreen; picture-in-picture; web-share" allowfullscreen hidden></iframe>
                    <div class="watchfusion-idle">
                        <div class="watchfusion-idle-orb">WF</div>
                        <strong>WatchFusion is ready to join EveOS.</strong>
                        <span>Its media server stays isolated on port 9085 while EveOS owns lifecycle, status, theme shell, and verification.</span>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        frame = overlay.querySelector('.watchfusion-frame');
        overlay.addEventListener('click', async (event) => {
            const action = event.target.closest('[data-wf-action]')?.dataset.wfAction;
            if (!action) return;
            if (action === 'close') return close();
            if (action === 'external') return window.open(status?.url || WATCH_URL, '_blank', 'noopener');
            if (action === 'refresh') return refresh();
            if (action === 'start') return setRunning(true);
            if (action === 'stop') return setRunning(false);
        });
        return overlay;
    }

    async function refresh() {
        ensureOverlay();
        try {
            status = await request('/api/watchfusion/status');
        } catch (error) {
            status = { ok: false, running: false, state: 'error', message: error?.message || 'WatchFusion status unavailable.' };
        }
        renderStatus();
        window.dispatchEvent(new CustomEvent('eve:watchfusion-status', { detail: { ...status } }));
        return status;
    }

    async function setRunning(enabled) {
        if (busy) return status;
        busy = true;
        renderStatus();
        try {
            status = await request(`/api/watchfusion/${enabled ? 'start' : 'stop'}`, { method: 'POST', body: '{}' });
            if (enabled && status?.running && frame) {
                frame.dataset.loaded = '';
            }
        } catch (error) {
            status = { ...(status || {}), running: false, state: 'error', message: error?.message || 'WatchFusion lifecycle request failed.' };
        } finally {
            busy = false;
            renderStatus();
        }
        return status;
    }

    async function open() {
        const root = ensureOverlay();
        root.hidden = false;
        setExpanded(true);
        const current = await refresh();
        if (!current?.running && current?.installed && !current?.setupRequired && current?.state !== 'blocked') {
            await setRunning(true);
        }
    }

    function close() {
        if (!overlay) return;
        overlay.hidden = true;
        setExpanded(false);
    }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && overlay && !overlay.hidden) close();
    });

    Object.assign(api, {
        ready: true,
        open,
        close,
        refresh,
        start: () => setRunning(true),
        stop: () => setRunning(false),
        getState: () => ({ ...(status || {}), open: Boolean(overlay && !overlay.hidden), busy })
    });
    if (window.__eveWatchFusionOpenPending) {
        window.__eveWatchFusionOpenPending = false;
        open();
    }
})();
