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

function verifiedSource() {
    return {
        ok: true,
        url: 'https://www.youtube.com/watch?v=verified-recording',
        provider: 'youtube',
        title: 'Example Artist - Example Song',
        resolver: 'spotify-fallback-strict-v2'
    };
}

test('Spotify identity resolves once then reuses the cached EveOS playback source', async () => {
    const { window, canonical, updates } = harness();
    let resolves = 0;
    const resolve = async () => {
        resolves += 1;
        return verifiedSource();
    };

    assert.equal(window.EveAudioflixNativeSpotify.installPlaybackSourceDecorator(resolve), true);
    const first = await window.EveAudioflixLocalPlayback.prepare(canonical);
    const second = await window.EveAudioflixLocalPlayback.prepare(canonical);

    assert.equal(first.item.url, 'https://www.youtube.com/watch?v=verified-recording');
    assert.equal(first.item.spotifyUrl, canonical.url);
    assert.equal(first.item.sourceProvider, 'spotify');
    assert.equal(first.item.spotifyPlaybackProvider, 'youtube');
    assert.equal(first.item.eveOwnedPlaybackSource, true);
    assert.equal(first.item.preferEveDirectAudio, true);
    assert.equal(second.item.url, first.item.url);
    assert.equal(resolves, 1, 'cached playback source must not require the resolver server again');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].type, 'music');
    assert.equal(updates[0].patch.spotifyPlaybackUrl, first.item.url);
});

test('explicit playback-boundary preparation does not depend on LocalPlayback decoration', async () => {
    const { window, canonical, updates } = harness();
    let resolves = 0;
    const basePrepared = await window.EveAudioflixLocalPlayback.prepare(canonical);

    const prepared = await window.EveAudioflixNativeSpotify.preparePlaybackSource(
        canonical,
        basePrepared,
        async () => {
            resolves += 1;
            return verifiedSource();
        }
    );

    assert.equal(prepared.item.url, 'https://www.youtube.com/watch?v=verified-recording');
    assert.equal(prepared.item.spotifyUrl, canonical.url);
    assert.equal(prepared.item.eveOwnedPlaybackSource, true);
    assert.equal(prepared.item.preferEveDirectAudio, true);
    assert.equal(resolves, 1);
    assert.equal(updates.length, 1);
});

test('explicit playback preparation is idempotent after the verified source is persisted', async () => {
    const { window, canonical } = harness();
    let resolves = 0;
    const resolve = async () => {
        resolves += 1;
        return verifiedSource();
    };

    const first = await window.EveAudioflixNativeSpotify.preparePlaybackSource(
        canonical,
        await window.EveAudioflixLocalPlayback.prepare(canonical),
        resolve
    );
    const second = await window.EveAudioflixNativeSpotify.preparePlaybackSource(
        canonical,
        await window.EveAudioflixLocalPlayback.prepare(canonical),
        resolve
    );

    assert.equal(first.item.url, second.item.url);
    assert.equal(second.item.eveOwnedPlaybackSource, true);
    assert.equal(resolves, 1, 'persisted playback URL must bypass repeat matching');
});

test('localized Spotify tracks keep the local source and never invoke online matching', async () => {
    const { window, canonical, updates } = harness({ localPath: 'C:/Music/example.mp3' });
    let resolves = 0;
    const basePrepared = await window.EveAudioflixLocalPlayback.prepare(canonical);
    const prepared = await window.EveAudioflixNativeSpotify.preparePlaybackSource(
        canonical,
        basePrepared,
        async () => {
            resolves += 1;
            return { ok: true, url: 'https://www.youtube.com/watch?v=should-not-run' };
        }
    );

    assert.equal(prepared.localPath, 'C:/Music/example.mp3');
    assert.equal(prepared.item.url, 'blob:localized-track');
    assert.equal(resolves, 0);
    assert.equal(updates.length, 0);
});
