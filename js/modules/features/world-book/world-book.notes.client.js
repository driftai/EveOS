window.EveWorldBook = window.EveWorldBook || {};

(function (ns) {
    'use strict';

    let baseUrl = '';

    async function controllerBase() {
        if (baseUrl) return baseUrl;
        const found = await ns.client.ensureController();
        baseUrl = String(found?.baseUrl || ns.client.state.baseUrl || '').replace(/\/$/, '');
        if (!baseUrl) throw new Error('EveOS local control is unavailable.');
        return baseUrl;
    }

    async function request(path, body, timeoutMs = 6000) {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), timeoutMs);
        try {
            const base = await controllerBase();
            const response = await fetch(`${base}${path}`, {
                method: body === undefined ? 'GET' : 'POST',
                cache: 'no-store',
                headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.ok === false) {
                const error = new Error(payload.message || `Notes request failed (${response.status}).`);
                error.payload = payload;
                throw error;
            }
            return payload;
        } catch (error) {
            if (error?.name === 'AbortError') throw new Error('Notes local service did not respond in time.');
            if (error instanceof TypeError && baseUrl) {
                baseUrl = '';
            }
            throw error;
        } finally {
            window.clearTimeout(timer);
        }
    }

    ns.notesClient = Object.freeze({
        workspace: () => request('/api/notes/workspace'),
        track: (path) => request('/api/notes/track', { path }),
        untrack: (rootId) => request('/api/notes/untrack', { rootId }),
        list: (rootId, path, includeMarkdown) => request('/api/notes/list', { rootId, path, includeMarkdown }),
        read: (rootId, path) => request('/api/notes/read', { rootId, path }),
        write: (rootId, path, content, revision) => request('/api/notes/write', { rootId, path, content, revision }),
        create: (rootId, path, name, kind) => request('/api/notes/create', { rootId, path, name, kind }),
        favorite: (rootId, path) => request('/api/notes/favorite', { rootId, path }),
        link: (source, target) => request('/api/notes/link', { source, target }),
        exportSpatial: () => request('/api/notes/export', undefined, 12000),
        importSpatial: (encoded) => request('/api/notes/import', { base64: encoded }, 20000),
        resetConnection: () => { baseUrl = ''; }
    });
})(window.EveWorldBook);
