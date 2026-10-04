'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    mergePlaylistRows,
    playlistCount,
    requestMentionsPlaylist,
    needsFullPlayerPromotion,
    assessPlaylistCompleteness,
    shouldPromoteEmbedAfterScan
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

test('playlist count ignores unrelated song totals elsewhere in the Web Player', () => {
    const pageText = [
        'Your Library',
        'Liked Songs',
        '3,367 songs',
        'FDPlaylist',
        'DriftAi · 135 songs, about 7 hr'
    ].join(' ');
    assert.equal(playlistCount(pageText), 135);
});

test('playlist-scoped network detection requires the requested playlist id', () => {
    const playlistId = '0g3Wc7zGTmqRcG7G79fQ5H';
    assert.equal(
        requestMentionsPlaylist(
            'https://api-partner.spotify.com/pathfinder/v1/query',
            JSON.stringify({ variables: { uri: `spotify:playlist:${playlistId}` } }),
            playlistId
        ),
        true
    );
    assert.equal(
        requestMentionsPlaylist(
            'https://api-partner.spotify.com/pathfinder/v1/query',
            JSON.stringify({ variables: { uri: 'spotify:playlist:UNRELATED12345' } }),
            playlistId
        ),
        false
    );
});

test('embed extraction promotes only playlists beyond its reliable 100-row surface', () => {
    const embed = 'https://open.spotify.com/embed/playlist/0g3Wc7zGTmqRcG7G79fQ5H';
    assert.equal(needsFullPlayerPromotion(embed, 99, 99), false);
    assert.equal(needsFullPlayerPromotion(embed, 100, 100), false);
    assert.equal(needsFullPlayerPromotion(embed, 135, 8), true);
    assert.equal(needsFullPlayerPromotion(embed, 0, 100), true, 'an unknown count at the cap is ambiguous');
    assert.equal(needsFullPlayerPromotion('https://open.spotify.com/playlist/0g3Wc7zGTmqRcG7G79fQ5H', 135, 8), false);
});

test('small private embed with a playlist header but zero rows promotes to the saved session', () => {
    const embed = 'https://open.spotify.com/embed/playlist/5cLjZEw99fbjUcLHfMgkOL';
    assert.equal(shouldPromoteEmbedAfterScan(embed, 18, 0), true);
    assert.equal(shouldPromoteEmbedAfterScan(embed, 18, 18), false);
    assert.equal(shouldPromoteEmbedAfterScan(embed, 18, 8), true);
    assert.equal(
        shouldPromoteEmbedAfterScan('https://open.spotify.com/playlist/5cLjZEw99fbjUcLHfMgkOL', 18, 0),
        false,
        'a full saved-session page cannot be promoted again'
    );
});

test('near-complete scans tolerate only a tiny unavailable Spotify row gap', () => {
    const oneUnavailable = assessPlaylistCompleteness(135, 134);
    assert.equal(oneUnavailable.ok, true);
    assert.equal(oneUnavailable.unexposedCount, 1);

    const threeUnavailable = assessPlaylistCompleteness(135, 132);
    assert.equal(threeUnavailable.ok, true);
    assert.equal(threeUnavailable.unexposedCount, 3);

    assert.equal(assessPlaylistCompleteness(135, 131).ok, false, 'four missing rows is too large to trust');
    assert.equal(assessPlaylistCompleteness(135, 8).ok, false, 'the old virtualized 8/135 truncation must still fail');
    assert.equal(assessPlaylistCompleteness(68, 66).ok, true, 'a two-row unavailable gap remains near-complete');
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
