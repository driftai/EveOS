#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const localControlSource = fs.readFileSync(
    path.join(ROOT, 'js', 'modules', 'core', 'eveos-local-control.js'),
    'utf8'
);
const source = fs.readFileSync(
    path.join(ROOT, 'js', 'modules', 'gemini', 'server_control', 'eveosControlPlane.js'),
    'utf8'
);
const shellSource = fs.readFileSync(
    path.join(ROOT, 'js', 'modules', 'gemini', 'gemini-init.js'),
    'utf8'
);

let webRunning = false;
let directRunning = false;
const events = [];
const seenUrls = [];
const statusNode = { textContent: '' };
const labelNode = { textContent: '' };
const iconNode = { textContent: '' };
const buttonNode = {
    disabled: false,
    dataset: {},
    classList: { toggle() {} },
    addEventListener() {},
    setAttribute() {},
    querySelector(selector) {
        if (selector === '[data-eveos-control-action-label]') return labelNode;
        if (selector === '.material-icons') return iconNode;
        return null;
    }
};
const openNode = { hidden: true, dataset: {}, addEventListener() {} };
const controlNode = {
    dataset: {},
    title: '',
    parentElement: {
        querySelector(selector) {
            return selector === '[data-eveos-control-open]' ? openNode : null;
        }
    },
    querySelector(selector) {
        if (selector === '[data-eveos-control-status]') return statusNode;
        if (selector === '[data-eveos-control-toggle]') return buttonNode;
        return null;
    }
};

async function fetchJson(url, options) {
    seenUrls.push(url);
    if (url.includes('/api/control-plane/health')) {
        return {
            ok: true, service: 'eveos-control-plane', controllerAvailable: true,
            running: true, state: 'running', port: 9082
        };
    }
    if (url.includes('/api/control-plane/status')) {
        const targetPort = url.includes('port=3000') ? 3000 : 8765;
        return {
            ok: true,
            service: 'eveos-control-plane',
            controllerAvailable: true,
            web: {
                ok: true,
                running: webRunning,
                desiredRunning: webRunning,
                state: webRunning ? 'running' : 'stopped',
                port: targetPort,
                url: `http://127.0.0.1:${targetPort}/EveOS.html`,
                message: webRunning ? 'EveOS localhost is online.' : 'EveOS localhost is stopped.'
            }
        };
    }
    if (/^http:\/\/(?:localhost|127\.0\.0\.1|192\.168\.1\.209|127-0-0-1\.sslip\.io):3000\/api\/status$/.test(url)) {
        if (!directRunning) throw new Error(`${url} offline`);
        return {
            ok: true,
            service: 'eveos-local-server',
            port: 3000,
            url: 'http://127.0.0.1:3000/EveOS.html'
        };
    }
    if (url === 'http://127.0.0.1:8765/api/status') {
        throw new Error('canonical localhost offline');
    }
    if (url.includes('/api/eveos-server/start') && options?.method === 'POST') {
        if (!url.includes('port=3000')) throw new Error(`start lost active port: ${url}`);
        webRunning = true;
        return {
            ok: true, running: true, desiredRunning: true, state: 'running', port: 3000,
            url: 'http://127.0.0.1:3000/EveOS.html', message: 'EveOS localhost started.'
        };
    }
    if (url.includes('/api/eveos-server/stop') && options?.method === 'POST') {
        if (!url.includes('port=3000')) throw new Error(`stop lost active port: ${url}`);
        webRunning = false;
        return {
            ok: true, running: false, desiredRunning: false, state: 'stopped', port: 3000,
            url: 'http://127.0.0.1:3000/EveOS.html', message: 'EveOS localhost stopped.'
        };
    }
    throw new Error(`Unexpected URL: ${url}`);
}

class CustomEventMock {
    constructor(type, options) {
        this.type = type;
        this.detail = options?.detail;
    }
}

const documentMock = {
    readyState: 'complete',
    visibilityState: 'visible',
    documentElement: {},
    body: { appendChild() {} },
    querySelectorAll(selector) {
        if (selector === '[data-eveos-control-plane]') return [controlNode];
        if (selector === '[data-eveos-control-toggle]') return [buttonNode];
        if (selector === '[data-eveos-control-open]') return [openNode];
        return [];
    },
    getElementById(id) { return id === 'gemini-ui-root' ? {} : null; },
    createElement() { return { setAttribute() {}, click() {}, remove() {} }; },
    addEventListener() {}
};

const windowMock = {
    location: {
        protocol: 'file:', hostname: '', port: '', origin: 'null'
    },
    config: { bridges: { localControlPort: 9082, geminiControlPort: 9082 } },
    GeminiServerNetwork: { fetchJson },
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    clearInterval() {},
    dispatchEvent(event) { events.push(event); },
    open() {}
};

const context = {
    window: windowMock,
    document: documentMock,
    MutationObserver: class { observe() {} },
    CustomEvent: CustomEventMock,
    AbortController,
    URL,
    fetch,
    console
};

function setPageOrigin(origin) {
    const parsed = new URL(origin);
    windowMock.location.protocol = parsed.protocol;
    windowMock.location.hostname = parsed.hostname;
    windowMock.location.port = parsed.port;
    windowMock.location.origin = parsed.origin;
}

