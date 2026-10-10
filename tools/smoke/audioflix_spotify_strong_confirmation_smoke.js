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

    console.log('AUDIOFLIX_SPOTIFY_STRONG_CONFIRMATION_SMOKE_OK');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
