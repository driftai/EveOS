'use strict';
// Isolated observer qualification. Fake durable packets are not live Spotify/queue endurance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { launch } = require('./helpers/audioflix_native_cdp_fixture');

const ROOT = path.resolve(__dirname, '../..');
const MODULE = 'js/modules/features/audioflix/audioflix.spotify.status-watch.js';
const baseline = process.argv.includes('--baseline');
const forceBundledWs = process.argv.includes('--force-bundled-ws');
const BASELINE_SHA = '3c871b034c1c614998e2491be5901714d0a323a3';
const source = baseline ? execFileSync('git', ['show', `${BASELINE_SHA}:${MODULE}`], { cwd: ROOT, encoding: 'utf8' })
    : fs.readFileSync(path.join(ROOT, MODULE), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => JSON.parse(JSON.stringify(value));
const evidence = { mode: baseline ? 'baseline' : forceBundledWs ? 'candidate-bundled-ws' : 'candidate',
    baselineSha: BASELINE_SHA, scenarios: [], failures: [] };
const output = path.join(ROOT, 'data/runtime/smoke-results/audioflix-watch-lifecycle');

async function until(predicate, message, timeout = 4000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, message);
        await sleep(20);
    }
}

function backend() {
    let cursor = 1, generation = 1;
    let state;
    const pending = new Set();
    const data = { events: [], applies: [], pulses: 0, calls: [], peaks: { watch: 0, status: 0 } };
    const flights = { watch: 0, status: 0 };
    function packet(status) {
        return { ok: true, watchSupported: true, isOwner: true, ownerEpoch: 1, engineEpoch: 1,
            trackGeneration: generation, engine: { generation, eventCursor: cursor, status,
                ended: status === 'ended', completionId: status === 'ended' ? `done-${generation}-${cursor}` : '' } };
    }
    state = packet('playing');
    function update(status, newTrack = false) {
        cursor++; if (newTrack) generation++;
        state = packet(status);
        for (const job of [...pending]) job.finish(state);
        return clone(state);
    }
    async function read(action, payload = {}) {
        data.calls.push(action);
        if (action === 'seed') return clone(state);
        const kind = action === 'status-watch' ? 'watch' : 'status';
        flights[kind]++; data.peaks[kind] = Math.max(data.peaks[kind], flights[kind]);
        try {
            if (kind === 'status' || Number(payload.afterCursor || 0) < cursor) return clone(state);
            return await new Promise(resolve => {
                const job = { timer: null, finish(value) {
                    clearTimeout(job.timer); pending.delete(job); resolve(clone(value));
                } };
                pending.add(job);
                job.timer = setTimeout(() => job.finish({ ...state, watchTimedOut: true }), 5000);
            });
        } finally { flights[kind]--; }
    }
    return { data, read, update, current: () => clone(state), release: () => {
        for (const job of [...pending]) job.finish(state);
    } };
}

function instrumentation() {
    const intervals = new Set(), timers = new Set();
    const listeners = { freeze: new Set(), resume: new Set() };
    const setI = window.setInterval, clearI = window.clearInterval;
    const setT = window.setTimeout, clearT = window.clearTimeout;
    window.setInterval = (fn, ms, ...args) => {
        const id = setI(fn, ms, ...args); intervals.add(id); return id;
    };
    window.clearInterval = id => { intervals.delete(id); return clearI(id); };
    window.setTimeout = (fn, ms, ...args) => {
        const id = setT(() => { timers.delete(id); fn(...args); }, ms); timers.add(id); return id;
    };
    window.clearTimeout = id => { timers.delete(id); return clearT(id); };
    const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
    document.addEventListener = (name, fn, opts) => {
        listeners[name]?.add(fn); return add(name, fn, opts);
    };
    document.removeEventListener = (name, fn, opts) => {
        listeners[name]?.delete(fn); return remove(name, fn, opts);
    };
    window.__resources = () => ({ intervals: intervals.size, timers: timers.size,
        freezeListeners: listeners.freeze.size, resumeListeners: listeners.resume.size });
}

function initialize(readUrl) {
    const model = { active: false, run: 0, mode: 'stopped', ended: false, advances: 0, applies: 0 };
    const consumed = new Set();
    const read = (action, payload = {}) => fetch(readUrl + '?entry=' + (location.protocol === 'file:' ? 'file' : 'http'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, payload })
    }).then(response => response.json());
    const frontend = event => console.log('WATCH_LIFECYCLE_FRONTEND:' + JSON.stringify(event));
    const remote = { snapshot: () => ({ connected: true }),
        status: () => read('status'), send: (action, payload) => read(action, payload) };
    const observer = window.EveAudioflixSpotifyStatusWatch.create({ remote: () => remote,
        currentRun: () => model.run, isActive: () => model.active, isEnded: () => model.ended,
        applyState(packet) {
            model.applies++;
            const engine = packet.engine;
            if (model.mode === 'playing' && engine.ended && !consumed.has(engine.completionId)) {
                consumed.add(engine.completionId); model.advances++; model.ended = true;
            }
            if (!engine.ended) model.mode = engine.status;
            frontend({ kind: 'apply', cursor: engine.eventCursor, ...model });
        } });
    const snapshot = () => ({ ...model, observer: observer.diagnostics(), resources: window.__resources() });
    for (const name of ['freeze', 'resume']) document.addEventListener(name, event => {
        console.log('WATCH_LIFECYCLE_NATIVE:' + JSON.stringify({ kind: name, trusted: event.isTrusted, ...snapshot() }));
    });
    document.querySelector('#start').onclick = async () => {
        const seed = await read('seed');
        model.active = true; model.run++; model.ended = false; model.mode = seed.engine.status;
        observer.start(seed);
    };
    document.querySelector('#pause').onclick = () => { model.mode = 'paused'; };
    document.querySelector('#stop').onclick = () => {
        model.active = false; model.mode = 'stopped'; model.run++; observer.stop();
    };
    window.__fixture = { snapshot, observer };
    window.__heartbeat = setInterval(() => frontend({ kind: 'pulse' }), 25);
}

