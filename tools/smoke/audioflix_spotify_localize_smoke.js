const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const run = (ctx, name) => vm.runInNewContext(
    fs.readFileSync(path.join(ROOT, 'js', 'modules', 'features', 'audioflix', name), 'utf8'),
    ctx,
    { filename: name }
);
const assert = (condition, message) => {
    if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
};

(async () => {
    const stored = {
        music: [{
            id: 'spotify-owned',
            title: 'Mobius',
            artist: 'Sawano Hiroyuki',
            url: 'https://open.spotify.com/track/spotifyOwned123',
            sourceProvider: 'spotify',
            folder: 'Spotify Imports'
        }]
    };
    const stores = { eveAudioflixFallbackState: JSON.stringify(stored) };
    const downloaded = [];
    const native = {
        localizeTrack: async (track) => {
            downloaded.push(track.id);
            return { ok: false, error: 'Spotify must not reach this method.' };
        },
        scanLocalized: async (dir) => ({
            ok: true,
            dir,
            files: [{
                name: 'Mobius - Sawano Hiroyuki',
                fileName: 'Mobius - Sawano Hiroyuki.mp3',
                path: `${dir}/Mobius - Sawano Hiroyuki.mp3`,
                ext: 'mp3'
            }]
        })
    };
    const ctx = {
        console, Date, JSON, Math, Object, Array, String, Number, Boolean, Set, Map, Promise,
        RegExp, queueMicrotask, setTimeout, clearTimeout, config: {},
        localStorage: {
            getItem: (key) => stores[key] ?? null,
            setItem: (key, value) => { stores[key] = String(value); },
            removeItem: (key) => { delete stores[key]; }
        },
        CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init?.detail; },
        window: { dispatchEvent() {}, addEventListener() {}, EveAudioflixNative: native }
    };
    Object.assign(ctx.window, {
        window: ctx.window,
        localStorage: ctx.localStorage,
        CustomEvent: ctx.CustomEvent,
        setTimeout,
        clearTimeout
    });
    [
        'audioflix.paths.js',
        'audioflix.state.schema.js',
        'audioflix.state.recovery.js',
        'audioflix.state.groups.js',
        'audioflix.state.js',
        'audioflix.nexus.js',
        'audioflix.classifiers.js',
        'audioflix.localize.audit.js',
        'audioflix.localize.port.js',
        'audioflix.localize.js'
    ].forEach((name) => run(ctx, name));

    const result = await ctx.window.EveAudioflixLocalize.localizeScope(
        'folder',
        'Spotify Imports',
        'D:/OwnedSpotify',
        () => {}
    );
    const track = ctx.window.EveAudioflixState.ensure().music[0];
    assert(result.ok && result.done === 0 && result.total === 0, 'owned-file match completes without a download');
    assert(downloaded.length === 0, 'a track whose file is already owned never downloads');
    assert(track.localPath === 'D:/OwnedSpotify/Mobius - Sawano Hiroyuki.mp3', 'owned local file was attached');
    assert(
        track.localizations.some((entry) => entry.source === 'folder:Spotify Imports'),
        'local file retains folder ownership metadata'
    );

    // With NO owned file on disk, the Spotify track must reach the server. The server resolves the
    // link to the YouTube video holding the same recording and downloads that; Spotify's own
    // (Widevine-encrypted) audio is still never touched. This used to be blocked client-side, which
    // made that whole server capability unreachable from the UI.
    const unmatched = { ok: true, dir: 'D:/NoOwnedFiles', files: [] };
    ctx.window.EveAudioflixNative = {
        scanLocalized: async () => unmatched,
        localizeTrack: async (t, dir) => {
            downloaded.push(t.id);
            assert(/open\.spotify\.com\//i.test(t.url), 'the Spotify url is handed to the server as-is');
            return { ok: true, filePath: `${dir}/King.mp3`, ext: 'mp3', duration: 238 };
        }
    };
    ctx.window.EveAudioflixState.update({
        music: [{
            id: 'spotify-unowned',
            title: 'King',
            artist: 'Lauren Aquilina',
            url: 'https://open.spotify.com/track/0zhzkkSXFj60Y5fzb2j9hU',
            sourceProvider: 'spotify',
            folder: 'Spotify Imports'
        }]
    }, 'smoke-reset');

    const viaYoutube = await ctx.window.EveAudioflixLocalize.localizeScope(
        'folder', 'Spotify Imports', 'D:/NoOwnedFiles', () => {}
    );
    const localized = ctx.window.EveAudioflixState.ensure().music[0];
    assert(downloaded.includes('spotify-unowned'), 'an unowned Spotify track reaches the localizer');
    assert(viaYoutube.ok && viaYoutube.done === 1,
        `the localization is reported as done (got ${JSON.stringify(viaYoutube)})`);
    assert(localized.localPath === 'D:/NoOwnedFiles/King.mp3', 'the downloaded file is attached to the track');

    const fallbackCalls = [];
    ctx.window.EveAudioflixNative = {
        scanLocalized: async (dir) => ({ ok: true, dir, files: [] }),
        localizeTrack: async (track, dir, options) => {
            fallbackCalls.push({ id: track.id, method: options?.method });
            return { ok: true, filePath: `${dir}/${track.id}.mp3`, resolver: 'expanded-youtube-search', matchedUrl: 'https://youtube.com/watch?v=matched' };
        }
    };
    ctx.window.EveAudioflixUiForms = { create: () => () => {} };
    ctx.window.EveAudioflixUiActionsLocalize = { create: () => async () => false };
    ctx.window.EveAudioflixUiLocalize = { create: () => ({ renderLocalizeForm: () => '<form></form>', renderSongLocalizations: () => '' }) };
    ctx.window.EveAudioflixState.update({
        music: [
            { id: 'spotify-fallback', title: 'Fallback', url: 'https://open.spotify.com/track/fallback123456', sourceProvider: 'spotify', folder: 'Mixed' },
            { id: 'youtube-standard', title: 'Other', url: 'https://youtube.com/watch?v=other', sourceProvider: 'youtube', folder: 'Mixed' }
        ]
    }, 'fallback-scope-reset');
    run(ctx, 'audioflix.spotify.fallback.js');
    const fallback = await ctx.window.EveAudioflixLocalize.localizeScope(
        'folder', 'Mixed', 'D:/Fallback', () => {}, false, 'link', 'audio', 'spotify-fallback'
    );
    assert(fallback.ok && fallback.done === 1, 'explicit fallback localizes the eligible Spotify track');
    assert(fallbackCalls.length === 1 && fallbackCalls[0].id === 'spotify-fallback'
        && fallbackCalls[0].method === 'spotify-fallback',
    'scope-wide Spotify fallback never downloads non-Spotify tracks from a mixed scope');
    console.log('AUDIOFLIX_SPOTIFY_LOCALIZE_SMOKE_OK');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
