'use strict';

// Helper side of control-plane preemption: the fixed /transport-interrupt handler invalidates a
// start whether or not its lifecycle lease exists yet, never lets it click or keep sounding, and
// never touches a newer generation. The real helper HTTP server enforces its private token.
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MODULES = path.join(ROOT, 'server_modules');
const activation = require(path.join(MODULES, 'audioflix_spotify_playback_activation.js'));
const { handleInterrupt } = require(path.join(MODULES, 'audioflix_spotify_playback_preemption.js'));
const { sleep, fakeEngine, fakeButton, fakePage, fakeFrame, options } = require('./audioflix_spotify_playback_fakes.shared.js');

const play = opts => activation.handleTransportWithActivation(opts, { action: 'play' });
const interrupt = (opts, reason) => handleInterrupt(opts, { reason });

async function helperSide() {
    // 1. Interrupt while the lease exists (between reading a Play control and clicking it).
    {
        const eng = fakeEngine({ generation: 31, spotifyId: 'a1' });
        let opts;
        let fired;
        const button = fakeButton({ onVisible: async () => { fired = fired || interrupt(opts, 'paused'); await fired; } });
        opts = options(fakePage(eng, [fakeFrame('a1', button)]));
        const started = Date.now();
        const result = await play(opts);
        assert.equal(result.lifecycle, 'paused');
        assert.ok(Date.now() - started < 3000, 'old start aborts promptly');
        assert.equal((await fired).quiesced, true, 'Pause quiesces the in-flight generation immediately');
        await sleep(1500);
        assert.equal(button.clicks, 0, 'no late click after an interrupt');
        assert.equal(opts.runtime.playbackLeases.size, 0);
    }

    // 2. Interrupt before lease creation: the engine Play is still pending when it arrives.
    {
        const eng = fakeEngine({ generation: 33, spotifyId: 'a2' });
        let release;
        const held = new Promise(resolve => { release = resolve; });
        const command = eng.command;
        eng.command = (action, data) => {
            if (action !== 'play') return command(action, data);
            Object.assign(eng.st, { playRequested: true, status: 'starting' });
            return held.then(() => ({ ...eng.st }));
        };
        const button = fakeButton();
        const opts = options(fakePage(eng, [fakeFrame('a2', button)]));
        const pending = play(opts);
        await sleep(50);
        assert.equal(opts.runtime.playbackLeases?.size || 0, 0, 'no lease exists yet');
        const ack = await interrupt(opts, 'superseded');
        assert.equal(ack.inFlight, true);
        release();
        const result = await pending;
        assert.equal(result.lifecycle, 'superseded', 'pre-lease interrupt still invalidates the start');
        assert.equal(button.clicks, 0);
        assert.equal(eng.st.playRequested, false, 'abandoned start withdrew its own generation');
        assert.equal(opts.runtime.playbackLeases.size, 0);
        assert.equal(opts.runtime.startsInFlight, 0);
    }

    // 4. A -> B: A is invalidated; B's ordinary load/play then proceeds and is not quiesced.
    {
        const eng = fakeEngine({ generation: 35, spotifyId: 'a3' });
        let media = [];
        let opts;
        let fired;
        const button = fakeButton({
            onVisible: async () => { fired = fired || interrupt(opts, 'superseded'); await fired; },
            onClick: async () => { eng.st.status = 'playing'; media = [{ paused: false, ended: false, readyState: 4 }]; }
        });
        opts = options(fakePage(eng, [fakeFrame('a3', button), fakeFrame('b3', button)]),
            { spotifySnapshots: async () => [{ media }] });
        const a = await play(opts);
        assert.equal(a.lifecycle, 'superseded');
        assert.equal(button.clicks, 0, 'A never clicks after B was accepted');
        const loaded = await activation.handleTransportWithActivation(opts, { action: 'load', spotifyId: 'b3', generation: 36 });
        assert.equal(loaded.ok, true);
        const b = await play(opts);
        assert.equal(b.ok, true, b.reason);
        assert.equal(b.state.generation, 36);
        assert.equal(eng.st.playRequested, true, 'B is not paused by A');
    }

    // 5. Switch-away Stop while the old start is already audible but not yet confirmed stable.
    {
        const eng = fakeEngine({ generation: 37, spotifyId: 'a4' });
        let media = [];
        const audible = () => media.some(item => !item.paused);
        const command = eng.command;
        eng.command = (action, data) => {
            const out = command(action, data);
            if (action === 'play') { eng.st.status = 'playing'; media = [{ paused: false, ended: false, readyState: 4 }]; }
            if (action === 'pause') media = media.map(item => ({ ...item, paused: true }));
            return out;
        };
        const opts = options(fakePage(eng, [fakeFrame('a4', fakeButton())]),
            { spotifySnapshots: async () => [{ media }] });
        const pending = play(opts);
        await sleep(1700); // inside the 2.2s strong-confirmation verify window
        assert.equal(audible(), true);
        const at = Date.now();
        const ack = await interrupt(opts, 'stopped');
        assert.equal(ack.quiesced, true);
        assert.equal(audible(), false, 'old Spotify is silent immediately, not after the start window');
        assert.ok(Date.now() - at < 1500);
        const result = await pending;
        assert.equal(result.lifecycle, 'stopped');
    }

    // Reasons are fixed; the interrupt never loads, plays or evaluates caller input.
    const opts = options(fakePage(fakeEngine(), []));
    for (const reason of ['load', 'play', 'eval', '']) assert.equal((await interrupt(opts, reason)).ok, false);
}

