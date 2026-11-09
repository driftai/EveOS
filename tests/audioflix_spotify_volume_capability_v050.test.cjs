'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..',
    'js/modules/features/audioflix/audioflix.spotify.volume.js'), 'utf8');
let embedded = true;
const env = { window: {
    addEventListener(){},
    EveAudioflixSpotifyEdge: {snapshot: () => ({active: embedded})},
    EveAudioflixAudio: {getPlaybackState: () => ({active: true,provider:'spotify',edgeEmbed: embedded,
       item: {id:'song',type:'music',sourceProvider:'spotify',volume:.6}})},
    EveAudioflixSpotifyRemote: {snapshot: () => ({connected: false})}
}};
vm.runInNewContext(source, env);
const spotify = env.window.EveAudioflixSpotifyVolume;

test('active Official Embed exposes native-volume capability', () => {
    assert.equal(spotify.snapshot().directControl, true);
    assert.equal(spotify.snapshot().status, 'official-embed-native');
});
test('inactive Official Embed cannot advertise native control', () => {
    embedded = false;
    assert.equal(spotify.snapshot().directControl, false);
    assert.notEqual(spotify.snapshot().status, 'official-embed-native');
});
test('remote managed control remains supported independently', () => {
    env.window.EveAudioflixSpotifyRemote.snapshot = () => ({connected: true});
    assert.equal(spotify.snapshot().directControl, true);
    assert.equal(spotify.snapshot().status, 'managed-ready');
});
