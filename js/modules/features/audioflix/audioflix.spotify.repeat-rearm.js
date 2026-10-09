window.EveAudioflixSpotifyRepeatRearm = window.EveAudioflixSpotifyRepeatRearm || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixSpotifyRepeatRearm;
    if (ns.ready) return;

    const POLL_SETTLE_MS = 1200;
    const POLL_INTERVAL_MS = 40;
    let installed = false;

    const managed = () => window.EveAudioflixSpotifyAnyBrowser;
    const remote = () => window.EveAudioflixSpotifyRemote;

    async function waitForClientRearm(timeoutMs = POLL_SETTLE_MS) {
        const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
        while (Date.now() < deadline) {
            const snapshot = managed()?.snapshot?.() || {};
            if (snapshot.active !== true || snapshot.ended !== true) return true;
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
        return false;
    }

    function install() {
        if (installed) return true;
        const audio = window.EveAudioflixAudio;
        if (!audio?.ready || typeof audio.seek !== 'function' || !managed()?.ready || !remote()?.ready) return false;

        const originalSeek = audio.seek.bind(audio);
        audio.seek = async function managedSpotifyRepeatAwareSeek(seconds) {
            const target = Math.max(0, Number(seconds || 0));
            const snapshot = managed()?.snapshot?.() || {};
            const relay = remote()?.snapshot?.() || {};

            // The Audioflix queue owns repeat-one. Its existing natural-end path restarts the
            // current queue entry by seeking to 0 before replaying it. Managed Spotify keeps an
            // Ended marker durable until playback actually restarts, so a plain seek can leave the
            // client in Ended and make the next queue completion disappear. Re-arm the existing
            // Spotify transport only for that exact ended->0 transition; normal seeks stay normal.
            if (target <= 0.05 && snapshot.active === true && snapshot.ended === true && relay.connected === true) {
                const result = await remote().send('restart', {}, { timeout: 12000 });
                if (!result?.ok) throw new Error(result?.reason || 'Spotify could not restart the completed track.');

                // The any-browser client polls the same engine and clears its durable Ended flag
                // when it observes Playing. Give that ordinary path one poll window. If the poll is
                // delayed, one normal seek/status round trip applies the live engine state locally.
                if (await waitForClientRearm()) return true;
                return originalSeek(0);
            }
            return originalSeek(seconds);
        };
        audio.seek.__eveSpotifyRepeatRearm = true;
        installed = true;
        return true;
    }

    Object.assign(ns, { ready: true, install, waitForClientRearm });
    if (!install()) window.addEventListener('load', install, { once: true });
})();