function request(port, pathname, token) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ reason: 'paused' });
        const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
        if (token != null) headers['x-eveos-spotify-token'] = token;
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers }, (res) => {
            let text = '';
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : {} }));
        });
        req.setTimeout(8000, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end(body);
    });
}

// 7. The real helper serves /transport-interrupt only with the private token.
async function authentication() {
    const page = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>engine</title>');
    });
    await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
    const pagePort = page.address().port;
    const helperPort = await new Promise((resolve) => {
        const probe = http.createServer().listen(0, '127.0.0.1', () => {
            const { port } = probe.address(); probe.close(() => resolve(port));
        });
    });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-spotify-preempt-'));
    const token = crypto.randomBytes(24).toString('hex');
    const child = spawn(process.execPath, [path.join(MODULES, 'audioflix_spotify_browser.js'),
        '--port', String(helperPort), '--profile', profile, '--session', 'preempt-smoke',
        '--page', `http://127.0.0.1:${pagePort}/audioflix-spotify-engine.html?playwright=headless`],
    { env: { ...process.env, EVEOS_SPOTIFY_BROWSER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', chunk => { log += chunk; });
    child.stderr.on('data', chunk => { log += chunk; });
    try {
        const deadline = Date.now() + 45000;
        while (!/ready: listening/.test(log)) {
            if (child.exitCode != null || Date.now() > deadline) throw new Error(`helper did not start:\n${log.slice(-1500)}`);
            await sleep(200);
        }
        assert.equal((await request(helperPort, '/transport-interrupt', null)).status, 403);
        assert.equal((await request(helperPort, '/transport-interrupt', 'x'.repeat(token.length))).status, 403);
        const ok = await request(helperPort, '/transport-interrupt', token);
        assert.equal(ok.status, 200);
        assert.equal(ok.body.interrupted, true);
        assert.equal(ok.body.inFlight, false, 'no start in flight, so nothing is quiesced');
        await request(helperPort, '/shutdown', token).catch(() => null);
    } finally {
        if (child.exitCode == null) child.kill('SIGTERM');
        page.close();
        fs.rmSync(profile, { recursive: true, force: true });
    }
}

(async () => {
    await helperSide();
    await authentication();
    console.log('AUDIOFLIX_SPOTIFY_PREEMPTION_HELPER_SMOKE_OK (lease/pre-lease interrupt, A->B, audible stop, real-helper token)');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
