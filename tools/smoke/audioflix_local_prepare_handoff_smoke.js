'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(
    path.join(ROOT, 'js/modules/features/audioflix/audioflix.audio.local.js'),
    'utf8'
);
const anyBrowserSource = fs.readFileSync(
    path.join(ROOT, 'js/modules/features/audioflix/audioflix.spotify.any-browser.js'),
    'utf8'
);

let fileUrlCalls = 0;
const localPath = 'C:\\Audioflix\\localized.mp3';
const window = {
    EveAudioflixState: { ensure: () => ({ nativeBridgeBase: '' }) },
    EveAudioflixPaths: {
        localCandidates(item) {
            return (item?.localizations || []).map((entry) => entry.path).filter(Boolean);
        },
        isAbsoluteLocal(value) { return /^[A-Za-z]:\\/.test(String(value || '')); },
        same(left, right) { return String(left || '').toLowerCase() === String(right || '').toLowerCase(); },
        dirname(value) { return path.win32.dirname(String(value || '')); }
    },
    EveAudioflixFsPorts: {
        async fileUrlForPath(requested) {
            fileUrlCalls += 1;
            assert.equal(requested, localPath);
            return `blob:localized-${fileUrlCalls}`;
        },
        releaseFileUrl() {}
    },
    EveAudioflixNative: {
        getLocalFileUrl() { return ''; },
        async probeLocalFile() { return false; }
    }
};
window.window = window;

const context = {
    window,
    location: {
        protocol: 'file:',
        origin: 'null',
        href: 'file:///C:/EveOS/EveOS.html'
    },
    URL,
    WeakMap,
    Set,
    String,
    Promise,
    console
};
vm.createContext(context);
vm.runInContext(source, context, { filename: 'audioflix.audio.local.js' });

(async () => {
    const resolver = window.EveAudioflixLocalPlayback;
    assert.equal(resolver.ready, true);

    const item = {
        id: 'spotify-localized',
        title: 'Localized Spotify track',
        sourceProvider: 'spotify',
        url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
        localizations: [{ path: localPath }]
    };

    const first = await resolver.prepare(item);
    assert.equal(fileUrlCalls, 1, 'first validation mints exactly one readable file URL');
    assert.equal(first.localPath, localPath);
    assert.equal(first.item.url, 'blob:localized-1');

    resolver.handoffPrepared(first.item, first.localPath);
    const replay = await resolver.prepare(first.item);
    assert.equal(fileUrlCalls, 1,
        'Spotify preflight hands the validated item into normal Audioflix playback without minting a second blob');
    assert.equal(replay.localPath, localPath);
    assert.equal(replay.item.url, 'blob:localized-1');
    assert.notEqual(replay.item, first.item, 'handoff still returns the normal defensive playback copy');

    const independent = await resolver.prepare(replay.item);
    assert.equal(fileUrlCalls, 2,
        'the handoff is one-shot; a later independent playback validates and mints a fresh URL');
    assert.equal(independent.item.url, 'blob:localized-2');

    assert.match(source, /preparedLocalHandoffs = new WeakMap\(\)/);
    assert.match(source, /preparedLocalHandoffs\.delete\(item\)/);
    assert.match(anyBrowserSource, /localPlayback\?\.handoffPrepared\?\.\(localItem, prepared\.localPath\)/,
        'managed Spotify explicitly transfers the one prepared local source to the normal Audioflix pipeline');
    console.log('AUDIOFLIX_LOCAL_PREPARE_HANDOFF_SMOKE_OK');
})().catch((error) => { console.error(error); process.exit(1); });
