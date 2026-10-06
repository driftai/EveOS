'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'modules', 'features', 'audioflix', 'audioflix.native.spotify.js'),
    'utf8'
);

function harness({ localPath = '' } = {}) {
    const canonical = {
        id: 'spotify-1',
        title: 'Example Song',
        artist: 'Example Artist',
        url: 'https://open.spotify.com/track/abc123',
        sourceProvider: 'spotify',
        spotifyTrackId: 'abc123'
    };
    const state = { music: [canonical] };
    const updates = [];
    const window = {
        EveAudioflixNativeSpotify: {},
        EveAudioflixState: {
            ensure: () => state,
            updateItem(type, id, patch) {
                updates.push({ type, id, patch });
                const item = state.music.find((entry) => String(entry.id) === String(id));
                if (item) Object.assign(item, patch);
            }
        },
        EveAudioflixLocalPlayback: {
            async prepare(item) {
                return {
                    item: localPath ? { ...item, url: 'blob:localized-track' } : { ...item },
                    localPath,
                    status: ''
                };
            }
        }
    };
    vm.runInNewContext(SOURCE, { window });
    return { window, canonical, updates };
}

test('Spotify identity resolves once then reuses the cached EveOS playback source', async () => {
    const { window, canonical, updates } = harness();
    let resolves = 0;
    const resolve = async () => {
        resolves += 1;
        return {
            ok: true,
            url: 'https://www.youtube.com/watch?v=verified-recording',
            provider: 'youtube',
            title: 'Example Artist - Example Song',
            resolver: 'spotify-fallback-strict-v2'
        };
    };

    assert.equal(window.EveAudioflixNativeSpotify.installPlaybackSourceDecorator(resolve), true);
    const first = await window.EveAudioflixLocalPlayback.prepare(canonical);
    const second = await window.EveAudioflixLocalPlayback.prepare(canonical);

    assert.equal(first.item.url, 'https://www.youtube.com/watch?v=verified-recording');
    assert.equal(first.item.spotifyUrl, canonical.url);
    assert.equal(first.item.sourceProvider, 'spotify');
    assert.equal(first.item.spotifyPlaybackProvider, 'youtube');
    assert.equal(second.item.url, first.item.url);
    assert.equal(resolves, 1, 'cached playback source must not require the resolver server again');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].type, 'music');
    assert.equal(updates[0].patch.spotifyPlaybackUrl, first.item.url);
});

test('localized Spotify tracks keep the local source and never invoke online matching', async () => {
    const { window, canonical, updates } = harness({ localPath: 'C:/Music/example.mp3' });
    let resolves = 0;
    window.EveAudioflixNativeSpotify.installPlaybackSourceDecorator(async () => {
        resolves += 1;
        return { ok: true, url: 'https://www.youtube.com/watch?v=should-not-run' };
    });

    const prepared = await window.EveAudioflixLocalPlayback.prepare(canonical);

    assert.equal(prepared.localPath, 'C:/Music/example.mp3');
    assert.equal(prepared.item.url, 'blob:localized-track');
    assert.equal(resolves, 0);
    assert.equal(updates.length, 0);
});
