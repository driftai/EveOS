'use strict';

// Deterministic delayed-response regressions for the managed Spotify lifecycle lease: once a
// start/seek has expired, been superseded, paused, stopped or page-reset, no late Play click,
// resume or stale seek acknowledgement may escape.
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULES = path.resolve(__dirname, '..', '..', 'server_modules');
const lease = require(path.join(MODULES, 'audioflix_spotify_playback_lease.js'));
const activation = require(path.join(MODULES, 'audioflix_spotify_playback_activation.js'));
const { handleManagedSeek } = require(path.join(MODULES, 'audioflix_spotify_media_seek.js'));
const { reactivateStartup } = require(path.join(MODULES, 'audioflix_spotify_startup_reactivation.js'));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const never = () => new Promise(() => {});
const EMBED = 'https://open.spotify.com/embed/track/';

function fakeEngine(initial = {}) {
    const st = { generation: 1, spotifyId: 'aaa', status: 'loaded', playRequested: false,
        paused: true, currentTime: 0, ...initial };
    const engine = {
        ready: true, st, commands: [], acks: [],
        snapshot: () => ({ ...st }),
        command(action, data = {}) {
            engine.commands.push(action);
            if (action === 'load') Object.assign(st, { generation: data.generation, spotifyId: data.spotifyId,
                status: 'loaded', playRequested: false });
            if (action === 'play') Object.assign(st, { playRequested: true, status: 'starting' });
            if (action === 'pause') Object.assign(st, { playRequested: false, status: 'paused' });
            return { ...st };
        },
        acknowledgeMediaSeek(target) { engine.acks.push(target); return { ...st }; }
    };
    return engine;
}

function fakeButton(hooks = {}) {
    const button = {
        clicks: 0,
        getAttribute: async name => (name === 'aria-label' ? 'Play' : name === 'data-testid' ? 'play-pause-button' : ''),
        innerText: async () => '',
        isVisible: async () => { if (hooks.onVisible) await hooks.onVisible(); return true; },
        click: async () => { button.clicks += 1; if (hooks.onClick) await hooks.onClick(); },
        dispatchEvent: async () => { button.clicks += 1; }
    };
    return button;
}

function fakePage(engine, frames = []) {
    const page = {
        closed: false,
        isClosed: () => page.closed,
        frames: () => frames,
        waitForFunction: async () => true,
        evaluate: async (fn, arg) => { global.window = { EveAudioflixSpotifyEngine: engine }; return fn(arg); }
    };
    return page;
}

function fakeFrame(id, button, seek) {
    return {
        url: () => `${EMBED}${id}`,
        locator: (selector) => {
            if (selector === 'body') return { count: async () => 1, hover: async () => {} };
            return { count: async () => (button ? 1 : 0), nth: () => button, first: () => button };
        },
        evaluate: async (fn, arg) => (seek ? seek(arg) : null)
    };
}

function options(page, extra = {}) {
    const notes = [];
    return {
        notes,
        page, runtime: { playbackKickCount: 0, lastPlaybackKickAt: 0 },
        spotifySnapshots: async () => [], isSpotifyEmbedUrl: url => String(url).startsWith(EMBED),
        normalizeTrackId: value => String(value || ''), note: (kind, message) => notes.push([kind, message]),
        ...extra
    };
}

