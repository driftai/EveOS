window.EveWatchFusion = window.EveWatchFusion || {};
(function () {
    'use strict';
    const api = window.EveWatchFusion;
    if (api.ready) return;
    const DETACHED_WINDOW_NAME = 'eveWatchFusionWindow';
    let overlay = null;
    let frame = null;
    let status = null;
    let busy = false;
    let controllerAvailable = null;
    let controlPortCurrent = null;
    let detachedWindow = null;
    let detachedPresence = false;
    let detachedPresenceUrl = '';
    let runtimePollTimer = null;

    function registryPort(name, fallback = 0) {
        return Number(window.EveOSPortRegistry?.get?.(name, fallback)) || Number(fallback) || 0;
    }
    function sensor() { return window.EveWatchFusionRuntimeSensor; }
    function controlBase() {
        if (window.EveOSLocalControl?.baseUrl) return window.EveOSLocalControl.baseUrl();
        const port = Number(window.config?.bridges?.localControlPort || window.config?.bridges?.geminiControlPort)
            || registryPort('GEMINI_CONTROL_PORT');
        return `http://127.0.0.1:${port}`;
    }
    async function request(path, options = {}) {
        const { timeoutMs: requestedTimeout, ...fetchOptions } = options;
        const timeoutMs = Number(requestedTimeout) > 0 ? Number(requestedTimeout) : 6000;
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(`${controlBase()}${path}`, {
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json', ...(fetchOptions.headers || {}) },
                ...fetchOptions,
                signal: controller.signal
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload?.message || payload?.error || `WatchFusion request failed (${response.status})`);
            return payload;
        } finally {
            window.clearTimeout(timer);
        }
    }
    function prepareOpen() {
        // Opening WatchFusion is presentation-only. Presentation-only: the header must never start a terminal or runtime.
    }
    async function verifyWatchFusionControl() {
        try {
            const snapshot = await request('/api/watchfusion/status');
            const matches = sensor()?.matchesControlStatus?.(snapshot) !== false;
            controlPortCurrent = matches;
            if (!matches) {
                status = {
                    ...(status || {}), state: status?.running ? 'running' : 'degraded',
                    message: 'EveOS local control is using an outdated WatchFusion port assignment. Restart local control; browsing remains available.'
                };
                renderStatus();
            }
            return matches;
        } catch {
            controlPortCurrent = null;
            return false;
        }
    }
    async function ensureControl() {
        if (controllerAvailable === true && controlPortCurrent === true) return true;
        try {
            await window.EveOSLocalControl?.ensure?.({
                timeoutMs: 45000,
                onProgress: (snapshot) => {
                    if (snapshot?.controllerAvailable) controllerAvailable = true;
                }
            });
            controllerAvailable = true;
            return await verifyWatchFusionControl();
        } catch {
            controllerAvailable = false;
            controlPortCurrent = null;
            status = {
                ...(status || {}), ok: false, state: status?.running ? 'running' : 'degraded',
                message: status?.running
                    ? 'WatchFusion is online, but local lifecycle control is unavailable.'
                    : 'Local control is off. Browse the workspace now; enable control only when you need runtime actions.'
            };
            renderStatus();
            return false;
        }
    }
    function setExpanded(expanded) {
        document.querySelectorAll('.topbar-watchfusion-btn').forEach((button) => {
            button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        });
    }
    function setDetachedIndicator(active, url = '') {
        detachedPresence = Boolean(active);
        if (url) detachedPresenceUrl = url;
        document.querySelectorAll('.topbar-watchfusion-btn').forEach((button) => {
            button.dataset.detached = detachedPresence ? '1' : '0';
            button.title = detachedPresence ? 'WatchFusion · detached window active' : 'WatchFusion';
        });
        const detach = overlay?.querySelector('[data-wf-action="detach"]');
        if (detach) detach.textContent = detachedPresence ? '↗ Detached' : '↗ Detach';
    }
    function stateLabel() {
        if (busy) return 'Working…';
        if (controlPortCurrent === false) return status?.running ? 'Online · restart control' : 'Restart control';
        if (status?.running && controllerAvailable === false) return 'Online · control off';
        if (status?.running) return 'Online';
        if (status?.state === 'blocked') return 'Port blocked';
        if (status?.setupRequired) return 'Setup needed';
        if (status?.installed === false) return 'Needs source';
        if (controllerAvailable === false || status?.state === 'degraded') return 'Browse · control off';
        return 'Ready · stopped';
    }
    function renderComponents() {
        const root = overlay?.querySelector('[data-wf-components]');
        if (!root) return;
        root.replaceChildren();
        const components = status?.components || {};
        for (const key of ['core', 'nuvio', 'voxelvision', 'voxelYoutube', 'browserModels']) {
            const component = components[key];
            if (!component) continue;
            const card = document.createElement('article');
            card.className = 'watchfusion-component';
            card.dataset.ready = component.ready === true ? '1' : component.ready === false ? '0' : 'ondemand';
            const head = document.createElement('div');
            const label = document.createElement('strong');
            const badge = document.createElement('span');
            label.textContent = component.label || key;
            badge.textContent = component?.ready === true ? 'Ready' : component?.ready === false ? 'Needs setup' : 'On demand';
            head.append(label, badge);
            const text = document.createElement('p');
            text.textContent = component.message || '';
            card.append(head, text);
            root.append(card);
        }
    }
    function runtimeUrl() {
        const raw = String(status?.url || '').trim();
        if (!raw) return null;
        try {
            const parsed = new URL(raw);
            return /^https?:$/.test(parsed.protocol) ? parsed : null;
        } catch {
            return null;
        }
    }
    function embeddedUrl() {
        const url = runtimeUrl();
        if (!url) return 'about:blank';
        url.searchParams.set('eveos', '1');
        url.searchParams.delete('eveosDetached');
        return url.href;
    }
    function detachedUrl() {
        const url = runtimeUrl();
        if (!url) return null;
        url.searchParams.delete('eveos');
        url.searchParams.set('eveosDetached', '1');
        return url;
    }
    function detachedFeatures() {
        const availableWidth = Math.max(900, Number(window.screen?.availWidth) || 1440);
        const availableHeight = Math.max(680, Number(window.screen?.availHeight) || 900);
        const width = Math.min(1500, Math.max(900, availableWidth - 100));
        const height = Math.min(1000, Math.max(680, availableHeight - 100));
        const left = Math.max(0, Math.round((availableWidth - width) / 2));
        const top = Math.max(0, Math.round((availableHeight - height) / 2));
        return `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`;
    }
    function renderStatus() {
        if (!overlay) return;
        const badge = overlay.querySelector('[data-wf-status]');
        const message = overlay.querySelector('[data-wf-message]');
        const stop = overlay.querySelector('[data-wf-action="stop"]');
        const detach = overlay.querySelector('[data-wf-action="detach"]');
        const setup = overlay.querySelector('[data-wf-setup]');
        const running = status?.running === true;
        overlay.dataset.state = running ? 'running' : (status?.state || 'stopped');
        if (badge) badge.textContent = stateLabel();
        if (message) message.textContent = status?.message || 'WatchFusion workspace ready.';
        overlay.querySelectorAll('[data-wf-action="start"]').forEach((start) => {
            start.hidden = running || Boolean(status?.setupRequired) || status?.installed === false;
            start.disabled = busy || controlPortCurrent === false;
        });
        if (stop) {
            stop.hidden = !running;
            stop.disabled = busy || controlPortCurrent === false;
        }
        if (detach) {
            detach.disabled = !running || busy || !runtimeUrl();
            detach.textContent = detachedPresence ? '↗ Detached' : '↗ Detach';
        }
        if (setup) {
            setup.hidden = !(status?.setupRequired || status?.installed === false);
            setup.replaceChildren();
            if (!setup.hidden) {
                const strong = document.createElement('strong');
                const detail = document.createElement('span');
                if (status?.installed === false) {
                    strong.textContent = 'WatchFusion source is missing.';
                    detail.textContent = 'Pull the complete EveOS main branch; tools/WatchFusion is part of the repository.';
                    setup.append(strong, detail);
                } else {
                    strong.textContent = 'WatchFusion core dependencies need setup.';
                    detail.textContent = status?.npmReady === false
                        ? 'Install Node.js/npm first, then refresh this workspace.'
                        : 'Install the locked Node dependencies. This does not start WatchFusion.';
                    setup.append(strong, detail);
                    if (status?.setupAvailable) {
                        const button = document.createElement('button');
                        button.type = 'button';
                        button.dataset.wfAction = 'setup-core';
                        button.textContent = busy ? 'Installing…' : 'Install WatchFusion Core';
                        button.disabled = busy || controlPortCurrent === false;
                        setup.append(button);
                    }
                }
            }
        }
        renderComponents();
        if (frame) {
            frame.hidden = !running;
            if (running && frame.dataset.loaded !== '1') {
                const nextUrl = embeddedUrl();
                frame.dataset.loaded = nextUrl === 'about:blank' ? '' : '1';
                frame.src = nextUrl;
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
                <header class="watchfusion-shell-head"><div class="watchfusion-brand"><span class="watchfusion-brand-mark">◉</span><div><strong id="watchfusion-title">WatchFusion</strong><span>Media, VoxelVision, Nuvio, and WatchParty inside EveOS</span></div></div><div class="watchfusion-head-actions"><span class="watchfusion-status" data-wf-status>Checking…</span><button type="button" data-wf-action="refresh">Refresh</button><button type="button" data-wf-action="detach" title="Detach WatchFusion into its own window">↗ Detach</button><button type="button" data-wf-action="close" class="watchfusion-close" aria-label="Close WatchFusion">×</button></div></header>
                <div class="watchfusion-service-bar"><span data-wf-message>Checking WatchFusion…</span><div><button type="button" data-wf-action="start">Start WatchFusion</button><button type="button" data-wf-action="stop" hidden>Stop</button></div></div>
                <div class="watchfusion-setup" data-wf-setup hidden></div>
                <div class="watchfusion-frame-wrap"><iframe class="watchfusion-frame" title="WatchFusion" allow="autoplay; encrypted-media; fullscreen; picture-in-picture; web-share" allowfullscreen hidden></iframe><div class="watchfusion-idle"><div class="watchfusion-idle-copy"><div class="watchfusion-idle-orb">WF</div><div><strong>WatchFusion workspace</strong><span>The workspace stays available without starting its Node runtime. Browse readiness below, then start only when live media features are needed.</span></div></div><div class="watchfusion-components" data-wf-components></div><div class="watchfusion-idle-actions"><button type="button" data-wf-action="refresh">Refresh setup</button><button type="button" data-wf-action="start">Start WatchFusion</button></div></div></div>
            </div>`;
        document.body.appendChild(overlay);
        frame = overlay.querySelector('.watchfusion-frame');
        overlay.addEventListener('click', async (event) => {
            const action = event.target.closest('[data-wf-action]')?.dataset.wfAction;
            if (!action) return;
            if (action === 'close') return close();
            if (action === 'detach') return detach();
            if (action === 'refresh') return refresh();
            if (action === 'start') return setRunning(true);
            if (action === 'stop') return setRunning(false);
            if (action === 'setup-core') return setupCore();
        });
        return overlay;
    }
    async function refresh() {
        ensureOverlay();
        let controlled = null;
        try {
            controlled = await request('/api/watchfusion/status');
            controllerAvailable = true;
            controlPortCurrent = sensor()?.matchesControlStatus?.(controlled) !== false;
        } catch {
            controllerAvailable = false;
            controlPortCurrent = null;
        }
        const direct = await sensor()?.probe?.(controlPortCurrent === false ? null : (controlled?.url || status?.url));
        if (direct) {
            const controlWasStale = controllerAvailable && (controlPortCurrent === false || controlled?.running !== true);
            status = {
                ...(status || {}), ...(controlPortCurrent === false ? {} : (controlled || {})),
                ok: true, running: true, state: 'running', controllerAvailable,
                controlPortCurrent, directRuntime: true, port: direct.port, url: direct.url,
                message: controlPortCurrent === false
                    ? 'WatchFusion is online on its registered port. Restart EveOS local control before using lifecycle/setup actions.'
                    : controllerAvailable
                        ? (controlWasStale ? 'WatchFusion runtime detected directly; lifecycle status was stale and has been reconciled.' : (controlled?.message || 'WatchFusion is online.'))
                        : 'WatchFusion runtime detected directly. Media stays available; Start/Stop/Setup require local control.'
            };
        } else if (controlled && controlPortCurrent !== false) {
            status = { ...controlled, controlPortCurrent: true, directRuntime: false };
        } else if (controlPortCurrent === false) {
            status = {
                ...(status || {}), ok: true, running: false, state: 'degraded', controllerAvailable: true,
                controlPortCurrent: false, port: registryPort('WATCHFUSION_PORT'), directRuntime: false,
                message: 'EveOS local control is running with an outdated WatchFusion port assignment. Restart local control; the workspace remains browsable.'
            };
        } else {
            status = {
                ...(status || {}), ok: true, running: false, state: 'degraded', controllerAvailable: false,
                controlPortCurrent: null, directRuntime: false,
                message: 'Local control is off. You can still browse WatchFusion feature areas; enable control only when you need live runtime actions.'
            };
        }
        renderStatus();
        window.dispatchEvent(new CustomEvent('eve:watchfusion-status', { detail: { ...status } }));
        return status;
    }
    async function setupCore() {
        if (busy) return status;
        busy = true;
        renderStatus();
        try {
            if (!(await ensureControl())) return status;
            status = await request('/api/watchfusion/setup', {
                method: 'POST', body: JSON.stringify({ component: 'core' }), timeoutMs: 10 * 60 * 1000
            });
            if (frame) frame.dataset.loaded = '';
        } catch (error) {
            status = { ...(status || {}), running: false, state: 'error', message: error?.message || 'WatchFusion setup failed.' };
        } finally {
            busy = false;
            renderStatus();
        }
        return status;
    }
    async function setRunning(enabled) {
        if (busy) return status;
        busy = true;
        renderStatus();
        try {
            if (!(await ensureControl())) return status;
            status = await request(`/api/watchfusion/${enabled ? 'start' : 'stop'}`, { method: 'POST', body: '{}' });
            if (frame) {
                frame.dataset.loaded = '';
                if (!enabled || !status?.running) frame.src = 'about:blank';
            }
            await refresh();
        } catch (error) {
            status = { ...(status || {}), state: status?.running ? 'running' : 'degraded', message: error?.message || 'WatchFusion lifecycle request failed.' };
        } finally {
            busy = false;
            renderStatus();
        }
        return status;
    }
    function detach() {
        if (!status?.running) return null;
        const targetUrl = detachedUrl();
        if (!targetUrl) return null;
        if (detachedWindow && !detachedWindow.closed) {
            detachedWindow.focus();
            close();
            return detachedWindow;
        }
        detachedWindow = window.open(targetUrl.href, DETACHED_WINDOW_NAME, detachedFeatures());
        if (!detachedWindow) {
            status = { ...(status || {}), message: 'Detach window was blocked. Allow pop-ups for EveOS and try again.' };
            renderStatus();
            return null;
        }
        detachedWindow.focus();
        setDetachedIndicator(true, targetUrl.href);
        close();
        return detachedWindow;
    }
    function startRuntimePolling() {
        if (runtimePollTimer) return;
        runtimePollTimer = window.setInterval(() => {
            if (!busy && overlay && !overlay.hidden) refresh();
        }, 3000);
    }
    function stopRuntimePolling() {
        if (!runtimePollTimer) return;
        window.clearInterval(runtimePollTimer);
        runtimePollTimer = null;
    }
    async function open() {
        const root = ensureOverlay();
        root.hidden = false;
        setExpanded(true);
        startRuntimePolling();
        await refresh();
    }
    function close() {
        if (!overlay) return;
        overlay.hidden = true;
        setExpanded(false);
        stopRuntimePolling();
    }
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && overlay && !overlay.hidden) close();
    });
    window.addEventListener('eve:watchfusion-presence', (event) => {
        const detail = event.detail || {};
        setDetachedIndicator(Boolean(detail.detached), detail.detachedUrl || detachedPresenceUrl);
    });
    Object.assign(api, {
        ready: true, prepareOpen, open, close, detach, refresh, setupCore,
        start: () => setRunning(true), stop: () => setRunning(false),
        getDetachedWindow: () => detachedWindow,
        getState: () => ({
            ...(status || {}), open: Boolean(overlay && !overlay.hidden), busy,
            controllerAvailable, controlPortCurrent, detached: detachedPresence,
            detachedUrl: detachedPresenceUrl, presence: sensor()?.heartbeatState?.() || null
        })
    });
    if (window.__eveWatchFusionOpenPending) {
        window.__eveWatchFusionOpenPending = false;
        open();
    }
})();
