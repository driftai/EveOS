'use strict';

const crypto = require('node:crypto');

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const durationSeconds = (value) => {
    const parts = clean(value).split(':').map(Number);
    if (parts.some(Number.isNaN)) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
};
const trackId = (value) => clean(value).match(/(?:spotify:track:|\/track\/)([A-Za-z0-9]{10,})/)?.[1] || '';
const playlistIdFromUrl = (value) => clean(value).match(/playlist\/([A-Za-z0-9]+)/)?.[1] || '';
const matchKey = (value) => clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const stableId = (row, position) => trackId(row.url || row.uri)
    || crypto.createHash('sha1').update(`${row.title}|${row.artist}|${position}`).digest('hex').slice(0, 22);

const playlistCount = (value) => {
    const text = clean(value);
    const summary = text.match(/\b([\d,]+)\s+(?:songs?|tracks?)\s*,?\s*(?:about\s+)?(?:(?:\d+\s*(?:hr|hrs|hours?))(?:\s+\d+\s*(?:min|mins|minutes?))?|(?:\d+\s*(?:min|mins|minutes?)))\b/i);
    if (!summary) return 0;
    const count = Number(summary[1].replace(/,/g, ''));
    return Number.isFinite(count) && count > 0 ? count : 0;
};
const isEmbedPlaylistUrl = (value) => /open\.spotify\.com\/embed\/playlist\//i.test(clean(value));
const fullPlaylistUrl = (value) => {
    const id = playlistIdFromUrl(value);
    return id ? `https://open.spotify.com/playlist/${id}` : clean(value);
};
const needsFullPlayerPromotion = (value, expectedCount = 0, capturedCount = 0) => (
    isEmbedPlaylistUrl(value)
    && (Number(expectedCount) > 100 || (!Number(expectedCount) && Number(capturedCount) >= 100))
);
const assessPlaylistCompleteness = (expectedCount = 0, capturedCount = 0) => {
    const expected = Math.max(0, Number(expectedCount) || 0);
    const captured = Math.max(0, Number(capturedCount) || 0);
    if (!expected || captured >= expected) {
        return { ok: true, expectedCount: expected, capturedCount: captured, unexposedCount: 0 };
    }
    const shortfall = expected - captured;
    const tolerance = Math.min(3, Math.max(1, Math.ceil(expected * 0.02)));
    const singleUnavailable = captured > 0 && shortfall === 1;
    const nearComplete = captured > 0 && captured / expected >= 0.97 && shortfall <= tolerance;
    const acceptable = singleUnavailable || nearComplete;
    return {
        ok: acceptable,
        expectedCount: expected,
        capturedCount: captured,
        unexposedCount: acceptable ? shortfall : 0,
        shortfall
    };
};
const shouldPromoteEmbedAfterScan = (value, expectedCount = 0, capturedCount = 0) => {
    if (!isEmbedPlaylistUrl(value)) return false;
    const captured = Math.max(0, Number(capturedCount) || 0);
    if (!captured) return true;
    if (needsFullPlayerPromotion(value, expectedCount, captured)) return true;
    const expected = Math.max(0, Number(expectedCount) || 0);
    return expected > 0 && !assessPlaylistCompleteness(expected, captured).ok;
};

function requestMentionsPlaylist(url = '', postData = '', playlistId = '') {
    if (!playlistId) return false;
    const values = [url, postData].map((value) => {
        const raw = String(value || '');
        try { return `${raw}\n${decodeURIComponent(raw)}`; } catch { return raw; }
    });
    const haystack = values.join('\n');
    return haystack.includes(playlistId)
        || haystack.includes(`spotify:playlist:${playlistId}`)
        || haystack.includes(`/playlist/${playlistId}`);
}

function mergeTrack(base = {}, overlay = {}) {
    base = base && typeof base === 'object' ? base : {};
    overlay = overlay && typeof overlay === 'object' ? overlay : {};
    const artists = overlay.artists?.length ? overlay.artists : (base.artists || []);
    const durationMs = Number(overlay.durationMs || base.durationMs || 0);
    const id = overlay.id || base.id || trackId(overlay.url || base.url);
    return {
        id,
        title: clean(overlay.title || overlay.name || base.title || base.name || 'Unknown track'),
        artists: [...new Set(artists.map(clean).filter(Boolean))],
        artist: clean(artists.join(', ')),
        album: clean(overlay.album || base.album),
        image: clean(overlay.image || base.image),
        duration: durationMs > 0 ? durationMs / 1000 : durationSeconds(overlay.durationText || base.durationText),
        explicit: Boolean(overlay.explicit || base.explicit),
        url: clean(overlay.url || overlay.spotifyUrl || base.url || base.spotifyUrl || (id ? `https://open.spotify.com/track/${id}` : ''))
    };
}

function rowIdentity(row = {}) {
    const id = clean(row.id) || trackId(row.url || row.uri);
    if (id) return `id:${id}`;
    const title = matchKey(row.title || row.name);
    const artist = matchKey(row.artist || row.artists?.join(' '));
    return title ? `meta:${title}|${artist}` : '';
}

