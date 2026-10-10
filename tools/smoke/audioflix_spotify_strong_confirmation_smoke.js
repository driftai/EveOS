'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { reactivateStartup, samePausedStartup } = require('../../server_modules/audioflix_spotify_startup_reactivation.js');
const { seekManagedMedia, handleManagedSeek } = require('../../server_modules/audioflix_spotify_media_seek.js');

const activation = require(path.resolve(
    __dirname, '..', '..', 'server_modules', 'audioflix_spotify_playback_activation.js'
));

async function checkTrustedRecovery() {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.route('https://open.spotify.com/embed/track/*', route => route.fulfill({
            contentType: 'text/html',
            body: `<button data-testid="play-pause-button" aria-label="Pause">Pause</button>
                <script>
                window.clicks = [];
                window.seeks = [];
                window.__eveSpotifyManagedControl = { seek: value => {
                    window.seeks.push(value);
                    return { reached: true, currentTime: Math.min(value, 30), duration: 30 };
                } };
                document.querySelector('button').onclick = event => {
                    window.clicks.push({ trusted: event.isTrusted, label: event.target.getAttribute('aria-label') });
                    const label = window.clicks.length === 1 ? 'Play' : 'Pause';
                    event.target.setAttribute('aria-label', label);
                    event.target.textContent = label;
                };
                </script>`
        }));
        await page.setContent('<iframe src="https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT"></iframe>');
        const frame = page.frames().find(value => value.url().includes('/embed/track/'));
        await frame.locator('button').waitFor();
        const paused = { playingCount: 0, transport: { status: 'provider-paused', paused: true, currentTime: 0, generation: 19 } };
        const notes = [], runtime = { playbackKickCount: 0 };
        const options = { page, expectedGeneration: 19, observe: async () => paused, runtime,
            note: (kind, message) => notes.push([kind, message]),
            isSpotifyEmbedUrl: url => url.startsWith('https://open.spotify.com/embed/') };
        const result = await reactivateStartup(options);
        const clicks = await frame.evaluate(() => window.clicks);
        assert.equal(result.clicked, true, 'stale Pause is reset and followed by a trusted Play');
        assert.deepEqual(clicks.map(value => value.label), ['Pause', 'Play']);
        assert.equal(clicks.every(value => value.trusted), true, 'recovery uses actual mouse input, never DOM dispatch');
        assert.equal(runtime.playbackKickCount, 1);
        assert.ok(notes.some(([kind]) => kind === 'playback-startup-reactivate'));

        assert.equal(samePausedStartup({ ...paused, transport: { ...paused.transport, currentTime: 12 } }, 19), false);
        assert.equal(samePausedStartup({ ...paused, transport: { ...paused.transport, generation: 20 } }, 19), false);
        assert.equal(samePausedStartup({ ...paused, playingCount: 1 }, 19), false);
        assert.equal(samePausedStartup({ ...paused, transport: { ...paused.transport, status: 'paused' } }, 19), false,
            'explicit Pause during a recovery await cancels further trusted input');
        const acknowledgedPause = { ...paused, transport: { ...paused.transport, playRequested: false } };
        assert.equal(samePausedStartup(acknowledgedPause, 19), false,
            'late provider pause acknowledgement cannot erase explicit Pause intent');
        assert.equal(activation.shouldRecoverLostConfirmation(acknowledgedPause, 19), false);
        assert.equal(samePausedStartup(paused, 0), false, 'unidentified startup cannot be activated');
        let reads = 0;
        const replaced = await reactivateStartup({ ...options, observe: async () => {
            reads += 1;
            return reads < 2 ? paused : { ...paused, transport: { ...paused.transport, generation: 20 } };
        } });
        assert.equal(replaced.clicked, false, 'generation is rechecked after reading button metadata');
        assert.equal((await frame.evaluate(() => window.clicks)).length, 2, 'replaced generation never receives a click');
        const slow = await reactivateStartup({ ...options, budgetMs: 20,
            observe: async () => { await new Promise(resolve => setTimeout(resolve, 50)); return paused; } });
        assert.equal(slow.clicked, false, 'an observation finishing after deadline cannot authorize a click');
        await frame.evaluate(() => {
            document.querySelector('button').onclick = event => event.target.remove();
        });
        const removalAt = Date.now();
        const removed = await reactivateStartup({ ...options, budgetMs: 200 });
        assert.equal(removed.clicked, false, 'disappearing control is not reported as activation');
        assert.ok(Date.now() - removalAt < 1500, 'locator metadata reads respect the bounded recovery budget');
        await page.evaluate(() => {
            window.EveAudioflixSpotifyEngine = { ready: true,
                snapshot: () => ({ generation: 19, spotifyId: '4cOdK2wGLETKBW3PvgPWqT' }),
                command: () => { throw new Error('Managed songs must not send competing SDK seeks'); },
                acknowledgeMediaSeek: value => ({ ...value, status: 'playing' }) };
        });
        const target = { generation: 19, spotifyId: '4cOdK2wGLETKBW3PvgPWqT' };
        const sought = await seekManagedMedia(options, target, 120);
        assert.equal(sought.currentTime, 30, 'native track seeking respects available preview/media duration');
        const wrongSeek = await seekManagedMedia(options, { ...target, generation: 18 }, 0);
        assert.equal(wrongSeek.superseded, true, 'superseded transport cannot seek the currently loaded media');
        assert.equal((await frame.evaluate(() => window.seeks)).length, 1);
        const nativeCommand = await handleManagedSeek(options, { seconds: 120 });
        assert.equal(nativeCommand.ok, true);
        assert.equal(nativeCommand.state.currentTime, 30, 'acknowledgement mirrors actual clamped media position, not requested position');
        await frame.evaluate(() => { window.__eveSpotifyManagedControl.seek = () => ({ reached: false }); });
        const unavailable = await handleManagedSeek(options, { seconds: 12 });
        assert.equal(unavailable.ok, false, 'unavailable media fails honestly rather than faking SDK seek success');
    } finally { await browser.close(); }
}

