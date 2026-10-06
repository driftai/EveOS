window.EveWorldBook = window.EveWorldBook || {};

(function (ns) {
    'use strict';

    const STATUS_PATH = '/api/world-book/status';
    const HEALTH_PATH = 'api/health';
    const REFRESH_TTL_MS = 4000;
    const state = {
        baseUrl: '',
        controllerAvailable: false,
        directAvailable: false,
        installed: true,
        running: false,
        desiredRunning: false,
        serverState: 'checking',
        source: 'none',
        busy: false,
        url: 'http://127.0.0.1:8766/',
        instanceId: '',
        message: 'Checking World Book...'
    };
    let refreshPromise = null;
    let lastRefreshAt = 0;

    function worldBookUrl() {
        const configured = Number(window.config?.bridges?.worldBookPort) || 8766;
        return `http://127.0.0.1:${configured}/`;
    }

    function candidateBases() {
        const bases = [];
        const helperBase = window.EveOSLocalControl?.baseUrl?.();
        const helperPort = Number(
            window.config?.bridges?.localControlPort
            || window.config?.bridges?.geminiControlPort
        ) || 9082;
        bases.push(helperBase || `http://127.0.0.1:${helperPort}`);
        if (/^https?:$/.test(window.location.protocol)
            && /^(127\.0\.0\.1|localhost)$/i.test(window.location.hostname)) {
            bases.push(window.location.origin);
        }
        const configured = Number(window.config?.bridges?.serverPort) || 8765;
        [8765, configured, 3000].forEach(function (port) {
            bases.push(`http://127.0.0.1:${port}`);
        });
        return Array.from(new Set(bases));
    }

    async function fetchJson(url, options, timeoutMs) {
        const controller = new AbortController();
        const timer = window.setTimeout(function () {
            controller.abort();
        }, timeoutMs || 1400);
        try {
            const response = await fetch(url, {
                cache: 'no-store',
                ...options,
                signal: controller.signal
            });
            const payload = await response.json().catch(function () {
                return {};
            });
            if (!response.ok) {
                throw new Error(payload.message || `Request failed (${response.status})`);
            }
            return payload;
        } finally {
            window.clearTimeout(timer);
        }
    }

    function applyStatus(payload, baseUrl, shouldPublish) {
        state.baseUrl = baseUrl || state.baseUrl;
        state.controllerAvailable = true;
        state.installed = payload.installed !== false;
        state.running = payload.running === true;
        state.directAvailable = state.running;
        state.desiredRunning = payload.desiredRunning === true;
        state.serverState = String(payload.state || (state.running ? 'running' : 'stopped'));
        state.url = String(payload.url || state.url);
        state.instanceId = String(payload.instanceId || state.instanceId || '');
        state.source = state.running ? 'managed' : 'none';
        state.message = String(payload.message || '');
        if (shouldPublish !== false) publish();
        return { ...state };
    }

    function applyDirectStatus(payload) {
        state.controllerAvailable = false;
        state.directAvailable = true;
        state.installed = true;
        state.running = true;
        state.serverState = 'running';
        state.source = 'standalone';
        state.url = worldBookUrl();
        state.appVersion = String(payload.appVersion || '');
        state.instanceId = String(payload.instanceId || '');
        state.message = 'World Book is online through its standalone launcher.';
        publish();
        return { ...state };
    }

    function publish() {
        window.dispatchEvent(new CustomEvent('eve:world-book-status', {
            detail: { ...state }
        }));
    }

    async function probeController(baseUrl, index = 0) {
        try {
            const timeout = baseUrl === window.location.origin ? 1200 : 900;
            const payload = await fetchJson(`${baseUrl}${STATUS_PATH}`, null, timeout);
            return { baseUrl, payload, index };
        } catch (error) {
            return null;
        }
    }

    async function findController() {
        // Once discovery has resolved a controller, use that one directly. The previous version
        // re-probed every candidate (9082, 8765, 3000...) on every refresh, which multiplied one
        // UI status tick into several /api/world-book/status requests.
        if (state.baseUrl) {
            const preferred = await probeController(state.baseUrl, 0);
            if (preferred) return preferred;
            state.baseUrl = '';
        }
        const bases = candidateBases();
        const attempts = await Promise.all(bases.map((baseUrl, index) => probeController(baseUrl, index)));
        return attempts.filter(Boolean).sort((a, b) => a.index - b.index)[0] || null;
    }

    async function findDirectServer() {
        const url = worldBookUrl();
        try {
            const payload = await fetchJson(`${url}${HEALTH_PATH}`, null, 650);
            if (payload.ok !== true || payload.service !== 'world-book' || !payload.appVersion) {
                return null;
            }
            return payload;
        } catch (error) {
            return null;
        }
    }

    function mergeManagedDirect(found, direct) {
        applyStatus(found.payload, found.baseUrl, false);
        if (direct) {
            state.directAvailable = true;
            state.running = true;
            state.serverState = 'running';
            state.source = 'managed';
            state.url = worldBookUrl();
            state.appVersion = String(direct.appVersion || state.appVersion || '');
            state.instanceId = String(direct.instanceId || found.payload.instanceId || state.instanceId || '');
            state.message = found.payload.message || 'World Book is online.';
        }
        publish();
        return { ...state };
    }

    async function runRefresh() {
        const controllerPromise = findController();
        const direct = await findDirectServer();
        if (direct) {
            const quickController = await Promise.race([
                controllerPromise,
                new Promise((resolve) => window.setTimeout(() => resolve(null), 60))
            ]);
            if (quickController) return mergeManagedDirect(quickController, direct);
            const immediate = applyDirectStatus(direct);
            void controllerPromise.then(function (found) {
                if (found) mergeManagedDirect(found, direct);
            });
            return immediate;
        }
        const found = await controllerPromise;
        if (found) return mergeManagedDirect(found, null);
        state.baseUrl = '';
        state.controllerAvailable = false;
        state.directAvailable = false;
        state.running = false;
        state.serverState = 'unavailable';
        state.source = 'none';
        state.url = worldBookUrl();
        state.message = 'World Book is stopped. Start it here when you need it.';
        publish();
        return { ...state };
    }

    function refresh(force = false) {
        if (refreshPromise) return refreshPromise;
        if (!force && lastRefreshAt && (Date.now() - lastRefreshAt) < REFRESH_TTL_MS) {
            return Promise.resolve({ ...state });
        }
        refreshPromise = runRefresh()
            .then(function (snapshot) {
                lastRefreshAt = Date.now();
                return snapshot;
            })
            .finally(function () {
                refreshPromise = null;
            });
        return refreshPromise;
    }

    async function ensureController() {
        const found = await findController();
        if (found?.baseUrl) return found;

        const localControl = window.EveOSLocalControl;
        if (!localControl?.ensure) {
            throw new Error(
                'EveOS local control is unavailable. Reload EveOS, then try again.'
            );
        }

        state.serverState = 'enabling';
        state.message = 'Starting EveOS local control for World Book...';
        publish();
        const control = await localControl.ensure({
            userInitiated: true,
            onLaunching: function () {
                state.message = 'Approve the browser prompt to start World Book local control.';
                publish();
            }
        });
        const baseUrl = control.baseUrl || localControl.baseUrl();
        const payload = await fetchJson(`${baseUrl}${STATUS_PATH}`, null, 3500);
        state.baseUrl = baseUrl;
        state.controllerAvailable = true;
        return { baseUrl, payload };
    }

    async function waitFor(expectedRunning) {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            await new Promise((resolve) => window.setTimeout(resolve, 350));
            const snapshot = await refresh(true);
            if (snapshot.running === expectedRunning) return snapshot;
            if (snapshot.serverState === 'error' || snapshot.serverState === 'blocked') return snapshot;
        }
        return { ...state };
    }

    async function setRunning(enabled) {
        if (state.busy) return { ...state };
        state.busy = true;
        state.serverState = enabled ? 'starting' : 'stopping';
        state.message = enabled ? 'Starting World Book...' : 'Stopping World Book...';
        publish();
        try {
            const found = await ensureController();
            const payload = await fetchJson(
                `${found.baseUrl}/api/world-book/${enabled ? 'start' : 'stop'}`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
                5000
            );
            lastRefreshAt = Date.now();
            applyStatus(payload, found.baseUrl);
            if (state.running !== enabled && !['error', 'blocked'].includes(state.serverState)) {
                return await waitFor(enabled);
            }
            return { ...state };
        } catch (error) {
            state.serverState = 'error';
            state.message = error?.message || 'World Book lifecycle request failed.';
            lastRefreshAt = 0;
            publish();
            return { ...state };
        } finally {
            state.busy = false;
            publish();
        }
    }

    ns.client = Object.freeze({
        state,
        ensureController,
        refresh,
        start: () => setRunning(true),
        stop: () => setRunning(false)
    });

    // Prime status during EveOS boot so opening Notes & World Books does not pay discovery latency.
    window.setTimeout(() => { void refresh(true); }, 0);
})(window.EveWorldBook);