function mergePlaylistRows(domRows = [], networkTracks = new Map(), expectedCount = 0) {
    const networkRows = networkTracks instanceof Map ? [...networkTracks.values()] : [...(networkTracks || [])];
    if (!domRows.length) return expectedCount ? networkRows.slice(0, expectedCount) : networkRows;
    const domHasTrackUrls = domRows.some((row) => Boolean(trackId(row?.url || row?.uri)));
    if (!domHasTrackUrls && networkRows.length) {
        const firstDomTitle = matchKey(domRows[0]?.title || domRows[0]?.name);
        const titleAnchor = firstDomTitle
            ? networkRows.findIndex((row) => matchKey(row?.title || row?.name) === firstDomTitle)
            : -1;
        if (titleAnchor >= 0) {
            const available = networkRows.slice(titleAnchor);
            const limit = expectedCount ? Math.min(expectedCount, available.length) : Math.min(domRows.length, available.length);
            const positional = available.slice(0, limit).map((networkRow, index) => {
                const domRow = domRows[index];
                const titlesMatch = domRow && matchKey(domRow.title || domRow.name) === matchKey(networkRow.title || networkRow.name);
                return titlesMatch ? mergeTrack(networkRow, domRow) : networkRow;
            });
            if (positional.length) return positional;
        }
    }
    const networkByIdentity = new Map(networkRows.map((row) => [rowIdentity(row), row]).filter(([key]) => key));
    const enrichedDom = domRows.map((row) => mergeTrack(networkByIdentity.get(rowIdentity(row)), row));
    const firstIdentity = rowIdentity(enrichedDom[0]);
    const anchor = firstIdentity ? networkRows.findIndex((row) => rowIdentity(row) === firstIdentity) : -1;
    if (expectedCount > enrichedDom.length && anchor >= 0 && networkRows.length - anchor >= expectedCount) {
        const domByIdentity = new Map(enrichedDom.map((row) => [rowIdentity(row), row]).filter(([key]) => key));
        return networkRows.slice(anchor, anchor + expectedCount)
            .map((row) => mergeTrack(row, domByIdentity.get(rowIdentity(row))));
    }
    const merged = [...enrichedDom];
    const seen = new Set(merged.map(rowIdentity).filter(Boolean));
    if (anchor >= 0) {
        for (const row of networkRows.slice(anchor)) {
            const key = rowIdentity(row);
            if (!key || seen.has(key)) continue;
            merged.push(row); seen.add(key);
            if (expectedCount && merged.length >= expectedCount) break;
        }
    }
    return merged;
}

function scanValue(value, tracks, depth = 0, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || depth > 14 || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
        value.forEach((entry) => scanValue(entry, tracks, depth + 1, seen));
        return;
    }
    const candidates = [
        value.uri, value.trackUri, value.spotifyUri, value.external_urls?.spotify,
        value.externalUrls?.spotify, value.spotifyUrl, value.url, value.href
    ];
    let id = candidates.map(trackId).find(Boolean) || '';
    if (!id && typeof value.id === 'string' && /^(track|Track|TRACK)$/.test(value.type || value.__typename || value.contentType || '')) id = value.id;
    if (id) {
        const rawArtists = value.artists?.items || value.artists?.nodes || value.artists || value.artist || value.performers || [];
        const artists = (Array.isArray(rawArtists) ? rawArtists : [rawArtists])
            .map((entry) => entry?.node || entry?.profile || entry)
            .map((entry) => typeof entry === 'string' ? entry : entry?.name || entry?.title)
            .filter(Boolean);
        if (!artists.length && typeof value.subtitle === 'string') {
            value.subtitle.split(',').map(clean).filter(Boolean).forEach((artist) => artists.push(artist));
        }
        const imageSources = value.album?.images || value.albumOfTrack?.coverArt?.sources || value.images || [];
        const image = (Array.isArray(imageSources) ? imageSources : [imageSources])
            .map((entry) => entry?.url || entry?.src).find(Boolean) || '';
        const row = mergeTrack(tracks.get(id), {
            id,
            title: value.name || value.title || value.trackName,
            artists,
            album: value.album?.name || value.albumOfTrack?.name || value.albumName,
            image,
            durationMs: value.duration_ms || value.durationMs || value.duration?.totalMilliseconds,
            explicit: value.explicit || value.contentRating?.label === 'EXPLICIT',
            url: `https://open.spotify.com/track/${id}`
        });
        tracks.set(id, row);
    }
    Object.values(value).forEach((child) => scanValue(child, tracks, depth + 1, seen));
}

module.exports = {
    clean, trackId, playlistIdFromUrl, stableId, playlistCount, isEmbedPlaylistUrl, fullPlaylistUrl,
    needsFullPlayerPromotion, assessPlaylistCompleteness, shouldPromoteEmbedAfterScan,
    requestMentionsPlaylist, mergeTrack, mergePlaylistRows, scanValue
};
