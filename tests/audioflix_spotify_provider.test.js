'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

function loadProvider() {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'js', 'modules', 'features', 'audioflix', 'audioflix.playlists.spotify.js'),
        'utf8'
    );
    const window = {
        EveAudioflixSpotify: {},
        EveAudioflixPlaylistProviders: { register() {} }
    };
    vm.runInNewContext(source, { window, URL });
    return window.EveAudioflixSpotify;
}

test('Spotify provider preserves private-share query parameters', () => {
    const provider = loadProvider();
    const result = provider.normalizeInput(
        'https://open.spotify.com/playlist/5cLjZEw99fbjUcLHfMgkOL?si=share-context&pt=private-access-token'
    );

    assert.equal(result.ok, true);
    assert.equal(result.playlistId, '5cLjZEw99fbjUcLHfMgkOL');
    assert.match(result.url, /\?si=share-context&pt=private-access-token$/);
    assert.match(result.embedUrl, /\?si=share-context&pt=private-access-token$/);
});

test('Spotify provider preserves private-share token from iframe snippets', () => {
    const provider = loadProvider();
    const result = provider.normalizeInput(
        '<iframe src="https://open.spotify.com/embed/playlist/5cLjZEw99fbjUcLHfMgkOL?si=abc&amp;pt=secret-share"></iframe>'
    );

    assert.equal(result.ok, true);
    assert.equal(
        result.url,
        'https://open.spotify.com/playlist/5cLjZEw99fbjUcLHfMgkOL?si=abc&pt=secret-share'
    );
});

test('Spotify provider keeps ordinary public playlist URLs canonical', () => {
    const provider = loadProvider();
    const result = provider.normalizeInput(
        'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'
    );

    assert.equal(result.ok, true);
    assert.equal(result.url, 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
    assert.equal(result.embedUrl, 'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M');
});
