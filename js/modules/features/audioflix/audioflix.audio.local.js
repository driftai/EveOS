// Resolve an Audioflix item to its best playable source without changing the canonical record.
// Localized files always win; an online URL is retained only as a verified fallback.
window.EveAudioflixLocalPlayback = window.EveAudioflixLocalPlayback || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixLocalPlayback;
    if (ns.ready) return;

    const text = (value) => String(value ?? '').trim();

    function mediaSource(player) {
        return text(player?.getAttribute?.('src') || player?.src);
    }

    function clearMediaSource(player, preserveUrl = '') {
        if (!player) return false;
        const prior = mediaSource(player);
        try {
            if (typeof player.removeAttribute === 'function') player.removeAttribute('src');
            else player.src = '';
        } catch { player.src = ''; }
        try { player.load?.(); } catch {}
        window.EveAudioflixAudio?.getWaveformController?.()?.releasePlayer?.(player);
        if (prior && prior !== text(preserveUrl)) window.EveAudioflixFsPorts?.releaseFileUrl?.(prior);
        return !!prior;
    }

    function setMediaSource(player, url) {
        const next = text(url);
        if (!player || !next) throw new Error('Audioflix media source is unavailable.');
        if (mediaSource(player) === next) return false;
        clearMediaSource(player);
        player.src = next;
        return true;
    }

    async function prepare(item) {
        const playable = item && typeof item === 'object' ? { ...item } : {};
        const paths = window.EveAudioflixPaths;
        const originalUrl = text(playable.url);
        const browserFallback = originalUrl && !paths?.isAbsoluteLocal?.(originalUrl) ? originalUrl : '';
        const candidates = paths?.localCandidates?.(playable) || [];
        if (paths?.isAbsoluteLocal?.(originalUrl)
            && !candidates.some((candidate) => paths?.same?.(candidate, originalUrl))) {
            candidates.push(originalUrl);
        }

        for (const localPath of candidates) {
            let blobUrl = '';
            try {
                blobUrl = await window.EveAudioflixFsPorts?.fileUrlForPath?.(localPath) || '';
            } catch { /* Try the localhost bridge next. */ }
            if (blobUrl) {
                playable.url = blobUrl;
                return { item: playable, localPath, status: '' };
            }

            const native = window.EveAudioflixNative;
            const localUrl = native?.getLocalFileUrl?.(localPath) || '';
            if (!localUrl || typeof native?.probeLocalFile !== 'function') continue;
            try {
                if (await native.probeLocalFile(localUrl)) {
                    playable.url = localUrl;
                    return { item: playable, localPath, status: '' };
                }
            } catch { /* Continue through the remaining local candidates. */ }
        }

        if (candidates.length && browserFallback) {
            playable.url = browserFallback;
            return {
                item: playable,
                localPath: '',
                status: `Local copy unavailable for ${playable.title || 'track'} - streaming instead.`
            };
        }
        if (candidates.length) {
            // Name the folder and the exact control that fixes this. A browser cannot read a path
            // string on its own, so without a granted handle there is nothing to fall back to —
            // saying so vaguely just leaves the track silent with no next step.
            const dir = window.EveAudioflixPaths?.dirname?.(candidates[0]) || '';
            throw new Error(
                `Cannot reach the local copy of ${playable.title || 'this track'}`
                + (dir ? ` (${dir})` : '') + '. Open the track\'s settings panel (cog) and press '
                + '"Grant Offline Access" to let EveOS read that folder without the server.'
            );
        }
        return { item: playable, localPath: '', status: '' };
    }

    Object.assign(ns, { ready: true, prepare, setMediaSource, clearMediaSource });
})();
