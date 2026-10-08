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

test('Audioflix prepares local media before restoring official Spotify playback ownership', () => {
    ordered(
        audio,
        'EveAudioflixLocalPlayback?.prepare?.(item)',
        'EveAudioflixNativeSpotify?.preparePlaybackSource?.(item, prepared)',
        'localized media must win before Spotify provider routing runs'
    );
    ordered(
        audio,
        'EveAudioflixNativeSpotify?.preparePlaybackSource?.(item, prepared)',
        'EveAudioflixAudioSource?.needsResolution?.(requestedItem.url)',
        'official Spotify identity must be established before provider/direct resolution'
    );
    assert.match(spotify, /spotifyPlaybackMode:\s*'official-embed'/);
    assert.match(spotify, /eveOwnedPlaybackSource:\s*false/);
    assert.match(spotify, /preferEveDirectAudio:\s*false/);
    assert.doesNotMatch(spotify, /installPlaybackSourceDecorator\(resolveSpotifyPlaybackSource\)/);
});

test('YouTube bridge keeps initial normalized volume distinct from live percent commands', () => {
    assert.match(host, /const normalizedYoutubeVolume = \(value\) =>/);
    assert.match(host, /Math\.max\(0, Math\.min\(1, Number\(value\) \|\| 0\)\) \* 100/);
    assert.match(host, /const percentYoutubeVolume = \(value\) =>/);
    assert.match(host, /Math\.max\(0, Math\.min\(100, Number\(value\) \|\| 0\)\)/);
    assert.match(host, /player\.setVolume\(percentYoutubeVolume\(command\.value\)\)/);
    assert.match(host, /event\.target\.setVolume\(normalizedYoutubeVolume\(volume\)\)/);
});

test('active provider identity owns live volume routing', () => {
    assert.match(audio, /const activeUrlMatch = urlPlayback\?\.matches\?\.\(itemId\) === true/);
    assert.match(audio, /if \(activeUrlMatch\) urlPlayback\.setVolume\(safeVolume\)/);
    assert.match(audio, /layerController\.updateVolume\(itemId, safeVolume\)/);
});

test('routed PCM reads current Audioflix volume for every outgoing chunk', () => {
    assert.match(capture, /encodePcm\?\.\(chunk, 0, chunk\.length, getVolume\(\)\)/);
    assert.match(audio, /activeStreamVolume = safeVolume/);
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
