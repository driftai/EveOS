'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(
    path.join(ROOT, 'tools', 'World-Book', 'app', 'assets', 'js', 'world-portal-view.js'),
    'utf8'
);

let portalRouteReady = false;
let worldBookRunning = true;
let stopCalls = 0;
let startCalls = 0;
const listeners = new Map();

function response(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() { return payload; }
    };
}

function element(id) {
    return {
        id,
        hidden: true,
        disabled: false,
        textContent: '',
        value: '',
        attrs: { src: 'about:blank' },
        classList: { add() {}, remove() {}, toggle() {} },
        contentWindow: { postMessage() {} },
        getAttribute(name) { return this.attrs[name] || null; },
        setAttribute(name, value) { this.attrs[name] = value; },
        addEventListener(type, handler) { listeners.set(`${id}:${type}`, handler); }
    };
}

const ids = [
    'world-portal-view', 'world-portal-frame', 'world-portal-status',
    'world-portal-server-btn', 'world-portal-btn', 'world-portal-back-btn',
    'world-portal-refresh-btn', 'world-portal-context-btn',
    'world-portal-detach-btn', 'world-portal-offline-start-btn'
];
const elements = Object.fromEntries(ids.map(id => [id, element(id)]));

const documentMock = {
    body: { classList: { add() {}, remove() {} } },
    getElementById(id) { return elements[id] || null; },
    createElement() { return { textContent: '' }; }
};

async function fetchMock(url, options = {}) {
    const target = String(url);
    const method = options.method || 'GET';

    if (target === '/api/world-portal/status') {
        return portalRouteReady
            ? response(200, {
                ok: true,
                service: 'world-portal-controller',
                running: false,
                message: 'World Portal is resting.'
            })
            : response(404, { ok: false, error: 'Unknown API endpoint.' });
    }

    if (target === 'http://127.0.0.1:9082/api/world-book/status') {
        return response(200, {
            ok: true,
            controllerAvailable: true,
            running: worldBookRunning
        });
    }

    if (target === 'http://127.0.0.1:9082/api/world-book/stop' && method === 'POST') {
        stopCalls += 1;
        worldBookRunning = false;
        return response(200, { ok: true, running: false });
    }

    if (target === 'http://127.0.0.1:9082/api/world-book/start' && method === 'POST') {
        startCalls += 1;
        worldBookRunning = true;
        portalRouteReady = true;
        return response(200, { ok: true, running: true });
    }

    throw new Error(`Unexpected request: ${method} ${target}`);
}

const windowMock = {
    addEventListener() {},
    clearInterval() {},
    setInterval() { return 1; },
    open() { return null; }
};

const context = {
    window: windowMock,
    document: documentMock,
    fetch: fetchMock,
    AbortController,
    URLSearchParams,
    location: { search: '?view=world-portal' },
    setTimeout,
    clearTimeout,
    Date
};

function waitFor(predicate, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const check = () => {
            if (predicate()) return resolve();
            if (Date.now() >= deadline) {
                return reject(new Error('Timed out waiting for stale World Book recovery.'));
            }
            setTimeout(check, 20);
        };
        check();
    });
}

(async () => {
    vm.runInNewContext(source, context, { filename: 'world-portal-view.js' });
    await waitFor(() => portalRouteReady && startCalls === 1);
    await new Promise(resolve => setTimeout(resolve, 40));

    if (stopCalls !== 1 || startCalls !== 1 || !worldBookRunning) {
        throw new Error(`stale server was not restarted exactly once: ${JSON.stringify({ stopCalls, startCalls, worldBookRunning })}`);
    }
    if (elements['world-portal-status'].textContent !== 'World Portal is resting.') {
        throw new Error(`portal status did not recover: ${elements['world-portal-status'].textContent}`);
    }

    const refresh = listeners.get('world-portal-refresh-btn:click');
    if (!refresh) throw new Error('World Portal refresh handler was not registered.');
    await refresh();
    if (stopCalls !== 1 || startCalls !== 1) {
        throw new Error('healthy Portal status triggered an unnecessary second World Book restart.');
    }

    console.log('WORLD_PORTAL_STALE_RUNTIME_SMOKE_OK');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