(async () => {
    const providerPauseOnly = {
        playing: true,
        providerShowsPlaying: true,
        playingCount: 0,
        transport: { status: 'provider-paused', paused: true, currentTime: 0, generation: 18 }
    };
    assert.equal(
        activation.isConfirmedPlaybackObservation(providerPauseOnly),
        false,
        'a Spotify Pause control alone is only a hint, not proof that playback stuck'
    );
    assert.equal(activation.isConfirmedPlaybackObservation({ ...providerPauseOnly,
        mediaObserved: true, transport: { status: 'playing', generation: 18 } }), false,
    'an instrumented paused media element outranks a stale SDK Playing event');

    const notes = [];
    let waits = 0;
    const reverted = await activation.confirmPlaybackObservation(
        providerPauseOnly,
        async () => {
            waits += 1;
            return {
                playing: false,
                providerShowsPlaying: false,
                playingCount: 0,
                transport: { status: 'provider-paused', paused: true, currentTime: 0, generation: 18 }
            };
        },
        (kind, message) => notes.push([kind, message])
    );
    assert.equal(waits, 1, 'provider-only success gets exactly one bounded strong-confirmation wait');
    assert.equal(activation.isConfirmedPlaybackObservation(reverted), false,
        'a Pause flash that reverts to provider-paused is not reported as successful playback');
    assert.ok(notes.some(([kind]) => kind === 'playback-confirm-pending'),
        'the false-positive confirmation path is diagnosable in helper logs');

    let positiveWaits = 0;
    const recovered = await activation.confirmPlaybackObservation(
        providerPauseOnly,
        async () => {
            positiveWaits += 1;
            return {
                playing: true,
                providerShowsPlaying: true,
                playingCount: 1,
                transport: { status: 'playing', paused: false, currentTime: 0.35, generation: 18 }
            };
        }
    );
    assert.equal(positiveWaits, 1);
    assert.equal(activation.isConfirmedPlaybackObservation(recovered), true,
        'provider Pause plus engine/media evidence is accepted');

    let unnecessaryWaits = 0;
    const alreadyConfirmed = {
        playing: true,
        providerShowsPlaying: false,
        playingCount: 1,
        transport: { status: 'playing', paused: false, currentTime: 1.2, generation: 18 }
    };
    const unchanged = await activation.confirmPlaybackObservation(
        alreadyConfirmed,
        async () => { unnecessaryWaits += 1; return providerPauseOnly; }
    );
    assert.equal(unnecessaryWaits, 0, 'confirmed playback is not delayed by another wait');
    assert.equal(unchanged, alreadyConfirmed);

    assert.equal(activation.isConfirmedPlaybackObservation({
        playing: true,
        providerShowsPlaying: true,
        playingCount: 2,
        transport: { status: 'provider-paused' }
    }), true, 'instrumented media playback alone is strong evidence even if transport lags');

    // Live run 698f589f0 track 19: playback was strongly confirmed after a retoggle, then reverted
    // to provider-paused at 0s before the controller readiness poll. Do not hand that transient
    // success back to the queue: verify it once and issue at most one same-generation controller
    // resume before accepting the activation.
    const strong19 = {
        playing: true,
        providerShowsPlaying: true,
        playingCount: 1,
        transport: { status: 'playing', paused: false, currentTime: 0.42, generation: 19 }
    };
    const paused19 = {
        playing: true,
        providerShowsPlaying: true,
        playingCount: 0,
        transport: { status: 'provider-paused', paused: true, currentTime: 0, generation: 19 }
    };
    const stable19 = {
        playing: true,
        providerShowsPlaying: true,
        playingCount: 1,
        transport: { status: 'playing', paused: false, currentTime: 0.61, generation: 19 }
    };
    const relapseNotes = [];
    const observations = [paused19, stable19];
    let resumeCalls = 0;
    let relapseWaits = 0;
    const relapse = await activation.stabilizeConfirmedPlayback({
        observed: strong19,
        expectedGeneration: 19,
        verifyMs: 0,
        sleep: async () => {},
        observe: async () => observations.shift() || stable19,
        resume: async () => { resumeCalls += 1; return { ok: true, state: { ...paused19.transport } }; },
        waitForConfirmed: async () => { relapseWaits += 1; return stable19; },
        note: (kind, message) => relapseNotes.push([kind, message])
    });
    assert.equal(resumeCalls, 1, 'a confirmed startup relapse receives exactly one bounded controller resume');
    assert.equal(relapseWaits, 1, 'relapse recovery performs one bounded strong-confirmation wait');
    assert.equal(relapse.recovered, true);
    assert.equal(relapse.stable, true);
    assert.equal(activation.isConfirmedPlaybackObservation(relapse.observed), true,
        'the queue only receives success after the recovery remains strongly confirmed');
    assert.ok(relapseNotes.some(([kind]) => kind === 'playback-confirm-lost'));
    assert.ok(relapseNotes.some(([kind]) => kind === 'playback-confirm-recover'));

    let wrongGenerationResume = 0;
    const wrongGeneration = await activation.stabilizeConfirmedPlayback({
        observed: strong19,
        expectedGeneration: 19,
        verifyMs: 0,
        sleep: async () => {},
        observe: async () => ({
            ...paused19,
            transport: { ...paused19.transport, generation: 20 }
        }),
        resume: async () => { wrongGenerationResume += 1; return { ok: true }; },
        waitForConfirmed: async () => stable19
    });
    assert.equal(wrongGenerationResume, 0, 'a replaced track generation is never resumed by relapse recovery');
    assert.equal(wrongGeneration.recovered, false);
    assert.equal(wrongGeneration.stable, false);

    let stableResume = 0;
    const stayedStrong = await activation.stabilizeConfirmedPlayback({
        observed: strong19,
        expectedGeneration: 19,
        verifyMs: 0,
        sleep: async () => {},
        observe: async () => stable19,
        resume: async () => { stableResume += 1; return { ok: true }; },
        waitForConfirmed: async () => stable19
    });
    assert.equal(stableResume, 0, 'stable confirmed playback never receives a redundant resume');
    assert.equal(stayedStrong.stable, true);

    // Live 9b20e756b queue08: controller resume briefly confirms, then relapses to paused/0
    // while the embed still advertises Pause. One trusted, startup-only activation must be
    // available after that failed resume; a stale button label must not suppress recovery.
    for (const transientResume of [false, true]) {
        let resumes = 0, activations = 0, confirmations = 0;
        const seen = [paused19, ...(transientResume ? [paused19] : []), stable19];
        const result = await activation.stabilizeConfirmedPlayback({
            observed: strong19, expectedGeneration: 19, verifyMs: 0,
            sleep: async () => {},
            observe: async () => seen.shift() || stable19,
            resume: async () => { resumes += 1; return { ok: true }; },
            reactivate: async () => { activations += 1; return { clicked: true }; },
            waitForConfirmed: async () => {
                confirmations += 1;
                return confirmations === 1 ? (transientResume ? strong19 : paused19) : stable19;
            }
        });
        assert.equal(resumes, 1, 'startup recovery never loops controller resumes');
        assert.equal(activations, 1, 'failed controller resume gets one bounded trusted activation');
        assert.equal(result.stable, true, 'trusted activation is confirmed again before queue success');
    }

    let boundedActivations = 0;
    let initialActivations = 0;
    const initialBlocked = await activation.stabilizeConfirmedPlayback({
        observed: paused19, expectedGeneration: 19, verifyMs: 0, sleep: async () => {},
        observe: async () => stable19, resume: async () => { throw new Error('No resume loop'); },
        reactivate: async () => { initialActivations += 1; return { clicked: true }; },
        waitForConfirmed: async () => stable19
    });
    assert.equal(initialActivations, 1, 'an initial false SDK/Pause flash also gets one trusted startup activation');
    assert.equal(initialBlocked.stable, true);
    const pendingReplay = { ...paused19, transport: { ...paused19.transport,
        status: 'starting', started: false, replayPending: true } };
    assert.equal(activation.shouldRecoverLostConfirmation(pendingReplay, 19), true,
        'same-URI restart stuck at zero still gets bounded startup activation while replay is fenced');
    assert.equal(activation.shouldRecoverLostConfirmation({ ...pendingReplay,
        transport: { ...pendingReplay.transport, replayPending: false } }, 19), false,
    'ordinary starting state is not a replay recovery authorization');
    assert.equal(activation.shouldRecoverLostConfirmation({ ...pendingReplay,
        transport: { ...pendingReplay.transport, status: 'paused' } }, 19), false,
    'explicit Pause never authorizes replay recovery');
    assert.equal(activation.shouldRecoverLostConfirmation(pendingReplay, 20), false,
        'stale replay generation never authorizes activation');
    const stillBlocked = await activation.stabilizeConfirmedPlayback({
        observed: strong19, expectedGeneration: 19, verifyMs: 0, sleep: async () => {},
        observe: async () => paused19, resume: async () => ({ ok: true }),
        reactivate: async () => { boundedActivations += 1; return { clicked: true }; },
        waitForConfirmed: async () => paused19
    });
    assert.equal(boundedActivations, 1, 'an unplayable startup never loops trusted activation');
    assert.equal(stillBlocked.stable, false, 'a click is not playback proof');
    let generationWaits = 0;
    const replacedDuringRecovery = await activation.stabilizeConfirmedPlayback({
        observed: strong19, expectedGeneration: 19, verifyMs: 0, sleep: async () => {},
        observe: async () => paused19, resume: async () => ({ ok: true }),
        reactivate: async () => ({ clicked: true }),
        waitForConfirmed: async () => ++generationWaits === 1 ? paused19 : {
            ...stable19, transport: { ...stable19.transport, generation: 20 }
        }
    });
    assert.equal(replacedDuringRecovery.stable, false,
        'another generation playing during confirmation is not success for the superseded startup');
    await checkTrustedRecovery();

    console.log('AUDIOFLIX_SPOTIFY_STRONG_CONFIRMATION_SMOKE_OK');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
