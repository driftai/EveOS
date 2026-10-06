'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const audio = read('js', 'modules', 'features', 'audioflix', 'audioflix.audio.js');
const capture = read('js', 'modules', 'features', 'audioflix', 'audioflix.audio.capture.js');
const spotify = read('js', 'modules', 'features', 'audioflix', 'audioflix.native.spotify.js');
const host = read('server', 'audioflix-provider-host.html');
const ui = read('js', 'modules', 'features', 'audioflix', 'audioflix.ui.js');

function ordered(source, first, second, message) {
    const a = source.indexOf(first);
    const b = source.indexOf(second);
    assert.ok(a >= 0, `missing first contract token: ${first}`);
    assert.ok(b >= 0, `missing second contract token: ${second}`);
    assert.ok(a < b, message);
}

test('Audioflix prepares local media before explicit Spotify playback ownership', () => {
    ordered(
        audio,
        'EveAudioflixLocalPlayback?.prepare?.(item)',
        'EveAudioflixNativeSpotify?.preparePlaybackSource?.(item, prepared)',
        'localized media must win before Spotify online matching runs'
    );
    ordered(
        audio,
        'EveAudioflixNativeSpotify?.preparePlaybackSource?.(item, prepared)',
        'EveAudioflixAudioSource?.needsResolution?.(requestedItem.url)',
        'verified Spotify source must be established before provider/direct resolution'
    );
    assert.match(spotify, /eveOwnedPlaybackSource:\s*true/);
    assert.match(spotify, /preferEveDirectAudio:\s*true/);
});

test('YouTube bridge normalizes EveOS 0..1 volume to YouTube 0..100 exactly once', () => {
    assert.match(host, /const youtubeVolume = \(value\) =>/);
    assert.match(host, /numeric <= 1 \? numeric \* 100 : numeric/);
    assert.match(host, /player\.setVolume\(youtubeVolume\(command\.value\)\)/);
    assert.match(host, /event\.target\.setVolume\(youtubeVolume\(volume\)\)/);
});

test('routed PCM reads current Audioflix volume for every outgoing chunk', () => {
    assert.match(capture, /encodePcm\?\.\(chunk, 0, chunk\.length, getVolume\(\)\)/);
    assert.match(audio, /activeStreamVolume = vol/);
});

test('all Eve-owned transports expose a natural Ended signal to the group queue', () => {
    assert.match(audio, /audio\.addEventListener\('ended'/);
    assert.match(audio, /musicCapture\?\.stop\(\{ drain: true \}\)/);
    assert.match(audio, /status:\s*lastStatus,\s*item:\s*endedItem,\s*settle/);
    assert.match(host, /0:\s*'ended'/);
    assert.match(ui, /status === 'Ended'/);
    assert.match(ui, /Promise\.resolve\(e\.detail\?\.settle\)/);
    assert.match(ui, /playQueueIndex\(expectedIndex \+ 1\)/);
});
