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
    let detachedWindow = null;

    function controlBase() {
        if (window.EveOSLocalControl?.baseUrl) return window.EveOSLocalControl.baseUrl();
        const port = Number(window.config?.bridges?.localControlPort || window.config?.bridges?.geminiControlPort) || 9082;
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
            if (!response.ok) {
                throw new Error(payload?.message || payload?.error || `WatchFusion request failed (${response.status})`);
            }
            return payload;
        } finally {
            window.clearTimeout(timer);
        }
    }

    async function probeControl() {
        try {
            await window.EveOSLocalControl?.health?.(1000);
            controllerAvailable = true;
        } catch {
            controllerAvailable = false;
        }
        return controllerAvailable;
    }

    function prepareOpen() {
        // Opening WatchFusion is presentation-only. Never launch a terminal or
        // service from the header click; explicit Start/Setup actions do that.
        probeControl();
    }

    async function ensureControl() {
        if (controllerAvailable === true) return true;
        try {
            await window.EveOSLocalControl?.ensure?.({
                timeoutMs: 45000,
                onProgress: (snapshot) => {
                    if (snapshot?.controllerAvailable) controllerAvailable = true;
                }
            });
            controllerAvailable = true;
            return true;
        } catch (error) {
            controllerAvailable = false;
            status = {
                ...(status || {}), ok: false, running: false, state: 'error',
                message: error?.message || 'EveOS local control is unavailable.'
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

    function stateLabel() {
        if (busy) return 'Working…';
        if (status?.running) return 'Online';
        if (status?.state === 'blocked') return 'Port blocked';
        if (status?.setupRequired) return 'Setup needed';
        if (status?.installed === false) return 'Needs source';
        if (controllerAvailable === false || status?.state === 'error') return 'Control offline';
        return 'Ready · stopped';
    }

    function componentState(component) {
        if (component?.ready === true) return 'Ready';
        if (component?.ready === false) return 'Needs setup';
        return 'On demand';
    }

    function renderComponents() {
        const root = overlay?.querySelector('[data-wf-components]');
        if (!root) return;
        root.replaceChildren();
        const components = status?.components || {};
        const order = ['core', 'nuvio', 'voxelvision', 'voxelYoutube', 'browserModels'];
        for (const key of order) {
            const component = components[key];
            if (!component) continue;
            const card = document.createElement('article');
            card.className = 'watchfusion-component';
            card.dataset.ready = component.ready === true ? '1' : component.ready === false ? '0' : 'ondemand';
            const head = document.createElement('div');
            const label = document.createElement('strong');
            const badge = document.createElement('span');
            label.textContent = component.label || key;
            badge.textContent = componentState(component);
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
        return url.href;
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
        if (message) message.textContent = status?.message || 'Checking WatchFusion…';
        overlay.querySelectorAll('[data-wf-action="start"]').forEach((start) => {
            start.hidden = running || Boolean(status?.setupRequired) || status?.installed === false;
            start.disabled = busy;
        });
        if (stop) stop.hidden = !running;
        if (detach) detach.disabled = !running || busy || !runtimeUrl();
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
                        button.disabled = busy;
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
                <header class="watchfusion-shell-head">
                    <div class="watchfusion-brand">
                        <span class="watchfusion-brand-mark">◉</span>
                        <div><strong id="watchfusion-title">WatchFusion</strong><span>Media, VoxelVision, Nuvio, and WatchParty inside EveOS</span></div>
                    </div>
                    <div class="watchfusion-head-actions">
                        <span class="watchfusion-status" data-wf-status>Checking…</span>
                        <button type="button" data-wf-action="refresh">Refresh</button>
                        <button type="button" data-wf-action="detach" title="Detach WatchFusion into its own window">↗ Detach</button>
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
                        <div class="watchfusion-idle-copy">
                            <div class="watchfusion-idle-orb">WF</div>
                            <div><strong>WatchFusion workspace</strong><span>The workspace is available without starting its Node runtime. Review setup below, then start only when you want media/runtime features.</span></div>
                        </div>
                        <div class="watchfusion-components" data-wf-components></div>
                        <div class="watchfusion-idle-actions">
                            <button type="button" data-wf-action="refresh">Refresh setup</button>
                            <button type="button" data-wf-action="start">Start WatchFusion</button>
                        </div>
                    </div>
                </div>
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
        try {
            status = await request('/api/watchfusion/status');
            controllerAvailable = true;
        } catch (error) {
            controllerAvailable = false;
            status = {
                ...(status || {}), ok: false, running: false, state: 'error',
                message: error?.message || 'Local control is off. The workspace can stay open; Start will offer to enable it.'
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
        } catch (error) {
            status = { ...(status || {}), running: false, state: 'error', message: error?.message || 'WatchFusion lifecycle request failed.' };
        } finally {
            busy = false;
            renderStatus();
        }
        return status;
    }

    function detach() {
        if (!status?.running) return null;
        const targetUrl = runtimeUrl();
        if (!targetUrl) {
            status = { ...(status || {}), message: 'WatchFusion is online but did not publish a usable runtime URL. Refresh status and try again.' };
            renderStatus();
            return null;
        }
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
        close();
        return detachedWindow;
    }

    async function open() {
        const root = ensureOverlay();
        root.hidden = false;
        setExpanded(true);
        await refresh();
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
        prepareOpen,
        open,
        close,
        detach,
        refresh,
        setupCore,
        start: () => setRunning(true),
        stop: () => setRunning(false),
        getDetachedWindow: () => detachedWindow,
        getState: () => ({ ...(status || {}), open: Boolean(overlay && !overlay.hidden), busy, controllerAvailable })
    });
    probeControl();
    if (window.__eveWatchFusionOpenPending) {
        window.__eveWatchFusionOpenPending = false;
        open();
    }
})();
