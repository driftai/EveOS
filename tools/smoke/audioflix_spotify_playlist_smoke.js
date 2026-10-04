const fs = require('fs');
const path = require('path');
const vm = require('vm');
const spotifyScraper = require('../../server_modules/audioflix_spotify_scrape.js');

const ROOT = path.resolve(__dirname, '..', '..');
const feature = (name) => path.join(ROOT, 'js', 'modules', 'features', 'audioflix', name);
const assert = (condition, message) => {
    if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
};

const store = {
    music: [],
    musicPlaylists: [],
    musicGroups: [],
    musicGroupMap: {}
};
let sequence = 0;
let playlistTitle = 'Gilded age Music';

global.window = {
    EveAudioflixNative: {
        async listSpotifyPlaylist() {
            return {
                ok: true,
                playlistId: '37i9dQZF1DX4WYpdgoIcn6',
                title: playlistTitle,
                owner: 'DriftAi',
                description: 'Imported from the saved Spotify session.',
                image: 'https://i.scdn.co/image/playlist-cover',
                scrapeSource: 'embed',
                entries: [
                    {
                        sourceId: 'spotify-a',
                        title: 'Selfish',
                        artist: 'Madison Beer',
                        album: 'Silence Between Songs',
                        image: 'https://i.scdn.co/image/a',
                        duration: 183,
                        explicit: false,
                        position: 1,
                        url: 'https://open.spotify.com/track/trackA123456'
                    },
                    {
                        sourceId: 'spotify-b',
                        title: 'Mobius',
                        artist: 'Sawano Hiroyuki',
                        album: 'Mobile Suit Gundam Hathaway',
                        image: 'https://i.scdn.co/image/b',
                        duration: 233,
                        explicit: true,
                        position: 2,
                        url: 'https://open.spotify.com/track/trackB123456'
                    }
                ]
            };
        },
        async openSpotifySession() { return { ok: true }; }
    },
    EveAudioflixState: {
        ensure: () => store,
        update(patch) { Object.assign(store, JSON.parse(JSON.stringify(patch))); },
        addMusicGroup(name) {
            if (!store.musicGroups.includes(name)) store.musicGroups.push(name);
        },
        addItem(type, item) {
            const added = { ...item, id: item.id || `music_${++sequence}`, type };
            store.music.push(added);
            return added;
        },
        updateItem(type, id, patch) {
            const item = store.music.find((entry) => entry.id === id);
            if (item) Object.assign(item, patch);
            return item;
        },
        toggleMusicGroup(id, group, enabled) {
            const current = store.musicGroupMap[id] || [];
            store.musicGroupMap[id] = enabled
                ? [...new Set(current.concat(group))]
                : current.filter((value) => value !== group);
        },
        renameGroup(type, oldName, newName) {
            store.musicGroups = store.musicGroups.map((name) => name === oldName ? newName : name);
            Object.keys(store.musicGroupMap).forEach((id) => {
                store.musicGroupMap[id] = store.musicGroupMap[id].map((name) => name === oldName ? newName : name);
            });
        },
        removeItem(type, id) {
            store.music = store.music.filter((entry) => entry.id !== id);
        }
    },
    EveAudioflixPlaylistsWpl: {
        create() {
            return {
                importWplPlaylist: async () => ({ ok: false }),
                syncWplPlaylist: async () => ({ ok: false })
            };
        }
    }
};
global.CustomEvent = class CustomEvent {};

[
    'audioflix.audio.url.providers.js',
    'audioflix.audio.url.spotify.js',
    'audioflix.playlists.providers.js',
    'audioflix.playlists.spotify.js',
    'audioflix.playlists.js'
].forEach((name) => vm.runInThisContext(fs.readFileSync(feature(name), 'utf8'), { filename: name }));