(async () => {
    // 1. Lease primitives: deadline, cancellation wake-up and generation/intent fencing.
    const runtime = {};
    const engine = fakeEngine({ playRequested: true });
    const short = lease.createPlaybackLease({ runtime, generation: 1, spotifyId: 'aaa', budgetMs: 60,
        readState: async () => engine.snapshot() });
    let started = Date.now();
    await assert.rejects(short.bound(never), error => error.lifecycle === 'deadline');
    assert.ok(Date.now() - started < 400, 'a hung browser call is bounded by the shared deadline');
    short.release();

    const cancelled = lease.createPlaybackLease({ runtime, generation: 1, budgetMs: 5000 });
    started = Date.now();
    setTimeout(() => lease.cancelLeases(runtime, 'stopped'), 30);
    await assert.rejects(cancelled.sleep(4000), error => error.lifecycle === 'stopped');
    assert.ok(Date.now() - started < 400, 'Stop wakes a sleeping recovery step immediately');
    cancelled.release();

    const fenced = lease.createPlaybackLease({ runtime, generation: 1, spotifyId: 'aaa', budgetMs: 5000,
        readState: async () => engine.snapshot() });
    engine.st.generation = 2;
    await assert.rejects(fenced.verify(), error => error.lifecycle === 'superseded');
    fenced.release();
    engine.st.generation = 1;
    engine.st.playRequested = false;
    const paused = lease.createPlaybackLease({ runtime, generation: 1, budgetMs: 5000,
        readState: async () => engine.snapshot() });
    await assert.rejects(paused.verify(), error => error.lifecycle === 'paused');
    paused.release();
    assert.equal(runtime.playbackLeases.size, 0, 'released leases do not accumulate');
    assert.deepEqual(['pause', 'stop', 'load', 'play', 'resume', 'restart', 'seek', 'status']
        .map(lease.cancelReasonForAction), ['paused', 'stopped', 'superseded', 'superseded', 'superseded', 'superseded', '', '']);

    // 2. A start that never confirms answers inside its budget and withdraws its play intent.
    {
        const eng = fakeEngine({ generation: 5, spotifyId: 'bbb' });
        const button = fakeButton();
        const page = fakePage(eng, [fakeFrame('bbb', button)]);
        const opts = options(page, { startBudgetMs: 900 });
        started = Date.now();
        const result = await activation.handleTransportWithActivation(opts, { action: 'play' });
        const elapsed = Date.now() - started;
        assert.equal(result.ok, false);
        assert.equal(result.lifecycle, 'deadline');
        assert.equal(result.deadlineExpired, true);
        assert.notEqual(result.timeout, true, 'a settled helper deadline is not an in-flight RPC timeout');
        assert.ok(elapsed < 2600, `start settles near its budget (${elapsed}ms)`);
        assert.equal(eng.commands.at(-1), 'pause', 'expired start withdraws same-generation play intent');
        const clicksAtReturn = button.clicks;
        await sleep(1500);
        assert.equal(button.clicks, clicksAtReturn, 'no Play click escapes after the deadline');
        assert.equal(opts.runtime.playbackLeases.size, 0);
    }

    // 3. A newer load arriving while the scan is between reading a control and clicking it.
    {
        const eng = fakeEngine({ generation: 7, spotifyId: 'ccc' });
        let opts;
        let newer;
        const button = fakeButton({ onVisible: async () => {
            if (!newer) newer = activation.handleTransportWithActivation(opts,
                { action: 'load', spotifyId: 'ddd', generation: 8 });
            await newer;
        } });
        const page = fakePage(eng, [fakeFrame('ccc', button)]);
        opts = options(page);
        const result = await activation.handleTransportWithActivation(opts, { action: 'play' });
        assert.equal(result.lifecycle, 'superseded');
        assert.equal(button.clicks, 0, 'superseded start never clicks Play for the old generation');
        assert.ok(!eng.commands.slice(eng.commands.indexOf('load')).includes('pause'),
            'a superseded start does not pause the newer generation');
        assert.ok(opts.notes.some(([kind]) => kind === 'playback-lease-cancel'));
    }

    // 4. An explicit Pause that reached the engine during the scan clears play intent.
    {
        const eng = fakeEngine({ generation: 9, spotifyId: 'eee' });
        const button = fakeButton({ onVisible: async () => { eng.command('pause'); } });
        const opts = options(fakePage(eng, [fakeFrame('eee', button)]));
        const result = await activation.handleTransportWithActivation(opts, { action: 'play' });
        assert.equal(result.lifecycle, 'paused');
        assert.equal(button.clicks, 0, 'explicit Pause is never overridden by a late Play click');
    }

    // 5. Happy path still requires strong media confirmation and keeps its lease bookkeeping clean.
    {
        const eng = fakeEngine({ generation: 11, spotifyId: 'fff' });
        let media = [];
        const button = fakeButton({ onClick: async () => { eng.st.status = 'playing';
            media = [{ paused: false, ended: false, readyState: 4 }]; } });
        const opts = options(fakePage(eng, [fakeFrame('fff', button)]), {
            spotifySnapshots: async () => [{ media }]
        });
        const result = await activation.handleTransportWithActivation(opts, { action: 'play' });
        assert.equal(result.ok, true, result.reason);
        assert.equal(result.playbackActivated, true);
        assert.equal(button.clicks, 1);
        assert.equal(opts.runtime.playbackLeases.size, 0);
    }

    // 6. A hung media seek is bounded, and a seek for a replaced generation is never acknowledged.
    {
        const eng = fakeEngine({ generation: 13, spotifyId: 'ggg', status: 'playing' });
        const opts = options(fakePage(eng, [fakeFrame('ggg', null, never)]), { seekBudgetMs: 300 });
        started = Date.now();
        const hung = await handleManagedSeek(opts, { seconds: 30 });
        assert.equal(hung.ok, false);
        assert.equal(hung.lifecycle, 'deadline');
        assert.ok(Date.now() - started < 1200, 'hung seek evaluation is bounded');
        assert.equal(eng.acks.length, 0);

        const eng2 = fakeEngine({ generation: 14, spotifyId: 'hhh', status: 'playing' });
        const seek = () => { eng2.st.generation = 15; return { reached: true, currentTime: 30, duration: 200 }; };
        const opts2 = options(fakePage(eng2, [fakeFrame('hhh', null, seek)]));
        const stale = await handleManagedSeek(opts2, { seconds: 30 });
        assert.equal(stale.lifecycle, 'superseded');
        assert.equal(eng2.acks.length, 0, 'stale seek completion is never acknowledged');
    }

    // 7. Trusted startup reactivation propagates lease cancellation instead of clicking.
    {
        const button = fakeButton();
        button.count = async () => 1;
        const page = fakePage(fakeEngine(), [fakeFrame('iii', button)]);
        const observe = async () => ({ transport: { generation: 3, status: 'provider-paused', paused: true,
            playRequested: true, currentTime: 0 }, playingCount: 0 });
        await assert.rejects(reactivateStartup({ page, observe, expectedGeneration: 3,
            isSpotifyEmbedUrl: url => String(url).startsWith(EMBED), note: () => {}, runtime: {},
            guard: async () => { throw new lease.PlaybackLeaseAbort('superseded'); } }),
        error => error.lifecycle === 'superseded');
        assert.equal(button.clicks, 0);
    }

    console.log('AUDIOFLIX_SPOTIFY_PLAYBACK_LEASE_SMOKE_OK');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
