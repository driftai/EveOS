window.EveAudioflixSpotifyStatusWatch = window.EveAudioflixSpotifyStatusWatch || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixSpotifyStatusWatch;
    if (ns.ready) return;

    const STATUS_WATCH_MS = 12000;
    const STATUS_WATCH_TIMEOUT_MS = STATUS_WATCH_MS + 4000;
    const PROGRESS_POLL_MS = 1000;

    function watchCursor(result) {
        const marker = result?.watchCursor || {};
        const engine = result?.engine || {};
        return {
            afterCursor: Math.max(0, Number(marker.eventCursor ?? engine.eventCursor ?? 0) || 0),
            afterOwnerEpoch: Math.max(0, Number(marker.ownerEpoch ?? result?.ownerEpoch ?? 0) || 0),
            afterEngineEpoch: Math.max(0, Number(marker.engineEpoch ?? result?.engineEpoch ?? 0) || 0),
            afterTrackGeneration: Math.max(0, Number(marker.trackGeneration ?? result?.trackGeneration ?? engine.generation ?? 0) || 0)
        };
    }

    function create({ remote, applyState, isActive, currentRun, isEnded }) {
        let pollTimer = 0;
        let pollFlight = null;
        let watchToken = 0;

        function stop() {
            watchToken += 1;
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = 0;
        }

        async function progressOnce(run = currentRun()) {
            if (!isActive() || pollFlight || !remote()?.snapshot?.().connected) return;
            const finish = window.EveAudioflixDiagnostics?.span?.('spotify:progress-status');
            pollFlight = remote().status();
            try {
                const result = await pollFlight;
                if (run === currentRun()) applyState(result);
                finish?.(!result?.ok);
            } catch (error) {
                finish?.(true);
                throw error;
            } finally {
                pollFlight = null;
            }
        }

        async function watchLoop(run, seed, token) {
            let cursor = watchCursor(seed);
            while (isActive() && run === currentRun() && token === watchToken && remote()?.snapshot?.().connected) {
                const finish = window.EveAudioflixDiagnostics?.span?.('spotify:status-watch');
                let result;
                try {
                    result = await remote().send('status-watch', { ...cursor, waitMs: STATUS_WATCH_MS },
                        { timeout: STATUS_WATCH_TIMEOUT_MS });
                    finish?.(!result?.ok && !result?.watchTimedOut);
                } catch (error) {
                    finish?.(true);
                    return;
                }
                if (run !== currentRun() || token !== watchToken || !isActive()) return;
                if (!result?.ok) return;
                applyState(result);
                if (isEnded() || !isActive() || result.watchSupported !== true) return;
                cursor = watchCursor(result);
            }
        }

        function start(seed) {
            stop();
            const run = currentRun();
            const token = ++watchToken;
            void watchLoop(run, seed, token).catch(() => {});
            // This timer is presentation-only. Queue completion remains owned by the server watch,
            // so hidden-tab throttling can reduce progress refreshes without delaying Ended.
            pollTimer = setInterval(() => {
                if (document.visibilityState === 'hidden') return;
                progressOnce(run).catch(() => {});
            }, PROGRESS_POLL_MS);
            if (document.visibilityState !== 'hidden') progressOnce(run).catch(() => {});
        }

        return { start, stop, progressOnce };
    }

    Object.assign(ns, { ready: true, create, watchCursor });
})();
