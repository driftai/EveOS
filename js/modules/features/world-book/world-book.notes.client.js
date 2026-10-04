window.EveWorldBook = window.EveWorldBook || {};

(function (ns) {
    'use strict';

    const STATUS_PATH = '/api/notes-service/status';
    const state = {
        running: false, busy: false, serverState: 'checking', controllerAvailable: false,
        port: 8767, url: 'http://127.0.0.1:8767', message: 'Checking EveOS Notes…'
    };
    let baseUrl = '';
    let refreshPromise = null;

    function notesPort() {
        return Number(window.config?.bridges?.notesPort)
            || Number(window.EveOSPortRegistry?.get?.('NOTES_PORT', 8767)) || 8767;
    }

    function notesBase() { return `http://127.0.0.1:${notesPort()}`; }

    function publish() {
        window.dispatchEvent(new CustomEvent('eve:notes-status', { detail: { ...state } }));
    }

    async function fetchJson(url, options, timeoutMs = 1800) {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { cache: 'no-store', ...options, signal: controller.signal });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.ok === false) {
                const error = new Error(payload.message || `Notes request failed (${response.status}).`);
                error.payload = payload;
                throw error;
            }
            return payload;
        } catch (error) {
            if (error?.name === 'AbortError') throw new Error('EveOS Notes did not respond in time.');
            throw error;
        } finally { window.clearTimeout(timer); }
    }

    async function directHealth() {
        const payload = await fetchJson(`${notesBase()}/api/health`, undefined, 700);
        if (payload.service !== 'eveos-notes') throw new Error('A different service is using the Notes port.');
        return payload;
    }

    async function controllerBase({ userInitiated = false } = {}) {
        if (baseUrl) return baseUrl;
        const localControl = window.EveOSLocalControl;
        if (!localControl?.ensure) throw new Error('EveOS local control is unavailable.');
        const control = await localControl.ensure({
            userInitiated,
            onLaunching() {
                state.serverState = 'enabling';
                state.message = 'Starting EveOS local control for Notes…';
                publish();
            }
        });
        baseUrl = String(control?.baseUrl || localControl.baseUrl?.() || '').replace(/\/$/, '');
        if (!baseUrl) throw new Error('EveOS local control is unavailable.');
        return baseUrl;
    }

    function applyStatus(payload) {
        state.running = payload.running === true;
        state.controllerAvailable = true;
        state.serverState = String(payload.state || (state.running ? 'running' : 'stopped'));
        state.port = Number(payload.port) || notesPort();
        state.url = String(payload.url || notesBase()).replace(/\/$/, '');
        state.message = String(payload.message || (state.running ? 'EveOS Notes is ready.' : 'EveOS Notes is stopped.'));
        publish();
        return { ...state };
    }

    async function runRefresh() {
        try {
            const direct = await directHealth();
            state.running = true;
            state.serverState = 'running';
            state.port = Number(direct.port) || notesPort();
            state.url = notesBase();
            state.message = 'EveOS Notes is ready.';
            publish();
            return { ...state };
        } catch (_error) {}
        try {
            const controller = await controllerBase();
            return applyStatus(await fetchJson(`${controller}${STATUS_PATH}`, undefined, 1400));
        } catch (error) {
            state.running = false;
            state.controllerAvailable = false;
            state.serverState = 'unavailable';
            state.message = error.message || 'EveOS Notes is unavailable.';
            publish();
            return { ...state };
        }
    }

    function refresh() {
        if (refreshPromise) return refreshPromise;
        refreshPromise = runRefresh().finally(() => { refreshPromise = null; });
        return refreshPromise;
    }

    async function setRunning(enabled) {
        if (state.busy) return { ...state };
        state.busy = true;
        state.serverState = enabled ? 'starting' : 'stopping';
        state.message = enabled ? 'Starting EveOS Notes…' : 'Stopping EveOS Notes…';
        publish();
        try {
            const controller = await controllerBase({ userInitiated: true });
            const payload = await fetchJson(`${controller}/api/notes-service/${enabled ? 'start' : 'stop'}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
            }, 6000);
            return applyStatus(payload);
        } catch (error) {
            state.running = false;
            state.serverState = 'error';
            state.message = error.message || 'Notes lifecycle request failed.';
            publish();
            return { ...state };
        } finally {
            state.busy = false;
            publish();
        }
    }

    function stoppedError(message) {
        const error = new Error(message || 'Start Notes to use Notepad files and Spatial Notes.');
        error.code = 'NOTES_SERVICE_STOPPED';
        return error;
    }

    async function requireRunning() {
        try {
            await directHealth();
            if (!state.running) await refresh();
            return notesBase();
        } catch (_error) {
            const snapshot = await refresh();
            const message = snapshot.running
                ? 'EveOS Notes is starting or not responding yet. Try Refresh shortly.'
                : 'Start Notes to use Notepad files and Spatial Notes.';
            throw stoppedError(message);
        }
    }

    async function request(path, body, timeoutMs = 6000) {
        const service = await requireRunning();
        try {
            return await fetchJson(`${service}${path}`, body === undefined ? undefined : {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            }, timeoutMs);
        } catch (error) {
            if (error instanceof TypeError) void refresh();
            throw error;
        }
    }

    ns.notesClient = Object.freeze({
        state, refresh, start: () => setRunning(true), stop: () => setRunning(false),
        workspace: () => request('/api/notes/workspace'),
        track: (path) => request('/api/notes/track', { path }),
        untrack: (rootId) => request('/api/notes/untrack', { rootId }),
        list: (rootId, path, includeMarkdown) => request('/api/notes/list', { rootId, path, includeMarkdown }),
        read: (rootId, path) => request('/api/notes/read', { rootId, path }),
        write: (rootId, path, content, revision) => request('/api/notes/write', { rootId, path, content, revision }),
        create: (rootId, path, name, kind) => request('/api/notes/create', { rootId, path, name, kind }),
        favorite: (rootId, path) => request('/api/notes/favorite', { rootId, path }),
        link: (source, target) => request('/api/notes/link', { source, target }),
        related: (noteRef) => request('/api/notes/related', { noteRef }),
        collection: (kind) => request('/api/notes/collection', { kind }),
        search: (rootId, query) => request('/api/notes/search', { rootId, query, includeContent: true }, 12000),
        rename: (rootId, path, name, revision) => request('/api/notes/rename', { rootId, path, name, revision }),
        move: (rootId, path, destination, revision) => request('/api/notes/move', { rootId, path, destination, revision }),
        delete: (rootId, path, confirmation, revision) => request('/api/notes/delete', { rootId, path, confirmation, revision }),
        exportSpatial: () => request('/api/notes/export', undefined, 12000),
        importSpatial: (encoded) => request('/api/notes/import', { base64: encoded }, 20000),
        resetConnection() { baseUrl = ''; refreshPromise = null; }
    });
})(window.EveWorldBook);