const html = readUrl => '<!doctype html><meta charset="utf-8"><title>isolated watch lifecycle</title>'
    + '<button id="start">Observe</button><button id="pause">Pause accepted</button><button id="stop">Stop</button>'
    + `<script>(${instrumentation})();</script><script>${source.replace(/<\/script/gi, '<\\/script')}</script>`
    + `<script>(${initialize})(${JSON.stringify(readUrl)});</script>`;

async function qualify(browser, url, entry, observed) {
    const errors = [], requests = [];
    const page = await browser.page(url, message => {
        if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
        if (message.method === 'Network.requestWillBeSent') {
            const requestUrl = message.params.request.url;
            if (requests.length < 200) requests.push(requestUrl);
            if (!requestUrl.startsWith('file:') && !/^http:\/\/127\.0\.0\.1:\d+\//.test(requestUrl)) {
                errors.push('unexpected non-fixture request: ' + requestUrl);
            }
        }
        if (message.method === 'Runtime.consoleAPICalled') {
            const text = message.params.args[0]?.value;
            if (typeof text !== 'string') return;
            if (text.startsWith('WATCH_LIFECYCLE_NATIVE:')) {
                observed.data.events.push(JSON.parse(text.slice('WATCH_LIFECYCLE_NATIVE:'.length)));
            } else if (text.startsWith('WATCH_LIFECYCLE_FRONTEND:')) {
                const event = JSON.parse(text.slice('WATCH_LIFECYCLE_FRONTEND:'.length));
                if (event.kind === 'pulse') observed.data.pulses++;
                else if (event.kind === 'apply') observed.data.applies.push(event);
            }
        }
    });
    const session = page;
    const snapshot = () => page.evaluate(() => window.__fixture.snapshot());
    async function freeze(label) {
        const index = observed.data.events.filter(event => event.kind === 'freeze').length;
        // Playwright normally forces focused/visible pages; native freezing requires hidden state.
        await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
        await session.send('Page.setWebLifecycleState', { state: 'frozen' });
        await until(() => observed.data.events.filter(event => event.kind === 'freeze').length > index,
            `${entry}: native freeze event missing`);
        await sleep(80); // settle binding notifications already sent before suspension
        const frozen = observed.data.events.filter(event => event.kind === 'freeze').at(-1);
        assert.equal(frozen.trusted, true, 'freeze must be native, not a synthetic event');
        const boundary = { pulses: observed.data.pulses, applies: observed.data.applies.length,
            advances: frozen.advances, frozen };
        evidence.scenarios.push({ entry, label, phase: 'frozen', boundary });
        return boundary;
    }
    async function assertFrozen(boundary) {
        await sleep(150);
        assert.equal(observed.data.pulses, boundary.pulses, `${entry}: frozen JS timer ran`);
        assert.equal(observed.data.applies.length, boundary.applies, `${entry}: frozen observer callback ran`);
        assert.equal(boundary.frozen.observer.state, 'suspended', `${entry}: observer must suspend on native freeze`);
        assert.equal(boundary.frozen.observer.progressTimers, 0, `${entry}: presentation timer must be removed`);
    }
    async function resume() {
        const index = observed.data.events.filter(event => event.kind === 'resume').length;
        await session.send('Page.setWebLifecycleState', { state: 'active' });
        await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await until(() => observed.data.events.filter(event => event.kind === 'resume').length > index,
            `${entry}: native resume event missing`);
        assert.equal(observed.data.events.filter(event => event.kind === 'resume').at(-1).trusted, true);
    }
    async function start() {
        await page.click('#start');
        await page.wait(() => window.__fixture.snapshot().observer.state === 'watching');
        await until(() => observed.data.calls.includes('status-watch'), `${entry}: watch did not start`);
    }
    try {
        await start();
        await until(() => observed.data.pulses >= 3, `${entry}: fixture did not run before freeze`);
        const held = await freeze('durable completion');
        observed.update('ended');
        await assertFrozen(held);
        assert.equal(held.advances, 0, 'no completion owner advance before thaw');
        await resume();
        await page.wait(() => window.__fixture.snapshot().advances === 1);
        await sleep(80);
        const completed = await snapshot();
        assert.equal(completed.advances, 1, 'durable completion consumed exactly once after thaw');
        evidence.scenarios.push({ entry, label: 'durable completion', phase: 'resumed', snapshot: completed });

        observed.update('paused', true);
        await page.click('#pause');
        await start();
        const paused = await freeze('explicit pause');
        observed.update('paused'); await assertFrozen(paused); await resume();
        await page.wait(() => window.__fixture.snapshot().observer.state === 'watching');
        const afterPause = await snapshot();
        assert.equal(afterPause.mode, 'paused', 'resume observation must not resume user-paused playback');
        assert.equal(afterPause.advances, 1);

        observed.update('playing', true); await start();
        for (let cycle = 0; cycle < 8; cycle++) {
            const heldCycle = await freeze(`repeat ${cycle + 1}`);
            observed.update('playing'); await assertFrozen(heldCycle); await resume();
            await page.wait(() => window.__fixture.snapshot().observer.state === 'watching');
            const current = await snapshot();
            assert.ok(current.observer.watchJobs <= 1 && current.observer.watchRequests <= 1);
            assert.ok(current.observer.progressRequests <= 1);
            assert.equal(current.observer.progressTimers, 1);
            assert.equal(current.resources.freezeListeners, 2, 'one observer listener plus fixture listener');
            assert.equal(current.resources.resumeListeners, 2);
            assert.equal(current.advances, 1, 'playing snapshots cannot replay consumed completion');
        }

        await page.click('#stop'); observed.update('stopped');
        await page.wait(() => window.__fixture.snapshot().observer.watchJobs === 0);
        const stoppedCalls = observed.data.calls.length;
        const stopped = await freeze('stop');
        await sleep(150);
        assert.equal(observed.data.pulses, stopped.pulses);
        assert.equal(observed.data.applies.length, stopped.applies);
        await resume(); await sleep(100);
        const afterStop = await snapshot();
        assert.equal(afterStop.active, false); assert.equal(afterStop.mode, 'stopped');
        assert.equal(observed.data.calls.length, stoppedCalls, 'Stop disables resume/reconnect eligibility');
        assert.equal(afterStop.observer.watchJobs, 0); assert.equal(afterStop.observer.progressTimers, 0);
        await page.evaluate(() => window.__fixture.observer.dispose());
        const disposed = await snapshot();
        assert.equal(disposed.resources.freezeListeners, 1, 'dispose removes observer freeze listener');
        assert.equal(disposed.resources.resumeListeners, 1, 'dispose removes observer resume listener');
        assert.ok(observed.data.peaks.watch <= 1 && observed.data.peaks.status <= 1);
        assert.ok(observed.data.calls.every(action => ['seed', 'status', 'status-watch'].includes(action)),
            'observation must never request Play/Resume/helper startup');
        assert.deepEqual(errors, []);
        evidence.scenarios.push({ entry, label: 'settled', snapshot: disposed, calls: observed.data.calls.length,
            peaks: observed.data.peaks, events: observed.data.events.map(event => event.kind) });
    } catch (error) {
        evidence.failures.push({ entry, message: error.message, events: observed.data.events,
            applies: observed.data.applies, calls: observed.data.calls, pulses: observed.data.pulses, requests, errors });
        if (session) await session.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
        await page.screenshot(path.join(output, `${entry}-${evidence.mode}-failure.png`)).catch(() => {});
        throw error;
    } finally {
        observed.release();
        await page.close();
    }
}

