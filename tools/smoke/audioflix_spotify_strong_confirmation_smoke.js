'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const activation = require(path.resolve(
    __dirname, '..', '..', 'server_modules', 'audioflix_spotify_playback_activation.js'
));

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

    console.log('AUDIOFLIX_SPOTIFY_STRONG_CONFIRMATION_SMOKE_OK');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
