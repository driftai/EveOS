(function () {
    'use strict';

    if (window.EveOSControlPlane) return;

    const STATUS_PATH = '/api/control-plane/status';
    const CANONICAL_WEB_BASE = 'http://127.0.0.1:8765';
    const POLL_MS = 5000;

    function currentLoopbackWebBase() {
        try {
            const location = window.location;
            const host = String(location?.hostname || '').toLowerCase();
            if (location?.protocol !== 'http:') return '';
            if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) return '';
            return String(location.origin || '');
        } catch (error) {
            return '';
        }
    }

    function currentLoopbackWebPort() {
        const base = currentLoopbackWebBase();
        if (!base) return 0;
        const explicit = Number(window.location?.port || 0);
        return Number.isInteger(explicit) && explicit > 0 ? explicit : 80;
    }

    function withWebPort(url) {
        const port = currentLoopbackWebPort();
        if (!port) return url;
        return `${url}${url.includes('?') ? '&' : '?'}port=${port}`;
    }

    function directWebBases() {
        const current = currentLoopbackWebBase();
        return [...new Set([current, CANONICAL_WEB_BASE].filter(Boolean))];
    }

    const DEFAULT_WEB_URL = `${currentLoopbackWebBase() || CANONICAL_WEB_BASE}/EveOS.html`;
    const state = {
        helperBaseUrl: '',
        controllerAvailable: false,
        webRunning: false,
        desiredRunning: false,
        serverState: 'checking',
        busy: false,
        message: 'Checking EveOS local control...',
        webUrl: DEFAULT_WEB_URL
    };

    let pollTimer = 0;
    function helperBaseUrl() {
        return window.EveOSLocalControl?.baseUrl()
            || `http://127.0.0.1:${
                Number(
                    window.config?.bridges?.localControlPort
                    || window.config?.bridges?.geminiControlPort
                ) || 9082
            }`;
    }

    async function fetchJson(url, options, timeoutMs) {
        const networkFetch = window.GeminiServerNetwork?.fetchJson;
        if (networkFetch) return networkFetch(url, options, timeoutMs);

        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), timeoutMs || 1200);
        try {
            const response = await fetch(url, {
                cache: 'no-store',
                ...options,
                signal: controller.signal
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.message || `Request failed (${response.status})`);
            return payload;
        } finally {
            window.clearTimeout(timer);
        }
    }

    function applyWebStatus(payload) {
        state.webRunning = payload?.running === true;
        state.desiredRunning = payload?.desiredRunning === true;
        state.serverState = String(payload?.state || (state.webRunning ? 'running' : 'stopped'));
        state.webUrl = String(payload?.url || DEFAULT_WEB_URL);
        state.message = String(payload?.message || '');
    }

    function applyDirectWebStatus(result) {
        if (!result) return false;
        const { payload, base } = result;
        state.webRunning = true;
        state.desiredRunning = payload?.desiredRunning === true || state.desiredRunning;
        state.serverState = 'running';
        state.webUrl = String(payload?.url || `${base}/EveOS.html`);
        state.message = `EveOS localhost is online at ${state.webUrl}`;
        return true;
    }

    function publish() {
        document.querySelectorAll('[data-eveos-control-plane]').forEach(renderControl);
        window.dispatchEvent(new CustomEvent('eve:eveos-control-plane-status', {
            detail: { ...state }
        }));
    }

    function statusLabel() {
        if (state.webRunning) return 'Online';
        if (state.serverState === 'starting') return 'Starting';
        if (state.serverState === 'stopping') return 'Stopping';
        if (state.serverState === 'enabling') return 'Enabling';
        if (state.serverState === 'blocked') return 'Port Blocked';
        if (state.serverState === 'error') return 'Error';
        if (state.controllerAvailable) return 'Localhost Off';
        return 'Setup';
    }

    function renderControl(control) {
        const status = control.querySelector('[data-eveos-control-status]');
        const button = control.querySelector('[data-eveos-control-toggle]');
        const label = button?.querySelector('[data-eveos-control-action-label]');
        const icon = button?.querySelector('.material-icons');
        const openButton = control.parentElement?.querySelector('[data-eveos-control-open]');
        if (!status || !button || !label || !icon) return;

        control.dataset.state = state.serverState;
        const nextStatus = statusLabel();
        const nextLabel = state.webRunning ? 'Stop' : (state.controllerAvailable ? 'Start' : 'Enable');
        const nextIcon = state.busy
            ? 'sync'
            : (state.webRunning ? 'stop' : (state.controllerAvailable ? 'play_arrow' : 'power_settings_new'));
        if (status.textContent !== nextStatus) status.textContent = nextStatus;
        if (label.textContent !== nextLabel) label.textContent = nextLabel;
        if (icon.textContent !== nextIcon) icon.textContent = nextIcon;
        button.disabled = state.busy;
        button.classList.toggle('is-busy', state.busy);
        button.setAttribute(
            'aria-label',
            state.webRunning ? 'Stop EveOS localhost' : 'Start EveOS localhost'
        );
        control.title = state.message;
        if (openButton) {
            openButton.hidden = !state.webRunning;
            openButton.title = `Open ${state.webUrl}`;
        }
    }

    async function checkDirectWeb() {
        for (const base of directWebBases()) {
            try {
                const payload = await fetchJson(`${base}/api/status`, null, 900);
                if (payload?.ok === true && payload?.service === 'eveos-local-server') {
                    return { payload, base };
                }
            } catch (error) {
                // Try the next verified localhost candidate.
            }
        }
        return null;
    }

    async function refreshStatus() {
        const baseUrl = helperBaseUrl();
        try {
            const payload = await fetchJson(withWebPort(`${baseUrl}${STATUS_PATH}`), null, 5000);
            if (payload?.service !== 'eveos-control-plane' || payload?.controllerAvailable !== true) {
                throw new Error('A different service is using the EveOS control port.');
            }
            state.helperBaseUrl = baseUrl;
            state.controllerAvailable = true;
            applyWebStatus(payload.web || {});
            if (!state.webRunning) applyDirectWebStatus(await checkDirectWeb());
        } catch (error) {
            state.helperBaseUrl = '';
            state.controllerAvailable = false;
            const direct = await checkDirectWeb();
            if (!applyDirectWebStatus(direct)) {
                state.webRunning = false;
                state.desiredRunning = false;
                state.serverState = 'unavailable';
                state.webUrl = DEFAULT_WEB_URL;
                state.message = 'Enable the one-time EveOS local control bridge to start localhost from this page.';
            } else {
                state.message += '. Enable local control to stop or manage it.';
            }
        }
        publish();
        return { ...state };
    }

    async function ensureController() {
        if (state.controllerAvailable) return true;
        state.busy = true;
        state.serverState = 'enabling';
        state.message = 'Waiting for Windows to start EveOS local control...';
        publish();
        try {
            const snapshot = await window.EveOSLocalControl.ensure({
                onProgress: () => refreshStatus()
            });
            state.helperBaseUrl = snapshot.baseUrl || helperBaseUrl();
            state.controllerAvailable = true;
            applyWebStatus(snapshot.web || {});
            return true;
        } catch (error) {
            state.serverState = 'error';
            state.message = error?.message || 'EveOS local control did not start.';
            return false;
        } finally {
            state.busy = false;
            publish();
        }
    }

    async function waitForWeb(expectedRunning) {
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
            await new Promise((resolve) => window.setTimeout(resolve, 400));
            const snapshot = await refreshStatus();
            if (snapshot.webRunning === expectedRunning) return snapshot;
            if (['error', 'blocked'].includes(snapshot.serverState)) return snapshot;
        }
        return { ...state };
    }

    async function setRunning(enabled) {
        if (state.busy) return { ...state };
        if (!state.controllerAvailable && !(await ensureController())) return { ...state };

        state.busy = true;
        state.serverState = enabled ? 'starting' : 'stopping';
        state.message = enabled ? 'Starting EveOS localhost...' : 'Stopping EveOS localhost...';
        publish();
        try {
            const payload = await fetchJson(
                withWebPort(`${state.helperBaseUrl}/api/eveos-server/${enabled ? 'start' : 'stop'}`),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}'
                },
                7000
            );
            applyWebStatus(payload);
            if (state.webRunning !== enabled && !['error', 'blocked'].includes(state.serverState)) {
                return await waitForWeb(enabled);
            }
            return { ...state };
        } catch (error) {
            state.serverState = 'error';
            state.message = error?.message || 'EveOS localhost lifecycle request failed.';
            return { ...state };
        } finally {
            state.busy = false;
            publish();
        }
    }

    function bind(root) {
        (root || document).querySelectorAll('[data-eveos-control-toggle]').forEach(function (button) {
            if (button.dataset.eveosControlBound === '1') return;
            button.dataset.eveosControlBound = '1';
            button.addEventListener('click', async function () {
                if (!state.controllerAvailable) window.EveOSLocalControl?.requestLaunch?.();
                await setRunning(!state.webRunning);
            });
        });
        (root || document).querySelectorAll('[data-eveos-control-open]').forEach(function (button) {
            if (button.dataset.eveosControlBound === '1') return;
            button.dataset.eveosControlBound = '1';
            button.addEventListener('click', function () {
                window.open(state.webUrl || DEFAULT_WEB_URL, '_blank', 'noopener');
            });
        });
        publish();
    }

    function initialize() {
        bind(document);
        refreshStatus();
        const observer = new MutationObserver(function (records) {
            const controlAdded = records.some(function (record) {
                return Array.from(record.addedNodes || []).some(function (node) {
                    if (!(node instanceof Element)) return false;
                    return node.matches?.('[data-eveos-control-toggle], [data-eveos-control-open]')
                        || Boolean(node.querySelector?.('[data-eveos-control-toggle], [data-eveos-control-open]'));
                });
            });
            if (controlAdded) bind(document);
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        pollTimer = window.setInterval(function () {
            if (document.visibilityState === 'visible' && document.getElementById('gemini-ui-root')) {
                refreshStatus();
            }
        }, POLL_MS);
    }

    window.EveOSControlPlane = Object.freeze({
        getState: () => ({
            ...state,
            bootstrapAttemptedAt: window.EveOSLocalControl?.getBootstrapAttemptedAt?.() || 0
        }),
        ensureController,
        refreshStatus,
        start: () => setRunning(true),
        stop: () => setRunning(false),
        toggle: () => setRunning(!state.webRunning)
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
