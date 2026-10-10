'use strict';

// Playback evidence for the managed Spotify helper. Strong confirmation means current media
// is actually playing; a provider Pause button alone is only a hint, never proof.
const { engineSnapshot } = require('./audioflix_spotify_browser_transport.js');

const PLAY_KICK_NEAR_START_MAX_S = 2;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function providerPauseButtonShowsPlaying(page, isSpotifyEmbedUrl) {
    if (!page || page.isClosed()) return false;
    for (const frame of page.frames()) {
        if (!isSpotifyEmbedUrl(frame.url())) continue;
        const button = frame.locator('[data-testid="play-pause-button"]').first();
        try {
            if (!await button.count()) continue;
            const aria = String(await button.getAttribute('aria-label') || '').trim();
            const title = String(await button.getAttribute('title') || '').trim();
            if (/\bpause\b/i.test(`${aria} ${title}`)) return true;
        } catch {}
    }
    return false;
}

async function playbackObservation(page, spotifySnapshots, isSpotifyEmbedUrl) {
    let transport = null;
    try { transport = await engineSnapshot(page); } catch {}
    const snapshots = await spotifySnapshots(null, transport?.spotifyId || '');
    const mediaObserved = snapshots.some(item => Array.isArray(item.media));
    const playingCount = mediaObserved
        ? snapshots.flatMap(item => item.media || []).filter(media => !media.paused && !media.ended && media.readyState >= 2).length
        : snapshots.reduce((sum, item) => sum + Number(item.playingCount || 0), 0);
    const providerShowsPlaying = await providerPauseButtonShowsPlaying(page, isSpotifyEmbedUrl);
    return {
        playing: transport?.status === 'playing' || playingCount > 0 || providerShowsPlaying,
        transport: transport || {},
        playingCount, mediaObserved,
        providerShowsPlaying
    };
}

function isConfirmedPlaybackObservation(observed) {
    return Number(observed?.playingCount || 0) > 0
        || (observed?.mediaObserved !== true && String(observed?.transport?.status || '') === 'playing');
}

function confirmedForGeneration(observed, generation) {
    return isConfirmedPlaybackObservation(observed)
        && (!Number(generation) || Number(observed?.transport?.generation) === Number(generation));
}

// Lease-aware polling: with a lease, each poll is bounded by the shared deadline and a
// cancellation (Stop, Pause, supersession, page reset) ends the wait instead of polling on.
async function pollObservation(page, spotifySnapshots, isSpotifyEmbedUrl, timeoutMs, done, lease = null) {
    const observe = () => (lease
        ? lease.bound(() => playbackObservation(page, spotifySnapshots, isSpotifyEmbedUrl))
        : playbackObservation(page, spotifySnapshots, isSpotifyEmbedUrl));
    const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
    let observed = await observe();
    while (!done(observed) && Date.now() < deadline) {
        if (lease) await lease.sleep(Math.min(120, deadline - Date.now()));
        else await delay(120);
        observed = await observe();
    }
    return observed;
}

function waitForPlaying(page, spotifySnapshots, isSpotifyEmbedUrl, timeoutMs, lease = null) {
    return pollObservation(page, spotifySnapshots, isSpotifyEmbedUrl, timeoutMs, value => value.playing, lease);
}

function waitForConfirmedPlaying(page, spotifySnapshots, isSpotifyEmbedUrl, timeoutMs, lease = null) {
    return pollObservation(page, spotifySnapshots, isSpotifyEmbedUrl, timeoutMs, isConfirmedPlaybackObservation, lease);
}

module.exports = {
    PLAY_KICK_NEAR_START_MAX_S, delay, providerPauseButtonShowsPlaying, playbackObservation,
    isConfirmedPlaybackObservation, confirmedForGeneration, waitForPlaying, waitForConfirmedPlaying
};
