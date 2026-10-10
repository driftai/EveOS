'use strict';

const { engineSnapshot } = require('./audioflix_spotify_browser_transport.js');

async function seekManagedMedia(options, state, seconds) {
    const { page, isSpotifyEmbedUrl, note } = options;
    const generation = Number(state?.generation || 0);
    const id = String(state?.spotifyId || '');
    if (!generation || !id) return { reached: false };
    for (const frame of page.frames()) {
        if (!isSpotifyEmbedUrl(frame.url()) || !new URL(frame.url()).pathname.endsWith(`/track/${id}`)) continue;
        try {
            const latest = await engineSnapshot(page);
            if (latest.generation !== generation || latest.spotifyId !== id) return { reached: false, superseded: true };
            const result = await frame.evaluate(value => window.__eveSpotifyManagedControl?.seek?.(value), seconds);
            if (result?.reached) {
                note('playback-media-seek', `${generation}: ${result.currentTime.toFixed(3)}s / ${result.duration.toFixed(3)}s`);
                return result;
            }
        } catch (error) { note('playback-media-seek-miss', error.message); }
    }
    return { reached: false };
}

module.exports = { seekManagedMedia };

async function handleManagedSeek(options, body) {
    const before = await engineSnapshot(options.page);
    if (before.replayPending) return { ok: false, action: 'seek', state: before,
        reason: 'Spotify replay start is not confirmed yet.' };
    const mediaSeek = await seekManagedMedia(options, before, Number(body.seconds || 0));
    if (!mediaSeek.reached) return { ok: false, action: 'seek', state: before,
        reason: mediaSeek.superseded ? 'Spotify playback changed before seeking.' : 'Spotify media is not ready to seek.' };
    const state = await options.page.evaluate(({ target, media }) =>
        window.EveAudioflixSpotifyEngine.acknowledgeMediaSeek({ ...target,
            currentTime: Number(media.currentTime), duration: Number(media.duration) }),
    { target: { generation: before.generation, spotifyId: before.spotifyId }, media: mediaSeek });
    return { ok: true, action: 'seek', state, mediaSeek };
}

module.exports.handleManagedSeek = handleManagedSeek;
