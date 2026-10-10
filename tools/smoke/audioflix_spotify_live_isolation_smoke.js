'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { installBackendWriteBarrier, readBackendAudioflixSnapshot, assertBackendAudioflixUnchanged } =
    require('./audioflix_spotify_live_isolation.shared.js');
const ROOT = path.resolve(__dirname, '../..');
const BASE = 'http://127.0.0.1:49137';
const ARTIFACT = path.join(ROOT, 'data/runtime/smoke-results/audioflix-spotify-live-isolation.json');
const modules = [
    'features/audioflix/audioflix.groups.tree.js', 'features/audioflix/audioflix.state.schema.js',
    'features/audioflix/audioflix.state.recovery.js', 'features/audioflix/audioflix.state.groups.js',
    'features/audioflix/audioflix.state.js', 'features/data-state/data-state.capture.clone.js',
    'features/modular-state-sync/modular-state-sync.shared.js',
    'features/modular-state-sync/modular-state-sync.engine.sync.js',
    'features/modular-state-sync/modular-state-sync.engine.runtime.js'
];
const original = { music: [{ id: 'real-track', title: 'Real track', url: 'https://example.test/real.mp3' }],
    musicGroups: ['Real group'], musicGroupMap: { 'real-track': ['Real group'] }, durabilityRevision: 4 };
const evidence = { ok: false, backendWrites: 0, reads: 0, allowedPlayback: 0 };
let browser;
let fileFixtureDir;