(async () => {
    assert(typeof spotifyScraper.collectDomRows === 'function', 'Spotify scraper exposes its virtual-scroll collector for regression coverage');
    let scrollPosition = 0;
    const expectedRows = 225;
    const fakePage = {
        async evaluate(fn, next) {
            const source = String(fn);
            if (source.includes("querySelectorAll(\"[data-testid^='tracklist-row']")) {
                const index = Math.min(expectedRows - 1, Math.floor(scrollPosition / 180));
                return Array.from({ length: Math.min(4, expectedRows - index) }, (_, offset) => ({
                    id: `spotify-${index + offset}`, title: `Track ${index + offset}`, artists: ['Artist'],
                    durationText: '3:00', url: `https://open.spotify.com/track/spotify-${index + offset}`
                }));
            }
            if (typeof next === 'number') {
                scrollPosition = Math.min((expectedRows - 1) * 180, scrollPosition + next);
                return undefined;
            }
            return { height: 240, maximum: (expectedRows - 1) * 180, position: scrollPosition, x: 10, y: 10 };
        },
        async waitForTimeout() {},
        mouse: { async move() {}, async wheel(_x, delta) { scrollPosition += delta; } }
    };
    const virtualRows = await spotifyScraper.collectDomRows(fakePage);
    assert(virtualRows.length === expectedRows, `Spotify virtual scroll imports beyond 100 rows (got ${virtualRows.length})`);

    const trackUrl = 'https://open.spotify.com/track/trackA123456';
    assert(window.EveAudioflixUrlProviders.providerFor(trackUrl) === 'spotify', 'Spotify track URLs use the Spotify transport');
    assert(window.EveAudioflixSpotifyPlayback.spotifyTrackId(trackUrl) === 'trackA123456', 'Spotify track IDs normalize for the iframe controller');

    const iframe = '<iframe src="https://open.spotify.com/embed/playlist/37i9dQZF1DX4WYpdgoIcn6?utm_source=generator"></iframe>';
    const normalized = window.EveAudioflixSpotify.normalizeInput(iframe);
    assert(normalized.ok, 'Spotify iframe snippets normalize');
    assert(normalized.url === 'https://open.spotify.com/playlist/37i9dQZF1DX4WYpdgoIcn6', 'canonical public URL is stored');
    assert(normalized.embedUrl.endsWith('/37i9dQZF1DX4WYpdgoIcn6'), 'canonical embed URL is retained');

    const result = await window.EveAudioflixPlaylists.importPlaylist(iframe, { folder: 'Test-Spotify' });
    assert(result.ok && result.added === 2, 'Spotify playlist imports every extracted row');
    const connection = store.musicPlaylists[0];
    assert(connection.provider === 'spotify', 'connection records the Spotify provider');
    assert(connection.group === 'Gilded age Music', 'playlist title becomes the live Audioflix group');
    assert(connection.owner === 'DriftAi' && connection.image, 'playlist metadata survives the connection');
    assert(connection.embedUrl === normalized.embedUrl, 'connection retains its editable embed source');
    assert(connection.scrapeSource === 'embed', 'connection retains the extractor provenance independently of its track URLs');
    assert(store.musicGroups.includes('Gilded age Music'), 'Spotify import creates a music group');

    const imported = store.music.find((track) => track.sourceId === 'spotify-b');
    assert(imported?.sourceProvider === 'spotify', 'track records provider provenance');
    assert(imported?.artist === 'Sawano Hiroyuki' && imported?.album, 'track artist and album are retained');
    assert(imported?.explicit === true && imported?.playlistPosition === 2, 'track detail metadata is retained');
    assert(store.musicGroupMap[imported.id]?.includes('Gilded age Music'), 'track is linked into the playlist group');
    assert(store.music.every((track) => track.folder === 'Test-Spotify'), 'every imported track uses the requested Audioflix folder');

    playlistTitle = 'Gilded age Music Updated';
    const retried = await window.EveAudioflixPlaylists.importPlaylist(iframe, { folder: 'Moved Spotify' });
    assert(retried.ok && retried.added === 0, 're-import syncs the existing playlist without duplicate tracks');
    assert(store.music.every((track) => track.folder === 'Moved Spotify'), 'retrying with a target folder moves every existing member');
    assert(store.musicPlaylists[0].group === playlistTitle, 'an automatic playlist group follows the current Spotify title');
    assert(store.music.every((track) => store.musicGroupMap[track.id]?.includes(playlistTitle)), 'sync repairs group membership for every track');

    const roundTrip = JSON.parse(JSON.stringify({
        music: store.music,
        musicPlaylists: store.musicPlaylists,
        musicGroups: store.musicGroups,
        musicGroupMap: store.musicGroupMap
    }));
    assert(roundTrip.music[1].sourceProvider === 'spotify', 'Spotify track metadata is JSON-backup safe');
    assert(roundTrip.musicPlaylists[0].owner === 'DriftAi', 'Spotify playlist metadata is JSON-backup safe');
    assert(window.EveAudioflixPlaylistProviders.detect(normalized.url) === 'spotify', 'registry detects Spotify playlist URLs');
    console.log('AUDIOFLIX_SPOTIFY_PLAYLIST_SMOKE_OK');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