function setFileMode() {
    windowMock.location.protocol = 'file:';
    windowMock.location.hostname = '';
    windowMock.location.port = '';
    windowMock.location.origin = 'null';
}

vm.runInNewContext(localControlSource, context, { filename: 'eveos-local-control.js' });
vm.runInNewContext(source, context, { filename: 'eveosControlPlane.js' });

(async () => {
    await windowMock.EveOSControlPlane.refreshStatus();
    if (statusNode.textContent !== 'Localhost Off' || labelNode.textContent !== 'Start') {
        throw new Error(`file-mode stopped UI mismatch: ${statusNode.textContent}/${labelNode.textContent}`);
    }

    directRunning = true;
    await windowMock.EveOSControlPlane.refreshStatus();
    let fileState = windowMock.EveOSControlPlane.getState();
    if (statusNode.textContent !== 'Online' || labelNode.textContent !== 'Stop') {
        throw new Error(`file:// did not discover localhost:3000: ${statusNode.textContent}/${labelNode.textContent}`);
    }
    if (fileState.currentPagePort !== 0 || fileState.currentWebPort !== 3000) {
        throw new Error(`file:// port memory mismatch: page=${fileState.currentPagePort} web=${fileState.currentWebPort}`);
    }

    directRunning = false;
    await windowMock.EveOSControlPlane.stop();
    if (statusNode.textContent !== 'Localhost Off' || labelNode.textContent !== 'Start') {
        throw new Error(`file-mode stop mismatch: ${statusNode.textContent}/${labelNode.textContent}`);
    }
    await windowMock.EveOSControlPlane.start();
    if (statusNode.textContent !== 'Online' || labelNode.textContent !== 'Stop') {
        throw new Error(`file-mode restart mismatch: ${statusNode.textContent}/${labelNode.textContent}`);
    }

    setPageOrigin('http://localhost:3000');
    await windowMock.EveOSControlPlane.refreshStatus();
    if (statusNode.textContent !== 'Online' || windowMock.EveOSControlPlane.getState().currentWebPort !== 3000) {
        throw new Error('localhost EveOS page did not preserve its active web port');
    }

    setPageOrigin('http://192.168.1.209:3000');
    await windowMock.EveOSControlPlane.refreshStatus();
    if (statusNode.textContent !== 'Online' || windowMock.EveOSControlPlane.getState().currentWebPort !== 3000) {
        throw new Error('LAN EveOS page did not preserve its active web port');
    }

    setPageOrigin('http://127-0-0-1.sslip.io:3000');
    await windowMock.EveOSControlPlane.refreshStatus();
    if (statusNode.textContent !== 'Online' || windowMock.EveOSControlPlane.getState().currentWebPort !== 3000) {
        throw new Error('sslip EveOS page did not preserve its active web port');
    }

    setPageOrigin('http://localhost:3000');
    await windowMock.EveOSControlPlane.stop();
    if (statusNode.textContent !== 'Localhost Off' || labelNode.textContent !== 'Start') {
        throw new Error(`stopped-after-stop UI mismatch: ${statusNode.textContent}/${labelNode.textContent}`);
    }

    setFileMode();
    if (windowMock.EveOSControlPlane.getState().currentPagePort !== 0) {
        throw new Error('file:// unexpectedly reported an HTTP page port');
    }

    for (const fragment of [
        '/api/control-plane/status?port=3000',
        '/api/eveos-server/start?port=3000',
        '/api/eveos-server/stop?port=3000',
        'http://127.0.0.1:3000/api/status',
        'http://localhost:3000/api/status',
        'http://192.168.1.209:3000/api/status',
        'http://127-0-0-1.sslip.io:3000/api/status'
    ]) {
        if (!seenUrls.some((url) => url.includes(fragment))) {
            throw new Error(`missing active-port request: ${fragment}`);
        }
    }

    if (!events.some((event) => event.type === 'eve:eveos-control-plane-status')) {
        throw new Error('control-plane status event was not published');
    }
    if (!shellSource.includes('data-eveos-control-plane')) {
        throw new Error('Search Monitor shell is not wired to EveOS local control');
    }
    const shellControl = shellSource.match(/<div class="gemini-server-control"[^>]*>/)?.[0] || '';
    if (shellControl.includes('data-gemini-server-control')) {
        throw new Error('Search Monitor top control is still coupled to Gemini lifecycle');
    }
    if (!source.includes('record.addedNodes')) {
        throw new Error('control binding observer is not scoped to newly added lifecycle controls');
    }
    if (!source.includes('EveOSLocalControl.ensure')) {
        throw new Error('Search Monitor does not use the shared local-control cold start');
    }
    if (!source.includes('MAIN_WEB_BASE')) {
        throw new Error('file:// direct fallback does not know the main launcher port');
    }
    if (!source.includes('currentPagePort')) {
        throw new Error('control-plane state does not distinguish file:// from the active web port');
    }
    if (/new MutationObserver\(function \(\) \{\s*bind\(document\)/.test(source)) {
        throw new Error('control binding observer can recursively republish its own DOM mutations');
    }

    console.log('EVEOS_CONTROL_PLANE_UI_SMOKE_OK');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
