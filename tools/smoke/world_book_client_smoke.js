const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const localControlSource = fs.readFileSync(
    path.join(ROOT, 'js', 'modules', 'core', 'eveos-local-control.js'),
    'utf8'
);
const source = fs.readFileSync(
    path.join(ROOT, 'js', 'modules', 'features', 'world-book', 'world-book.client.js'),
    'utf8'
);

let controllerOnline = false;
let worldRunning = true;
let protocolLaunches = 0;
const events = [];

function response(payload, ok = true, status = 200) {
    return {
        ok,
        status,
        async json() {
            return payload;
        }
    };
}

function worldStatus() {
    return {
        ok: true,
        controllerAvailable: true,
        installed: true,
        running: worldRunning,
        desiredRunning: worldRunning,
        state: worldRunning ? 'running' : 'stopped',
        url: 'http://127.0.0.1:8766/',
        instanceId: worldRunning ? 'managed-instance' : '',
        message: worldRunning ? 'World Book is online.' : 'World Book is stopped.'
    };
}

async function fetchMock(url, options) {
    if (url.endsWith('/api/control-plane/health')) {
        if (!controllerOnline) throw new Error('controller offline');
        return response({
            ok: true,
            service: 'eveos-control-plane',
            controllerAvailable: true,
            running: true,
            state: 'running',
            port: 9082
        });
    }
    if (url.endsWith('/api/control-plane/status')) {
        if (!controllerOnline) throw new Error('controller offline');
        return response({
            ok: true,
            service: 'eveos-control-plane',
            controllerAvailable: true,
            web: { running: false, state: 'stopped' }
        });
    }
    if (url.endsWith('/api/world-book/status')) {
        if (!controllerOnline) throw new Error('controller offline');
        return response(worldStatus());
    }
    if (url.endsWith('/api/world-book/start') && options?.method === 'POST') {
        if (!controllerOnline) throw new Error('controller offline');
        worldRunning = true;
        return response(worldStatus());
    }
    if (url.endsWith('/api/world-book/stop') && options?.method === 'POST') {
        if (!controllerOnline) throw new Error('controller offline');
        worldRunning = false;
        return response(worldStatus());
    }
    if (url.endsWith('/api/health')) {
        if (!worldRunning) throw new Error('World Book offline');
        return response({ ok: true, service: 'world-book', appVersion: 'smoke', instanceId: 'direct-instance' });
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
    body: {
        appendChild() {}
    },
    // The launch goes through a hidden iframe, not an anchor click: a declined custom scheme is a
    // failed navigation, and from an anchor that lands on the top-level page and can reload the app
    // out from under the user. Counting the iframe's location assignment keeps this test measuring
    // "the launch was requested", which is the behaviour that matters, not how it is dispatched.
    createElement(tagName) {
        if (tagName !== 'iframe') throw new Error(`Unexpected element: ${tagName}`);
        return {
            hidden: false,
            style: {},
            setAttribute() {},
            contentWindow: {
                location: {
                    set href(value) {
                        if (!String(value || '').startsWith('eveos-control:')) return;
                        protocolLaunches += 1;
                        controllerOnline = true;
                    }
                }
            },
            remove() {}
        };
    }
};

const windowMock = {
    EveWorldBook: {},
    config: { bridges: { localControlPort: 9082 } },
    location: {
        protocol: 'file:',
        hostname: '',
        origin: 'null'
    },
    setTimeout,
    clearTimeout,
    dispatchEvent(event) {
        events.push(event);
    }
};

const context = {
    window: windowMock,
    document: documentMock,
    fetch: fetchMock,
    AbortController,
    CustomEvent: CustomEventMock
};

vm.runInNewContext(localControlSource, context, { filename: 'eveos-local-control.js' });
vm.runInNewContext(source, context, { filename: 'world-book.client.js' });

(async () => {
    const client = windowMock.EveWorldBook.client;

    const standalone = await client.refresh();
    if (!standalone.running || standalone.controllerAvailable || !standalone.directAvailable) {
        throw new Error(`standalone discovery failed: ${JSON.stringify(standalone)}`);
    }
    if (standalone.source !== 'standalone' || !standalone.message.includes('standalone launcher')) {
        throw new Error(`standalone source was not surfaced: ${JSON.stringify(standalone)}`);
    }
    if (standalone.instanceId !== 'direct-instance') {
        throw new Error(`standalone instance identity missing: ${JSON.stringify(standalone)}`);
    }

    controllerOnline = true;
    const managed = await client.refresh();
    if (!managed.running || !managed.controllerAvailable || managed.source !== 'managed') {
        throw new Error(`managed discovery failed: ${JSON.stringify(managed)}`);
    }

    controllerOnline = false;
    worldRunning = false;
    const offline = await client.refresh();
    if (offline.running || offline.controllerAvailable || offline.directAvailable) {
        throw new Error(`offline state was stale: ${JSON.stringify(offline)}`);
    }
    if (!offline.message.includes('Start it here')) {
        throw new Error(`in-site start guidance missing: ${JSON.stringify(offline)}`);
    }

    const coldStarted = await client.start();
    if (!coldStarted.running || !coldStarted.controllerAvailable || protocolLaunches !== 1) {
        throw new Error(`file-mode cold start failed: ${JSON.stringify(coldStarted)}`);
    }

    controllerOnline = false;
    const adoptedStandalone = await client.refresh();
    if (adoptedStandalone.source !== 'standalone') {
        throw new Error(`standalone reset failed: ${JSON.stringify(adoptedStandalone)}`);
    }
    const stopped = await client.stop();
    if (stopped.running || !stopped.controllerAvailable || protocolLaunches !== 2) {
        throw new Error(`standalone adoption/stop failed: ${JSON.stringify(stopped)}`);
    }

    if (!events.some((event) => event.type === 'eve:world-book-status')) {
        throw new Error('status events were not published');
    }

    console.log('WORLD_BOOK_CLIENT_SMOKE_OK');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
