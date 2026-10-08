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

function harness({ localPath = '', canonicalPatch = {} } = {}) {
    const canonical = {
        id: 'spotify-1',
        title: 'Example Song',
        artist: 'Example Artist',
        url: 'https://open.spotify.com/track/abc123',
        sourceProvider: 'spotify',
        spotifyTrackId: 'abc123',
        ...canonicalPatch
    };
    const state = { music: [canonical] };
    const updates = [];
    const requests = [];
    const window = {
        EveAudioflixNativeSpotify: {},
        EveAudioflixNative: {},
        EveAudioflixState: {
            ensure: () => state,
            updateItem(type, id, patch) { updates.push({ type, id, patch }); }
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
    const api = window.EveAudioflixNativeSpotify.create({
        async fetchJson(url, options) {
            requests.push({ url, options });
            return {
                ok: true,
                url: 'https://www.youtube.com/watch?v=alternate-recording',
                provider: 'youtube'
            };
        }
    });
    return { window, canonical, updates, requests, api };
}

test('ordinary Spotify playback preserves the official URL and never invokes alternate matching', async () => {
    const { window, canonical, updates, requests } = harness();
    let resolverCalls = 0;
    const base = await window.EveAudioflixLocalPlayback.prepare(canonical);
    const prepared = await window.EveAudioflixNativeSpotify.preparePlaybackSource(
        canonical,
        base,
        async () => { resolverCalls += 1; }
    );

    assert.equal(prepared.item.url, canonical.url);
    assert.equal(prepared.item.spotifyUrl, canonical.url);
    assert.equal(prepared.item.sourceProvider, 'spotify');
    assert.equal(prepared.item.spotifyPlaybackMode, 'official-embed');
    assert.equal(prepared.item.eveOwnedPlaybackSource, false);
    assert.equal(prepared.item.preferEveDirectAudio, false);
    assert.match(prepared.status, /official embedded player/i);
    assert.equal(resolverCalls, 0);
    assert.equal(requests.length, 0);
    assert.equal(updates.length, 0);
});

test('retired cached YouTube playback matches cannot override the Spotify embed', async () => {
    const { window, canonical, updates } = harness({
        canonicalPatch: {
            spotifyPlaybackUrl: 'https://www.youtube.com/watch?v=old-match',
            spotifyPlaybackProvider: 'youtube',
            spotifyPlaybackResolver: 'expanded-youtube-search',
            spotifyPlaybackResolverRevision: 'strict-v4-embedded-first'
        }
    });

    const prepared = await window.EveAudioflixNativeSpotify.preparePlaybackSource(
        canonical,
        await window.EveAudioflixLocalPlayback.prepare(canonical)
    );

    assert.equal(prepared.item.url, 'https://open.spotify.com/track/abc123');
    assert.notEqual(prepared.item.url, canonical.spotifyPlaybackUrl);
    assert.equal(prepared.item.spotifyPlaybackMode, 'official-embed');
    assert.equal(updates.length, 0);
});

test('old transformed items recover their Spotify identity from spotifyUrl', async () => {
    const official = 'https://open.spotify.com/track/RESTORED123';
    const { window, canonical } = harness({
        canonicalPatch: {
            url: 'https://www.youtube.com/watch?v=old-match',
            originalUrl: 'https://www.youtube.com/watch?v=old-match',
            spotifyUrl: official,
            spotifyTrackId: 'RESTORED123',
            eveOwnedPlaybackSource: true,
            preferEveDirectAudio: true
        }
    });

    const prepared = await window.EveAudioflixNativeSpotify.preparePlaybackSource(
        canonical,
        await window.EveAudioflixLocalPlayback.prepare(canonical)
    );

    assert.equal(prepared.item.url, official);
    assert.equal(prepared.item.originalUrl, official);
    assert.equal(prepared.item.eveOwnedPlaybackSource, false);
    assert.equal(prepared.item.preferEveDirectAudio, false);
});

test('localized Spotify tracks keep the user-owned file', async () => {
    const { window, canonical, requests, updates } = harness({ localPath: 'C:/Music/example.mp3' });
    const prepared = await window.EveAudioflixNativeSpotify.preparePlaybackSource(
        canonical,
        await window.EveAudioflixLocalPlayback.prepare(canonical)
    );

    assert.equal(prepared.localPath, 'C:/Music/example.mp3');
    assert.equal(prepared.item.url, 'blob:localized-track');
    assert.equal(requests.length, 0);
    assert.equal(updates.length, 0);
});

test('non-Spotify items pass through unchanged', async () => {
    const { window } = harness();
    const item = { id: 'direct-1', url: 'https://cdn.example/song.mp3', sourceProvider: 'direct' };
    const base = { item: { ...item }, localPath: '', status: '' };
    const prepared = await window.EveAudioflixNativeSpotify.preparePlaybackSource(item, base);

    assert.equal(prepared, base);
});

test('alternate recording lookup remains explicit and is never installed into LocalPlayback', async () => {
    const { window, canonical, api, requests } = harness();

    assert.equal(window.EveAudioflixNativeSpotify.installPlaybackSourceDecorator(), false);
    assert.equal(window.EveAudioflixLocalPlayback.__eveSpotifyPlaybackSourceWrapped, undefined);
    assert.equal(requests.length, 0);

    const result = await api.resolveSpotifyPlaybackSource(canonical);
    assert.equal(result.provider, 'youtube');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/audioflix/spotify-session');
    assert.equal(JSON.parse(requests[0].options.body).action, 'resolve-playback-source');
});
