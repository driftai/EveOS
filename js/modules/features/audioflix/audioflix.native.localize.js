// Localization transport for the Audioflix native bridge: probe a served local file, download a
// track to disk (yt-dlp), create a real on-disk link for a group shortcut, and scan a folder. Split
// out of audioflix.native.js to keep that transport facade under the project line cap. Built as a
// factory so it shares the host module's request plumbing (multi-base discovery, timeouts, the
// bridge-down cooldown) instead of re-implementing it.
window.EveAudioflixNativeLocalize = window.EveAudioflixNativeLocalize || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixNativeLocalize;
    if (ns.ready) return;

    ns.create = function create(deps) {
        const fetchJson = deps.fetchJson;
        const DEVICE_SCAN_TIMEOUT_MS = deps.DEVICE_SCAN_TIMEOUT_MS;

        // Can this served local file actually be read? Asks for a single byte (Range) so the check is
        // cheap on loopback. Returns false ONLY on a definite server refusal (403 stale authorization,
        // 404 moved file) — a network hiccup returns true so we never downgrade a good local copy.
        async function probeLocalFile(servedUrl) {
            if (!servedUrl) return false;
            if (typeof deps?.isBridgeOffline === 'function' && deps.isBridgeOffline()) return false;
            try {
                const response = await fetch(servedUrl, { method: 'GET', headers: { Range: 'bytes=0-0' } });
                return response.status !== 403 && response.status !== 404;
            } catch {
                // The probe URL points at the local port server. If the request cannot complete at
                // all the server is down, so it CANNOT serve this file — reporting "fine" here is
                // what handed <audio> a dead 127.0.0.1 URL and made localized tracks play silently.
                return false;
            }
        }

        // Download one online track to a local folder (yt-dlp -> mp3, needs the server). The normal
        // endpoint stays the default. Spotify fallback has its own endpoint and is selected only when
        // the caller explicitly asks for method=spotify-fallback; a failed standard call never flips
        // itself over to that endpoint.
        async function localizeTrack(track, targetDir, options = {}) {
            if (!track?.url || !targetDir) return { ok: false, error: 'Missing track URL or target folder.' };
            const method = options.method === 'spotify-fallback' ? 'spotify-fallback' : 'standard';
            const endpoint = method === 'spotify-fallback'
                ? '/api/audioflix/localize-spotify-fallback'
                : '/api/audioflix/localize';
            return fetchJson(endpoint, {
                method: 'POST',
                body: JSON.stringify({ track, targetDir, mediaFormat: options.mediaFormat === 'video' ? 'video' : 'audio' }),
                timeout: 180000,
                probe: true
            });
        }

        // Create a real on-disk link (hard link, else symlink) to an existing track inside another
        // folder, so a 3rd-class group "shortcut" actually exists in the file system.
        async function linkLocalFile(source, targetDir, name) {
            if (!source || !targetDir) return { ok: false, error: 'Missing source or target folder.' };
            return fetchJson('/api/audioflix/localize-link', {
                method: 'POST',
                body: JSON.stringify({ source, targetDir, name: name || '' }),
                timeout: DEVICE_SCAN_TIMEOUT_MS,
                probe: true
            });
        }

        // List audio files in a folder, so localized files can be re-attached to tracks by title.
        async function scanLocalized(dir) {
            if (!dir) return { ok: false, message: 'Missing folder.' };
            return fetchJson('/api/audioflix/localize-scan', {
                method: 'POST',
                body: JSON.stringify({ dir }),
                timeout: DEVICE_SCAN_TIMEOUT_MS,
                probe: true
            });
        }

        // Read WPL XML file content from disk on server
        async function readWplFile(path) {
            const cleanPath = String(path || '').trim().replace(/^["']+|["']+$/g, '').trim();
            if (!cleanPath) return { ok: false, message: 'Missing WPL path.' };
            return fetchJson('/api/audioflix/wpl-read', {
                method: 'POST',
                body: JSON.stringify({ path: cleanPath }),
                timeout: DEVICE_SCAN_TIMEOUT_MS,
                probe: true
            });
        }

        return { probeLocalFile, localizeTrack, linkLocalFile, scanLocalized, readWplFile };
    };

    ns.ready = true;
})();
