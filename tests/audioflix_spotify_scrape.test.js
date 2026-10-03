'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    mergePlaylistRows,
    playlistCount
} = require('../server_modules/audioflix_spotify_scrape');

const track = (position) => {
    const id = `TRACK${String(position).padStart(8, '0')}`;
    return {
        id,
        title: `Song ${position}`,
        artists: [`Artist ${position}`],
        artist: `Artist ${position}`,
        url: `https://open.spotify.com/track/${id}`
    };
};

test('playlist count is read from the Web Player header', () => {
    assert.equal(playlistCount('Private Playlist FDPlaylist DriftAi · 135 songs, about 7 hr'), 135);
});

test('full network playlist wins over an eight-row virtualized DOM window', () => {
    const network = new Map();
    const noise = {
        id: 'NOISE0000000',
        title: 'Unrelated sidebar song',
        artists: ['Noise'],
        artist: 'Noise',
        url: 'https://open.spotify.com/track/NOISE0000000'
    };
    network.set(noise.id, noise);
    for (let position = 1; position <= 135; position += 1) {
        const value = track(position);
        network.set(value.id, value);
    }

    const dom = Array.from({ length: 8 }, (_, index) => track(index + 1));
    const merged = mergePlaylistRows(dom, network, 135);

    assert.equal(merged.length, 135);
    assert.equal(merged[0].id, track(1).id);
    assert.equal(merged[134].id, track(135).id);
    assert.equal(merged.some((row) => row.id === noise.id), false);
});