async function main() {
    const liveSource = fs.readFileSync(path.join(__dirname, 'audioflix_spotify_long_queue_live_smoke.mjs'), 'utf8');
    assert(liveSource.indexOf('await installBackendWriteBarrier(') < liveSource.indexOf('await page.goto('), 'live barrier is installed before controller navigation');
    assert(liveSource.includes("serviceWorkers: 'block'"), 'fresh live context blocks service-worker bypass');
    assert(!liveSource.includes('window.saveConfig =') && !liveSource.includes('replaceState'), 'disposal never silently restores user state or masks saveConfig');
    assert(liveSource.indexOf('assertBackendAudioflixUnchanged(') < liveSource.indexOf('AUDIOFLIX_SPOTIFY_LONG_QUEUE_LIVE_OK'), 'live success follows the canonical state safety gate');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let backend = structuredClone(original);
    const document = `<!doctype html><title>Real Audioflix persistence chain</title><script>
        window.eveState = { config: { audioflix: ${JSON.stringify(original)}, modularStateSyncEnabled: true } };
        window.saveConfig = async () => true;
        window.startupWrite = fetch('${BASE}/api/eve-state/modular/save', { method: 'POST', body: '{}' }).then(response => response.status);
        </script>${modules.map((name) => `<script src="${BASE}/modules/${name}"></script>`).join('')}`;
    // Mock only the HTTP boundary. Production state, mirror/journal, capture and sync execute in Chromium.
    await context.route('**/*', async (route) => {
        const request = route.request(), url = new URL(request.url()), method = request.method();
        if (url.protocol === 'file:') return route.fallback();
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*' };
        if (url.pathname === '/EveOS.html') return route.fulfill({ contentType: 'text/html', body: document });
        const module = modules.find((name) => url.pathname === `/modules/${name}`);
        if (module) return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'js/modules', module), 'utf8') });
        if (url.pathname === '/probe-frame') return route.fulfill({ contentType: 'text/html', body: '<title>Frame</title>' });
        if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
            evidence.reads += 1;
            const payload = url.pathname === '/api/eve-state/modular/load'
                ? { ok: true, state: { bookmarks: { links: [], config: {} }, audioflix: backend } }
                : { ok: true, signature: 'baseline', fileCount: 1 };
            return route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify(payload) });
        }
        if (url.pathname === '/api/eve-state/modular/save') {
            evidence.backendWrites += 1;
            backend = request.postDataJSON()?.audioflix || backend;
        } else if (url.pathname.startsWith('/api/audioflix/spotify-')) evidence.allowedPlayback += 1;
        else evidence.backendWrites += 1;
        return route.fulfill({ headers, contentType: 'application/json', body: '{"ok":true}' });
    });
    const barrier = await installBackendWriteBarrier(context, [BASE]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${BASE}/EveOS.html`);
    assert.equal(await page.evaluate(() => window.startupWrite), 403, 'even navigation-time controller writes are denied');
    const read = () => readBackendAudioflixSnapshot(() => page.evaluate(async () =>
        (await fetch('/api/eve-state/modular/load')).json()));
    evidence.before = await read();
    await barrier.proveBlocked(page);
    const fixture = await page.evaluate(async () => {
        const S = window.EveAudioflixState, sync = window.EveDataStore._modularSync;
        const capture = window.EveDataStore.CaptureModules.createCaptureCloneHelpers();
        window.EveDataStore.Store = { captureState: capture.captureState };
        const baseline = sync.captureStateHash();
        Object.assign(sync.state, { lastUploadedHash: baseline, lastSyncedLocalHash: baseline, remoteSignature: 'baseline' });
        S.addMusicGroup('Live fixture group');
        const track = S.addItem('music', { id: 'live-queue-isolation-0', title: 'Live fixture', url: 'https://example.test/mock.mp3' });
        S.toggleMusicGroup(track.id, 'Live fixture group', true);
        await S.flush('audioflix-live-isolation-fixture');
        const mirror = JSON.parse(localStorage.getItem('eveAudioflixFallbackState'));
        const journal = S.ensure() && window.EveAudioflixStateRecovery.readStructure('eveAudioflixFallbackState');
        // Exercise the actual TTL safety net responsible for leaks when saveConfig was overridden.
        sync.state.hashCacheAt = 0;
        await sync.syncCycle();
        return {
            mirror: mirror.music.some((item) => item.id === track.id),
            journal: journal.musicRefs.some((item) => item.id === track.id),
            captured: capture.captureState().audioflix.music.some((item) => item.id === track.id),
            changedHash: sync.captureStateHash() !== baseline
        };
    });
    assert.deepEqual(fixture, { mirror: true, journal: true, captured: true, changedHash: true }, 'the real controller chain must reach its independent writer');
    const matrix = await page.evaluate(async () => {
        const cases = [
            ['POST', '/api/eve-state/modular/save', {}], ['PUT', '/api/eve-state/modular/save', {}],
            ['PATCH', '/api/eve-state/modular/path', {}], ['DELETE', '/api/eve-state/modular/import', {}],
            ['POST', '/api/audioflix/spotify-client/approve', {}], ['POST', '/api/audioflix/spotify-browser/auth', {}],
            ['POST', '/api/audioflix/spotify-session', {}], ['POST', '/api/audioflix/spotify-browser/qualify-volume', {}],
            ['POST', '/api/audioflix/spotify-client/command', { command: { action: 'import' } }],
            ['POST', '/api/audioflix/spotify-client/command', { command: { action: 'auth' } }],
            ['POST', '/api/audioflix/spotify-client/command', { command: { action: 'unknown' } }],
            ['DELETE', '/api/audioflix/spotify-browser/stop', {}],
            ['POST', '/api/audioflix/spotify-client/command/', { command: { action: 'play' } }]
        ];
        const results = [];
        for (const [method, url, body] of cases) {
            const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const payload = await response.json();
            results.push(response.status === 403 && payload.blockedBy === 'audioflix-live-isolation');
        }
        const malformed = await fetch('/api/audioflix/spotify-client/command', { method: 'POST', body: 'not-json' });
        results.push(malformed.status === 403);
        return results;
    });
    assert(matrix.every(Boolean), 'every non-playback or malformed mutation must be denied');
    const allowed = await page.evaluate(async () => {
        const results = [];
        for (const path of ['connect', 'pair-status', 'status-watch']) {
            results.push((await fetch(`/api/audioflix/spotify-client/${path}`, { method: 'POST', body: '{}' })).ok);
        }
        for (const action of ['play', 'pause', 'resume', 'seek', 'stop', 'restart', 'volume', 'status', 'status-watch', 'release', 'detach']) {
            results.push((await fetch('/api/audioflix/spotify-client/command', {
                method: 'POST', body: JSON.stringify({ command: { action } })
            })).ok);
        }
        for (const path of ['start', 'stop', 'presentation', 'volume', 'session-status']) {
            results.push((await fetch(`/api/audioflix/spotify-browser/${path}`, { method: 'POST', body: '{}' })).ok);
        }
        for (const method of ['GET', 'HEAD', 'OPTIONS']) results.push((await fetch('/api/eve-state/modular/load', { method })).ok);
        return results;
    });
    assert(allowed.every(Boolean), 'real Spotify transport and read-only hydration must remain reachable');
    await page.evaluate(() => {
        const frame = document.createElement('iframe'); frame.id = 'probe'; frame.src = '/probe-frame'; document.body.append(frame);
    });
    const frame = page.frameLocator('#probe');
    await frame.locator('body').waitFor();
    assert.equal(await frame.locator('body').evaluate(async () =>
        (await fetch('/api/eve-state/modular/save', { method: 'POST', body: '{}' })).status), 403, 'iframe writes are denied');
    const sibling = await context.newPage();
    await sibling.goto(`${BASE}/probe-frame`);
    assert.equal(await sibling.evaluate(async () =>
        (await fetch('/api/eve-state/modular/save', { method: 'POST', body: '{}' })).status), 403, 'new tabs inherit the barrier');
    const workerStatus = await page.evaluate(() => new Promise((resolve, reject) => {
        const source = `onmessage = async () => postMessage((await fetch('${location.origin}/api/eve-state/modular/save', { method: 'POST', body: '{}' })).status)`;
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' })), worker = new Worker(url);
        const timer = setTimeout(() => { worker.terminate(); URL.revokeObjectURL(url); reject(new Error('Worker isolation timed out')); }, 2000);
        worker.onmessage = event => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); resolve(event.data); };
        worker.postMessage({});
    }));
    assert.equal(workerStatus, 403, 'dedicated workers cannot bypass the context barrier');
    await page.evaluate(async () => {
        for (const target of ['http://localhost:49137', 'http://127.0.0.1:49138', 'http://[::1]:49137']) {
            await fetch(`${target}/api/eve-state/modular/save`, { method: 'POST', body: '{}' }).catch(() => null);
        }
        await fetch('http://127.0.0.1:49138/api/audioflix/spotify-client/command', {
            method: 'POST', body: '{"command":{"action":"play"}}'
        }).catch(() => null);
    });
    const teardown = await page.evaluate(async () => {
        await window.EveAudioflixState.flush('audioflix-pagehide');
        return (await fetch('/api/eve-state/modular/save', { method: 'POST', body: '{}' })).status;
    });
    assert.equal(teardown, 403, 'the barrier survives disposal-time writes');
    fileFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-spotify-isolation-'));
    const fileFixture = path.join(fileFixtureDir, 'controller.html');
    fs.writeFileSync(fileFixture, document);
    const filePage = await context.newPage();
    filePage.on('pageerror', (error) => errors.push(error.message));
    await filePage.goto(pathToFileURL(fileFixture).href);
    assert.equal(await filePage.evaluate(() => location.protocol), 'file:', 'the second controller really uses a file origin');
    assert.equal(await filePage.evaluate(() => window.startupWrite), 403, 'file navigation-time writes are denied');
    await barrier.proveBlocked(filePage);
    const fileProof = await filePage.evaluate(async (base) => {
        const S = window.EveAudioflixState;
        S.addMusicGroup('File fixture group');
        const track = S.addItem('music', { id: 'live-queue-file-0', title: 'File fixture', url: 'https://example.test/file.mp3' });
        S.toggleMusicGroup(track.id, 'File fixture group', true);
        await S.flush('audioflix-file-isolation-fixture');
        const denied = await fetch(`${base}/api/eve-state/modular/save`, { method: 'POST', body: '{}' });
        const hydration = await (await fetch(`${base}/api/eve-state/modular/load`)).json();
        const playback = await fetch(`${base}/api/audioflix/spotify-client/connect`, { method: 'POST', body: '{}' });
        return { denied: denied.status === 403, original: hydration.state.audioflix.music.length === 1,
            playback: playback.ok, journal: window.EveAudioflixStateRecovery.readStructure('eveAudioflixFallbackState').musicRefs.some(item => item.id === track.id) };
    }, BASE);
    assert.deepEqual(fileProof, { denied: true, original: true, playback: true, journal: true }, 'file-origin controller keeps hydration/playback while isolating its real structural journal');
    evidence.after = await read();
    evidence.barrier = barrier.summary();
    assertBackendAudioflixUnchanged(evidence.before, evidence.after);
    assert.equal(evidence.backendWrites, 0, 'no fixture mutation reached the mocked canonical backend');
    assert(evidence.barrier.blockedCount >= 24 && evidence.barrier.allowedPlaybackCount >= 19, 'blocked-count proof includes the real sync save, aliases, frames and teardown');
    assert.equal(errors.length, 0, `controller page errors: ${errors.join(' | ')}`);
    assert.throws(() => assertBackendAudioflixUnchanged(evidence.before, { digest: 'changed' }), /No user state was restored/, 'digest drift fails without restoring user data');
    await assert.rejects(readBackendAudioflixSnapshot(async () => ({ ok: false })), /snapshot is unavailable/, 'missing canonical evidence fails closed');
    const reordered = await readBackendAudioflixSnapshot(async () => ({ ok: true, state: { audioflix: { durabilityRevision: 4,
        musicGroupMap: { 'real-track': ['Real group'] }, musicGroups: ['Real group'], music: [{ url: 'https://example.test/real.mp3', title: 'Real track', id: 'real-track' }] } } }));
    assertBackendAudioflixUnchanged(evidence.before, reordered);
    const { createLongQueueHarness } = await import('./audioflix_spotify_long_queue_live_support.mjs');
    const options = { base: BASE, engineUrl: `${BASE}/audioflix-spotify-engine.html` };
    createLongQueueHarness({ ...options, controllerUrl: `${BASE}/EveOS.html` }).validateUrls();
    createLongQueueHarness({ ...options, controllerUrl: 'file:///C:/qualification/EveOS.html' }).validateUrls();
    assert.throws(() => createLongQueueHarness({ ...options,
        controllerUrl: 'file://remote-server/share/EveOS.html' }).validateUrls(), /local controller/);
    assert.throws(() => createLongQueueHarness({ ...options,
        controllerUrl: 'https://example.com/EveOS.html' }).validateUrls(), /local controller/);
    evidence.ok = true;
}

main().catch((error) => {
    evidence.error = String(error.stack || error);
    console.error(evidence.error.split('\n').slice(0, 30).join('\n'));
    process.exitCode = 1;
}).finally(async () => {
    if (browser) await browser.close();
    if (fileFixtureDir) {
        fs.unlinkSync(path.join(fileFixtureDir, 'controller.html'));
        fs.rmdirSync(fileFixtureDir);
    }
    fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
    fs.writeFileSync(ARTIFACT, JSON.stringify(evidence, null, 2));
    if (evidence.ok) console.log(`AUDIOFLIX_SPOTIFY_LIVE_ISOLATION_SMOKE_OK blocked=${evidence.barrier.blockedCount} backend=unchanged`);
});
