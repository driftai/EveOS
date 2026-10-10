'use strict';

const { engineSnapshot } = require('./audioflix_spotify_browser_transport.js');
const {
    MEDIA_SEEK_BUDGET_MS, PlaybackLeaseAbort, createPlaybackLease, leaseAbortResult
} = require('./audioflix_spotify_playback_lease.js');

// With a lease, every evaluation is bounded by the shared deadline and re-fenced to the exact
// generation/track; without one (same-URI load reset) behaviour is unchanged.
async function seekManagedMedia(options, state, seconds, lease = null) {
    const { page, isSpotifyEmbedUrl, note } = options;
    const generation = Number(state?.generation || 0);
    const id = String(state?.spotifyId || '');
    if (!generation || !id) return { reached: false };
    const bounded = work => (lease ? lease.bound(work) : work());
    for (const frame of page.frames()) {
        if (!isSpotifyEmbedUrl(frame.url()) || !new URL(frame.url()).pathname.endsWith(`/track/${id}`)) continue;
        try {
            const latest = await bounded(() => engineSnapshot(page));
            if (latest.generation !== generation || latest.spotifyId !== id) return { reached: false, superseded: true };
            const result = await bounded(() => frame.evaluate(value => window.__eveSpotifyManagedControl?.seek?.(value), seconds));
            if (result?.reached) {
                note('playback-media-seek', `${generation}: ${result.currentTime.toFixed(3)}s / ${result.duration.toFixed(3)}s`);
                return result;
            }
        } catch (error) {
            if (error instanceof PlaybackLeaseAbort) throw error;
            note('playback-media-seek-miss', error.message);
        }
    }
    return { reached: false };
}

async function handleManagedSeek(options, body) {
    const before = await engineSnapshot(options.page);
    if (before.replayPending) return { ok: false, action: 'seek', state: before,
        reason: 'Spotify replay start is not confirmed yet.' };
    const lease = createPlaybackLease({
        runtime: options.runtime || {}, page: options.page, kind: 'seek',
        generation: Number(before.generation || 0), spotifyId: String(before.spotifyId || ''),
        readState: () => engineSnapshot(options.page), budgetMs: options.seekBudgetMs ?? MEDIA_SEEK_BUDGET_MS
    });
    try {
        const mediaSeek = await seekManagedMedia(options, before, Number(body.seconds || 0), lease);
        if (!mediaSeek.reached) return { ok: false, action: 'seek', state: before,
            superseded: mediaSeek.superseded === true, lifecycle: mediaSeek.superseded ? 'superseded' : undefined,
            reason: mediaSeek.superseded ? 'Spotify playback changed before seeking.' : 'Spotify media is not ready to seek.' };
        // The acknowledgement is the completion evidence; never acknowledge for a newer generation.
        await lease.verify();
        const state = await lease.bound(() => options.page.evaluate(({ target, media }) =>
            window.EveAudioflixSpotifyEngine.acknowledgeMediaSeek({ ...target,
                currentTime: Number(media.currentTime), duration: Number(media.duration) }),
        { target: { generation: before.generation, spotifyId: before.spotifyId }, media: mediaSeek }));
        return { ok: true, action: 'seek', state, mediaSeek };
    } catch (error) {
        if (!(error instanceof PlaybackLeaseAbort)) throw error;
        options.note?.('playback-media-seek-abort', `${error.lifecycle}; generation ${before.generation}`);
        return leaseAbortResult(error, 'seek', before);
    } finally {
        lease.release();
    }
}

module.exports = { seekManagedMedia, handleManagedSeek };