(async () => {
    fs.mkdirSync(output, { recursive: true });
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-watch-lifecycle-'));
    const fixture = path.join(temp, 'fixture.html');
    const observed = { http: backend(), file: backend() };
    let document = '';
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'content-type' };
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
        if (url.pathname === '/read') {
            let body = '';
            req.on('data', chunk => { body += chunk; assert.ok(body.length < 16384); });
            req.on('end', async () => {
                const request = JSON.parse(body);
                const packet = await observed[url.searchParams.get('entry')].read(request.action, request.payload);
                res.writeHead(200, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(packet));
            });
        } else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(document); }
    });
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        document = html(origin + '/read'); fs.writeFileSync(fixture, document);
        browser = await launch(temp, { forceBundledWs });
        evidence.browser = browser.version;
        evidence.webSocketTransport = browser.webSocketTransport;
        await qualify(browser, origin + '/fixture.html', 'http', observed.http);
        await qualify(browser, pathToFileURL(fixture).href, 'file', observed.file);
        evidence.ok = true;
        console.log('AUDIOFLIX_SPOTIFY_WATCH_LIFECYCLE_OK (http/file, native freeze/thaw, completion, Pause, Stop, 8 cycles, dispose)');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
        const target = path.resolve(temp);
        assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
        assert.ok(path.basename(target).startsWith('eve-watch-lifecycle-'));
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        fs.writeFileSync(path.join(output, `${evidence.mode}.json`), JSON.stringify(evidence, null, 2));
    }
})().catch(error => { console.error(`AUDIOFLIX_SPOTIFY_WATCH_LIFECYCLE_FAIL: ${error.message}`); process.exitCode = 1; });
