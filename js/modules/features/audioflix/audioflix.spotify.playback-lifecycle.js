window.EveAudioflixSpotifyPlaybackLifecycle = window.EveAudioflixSpotifyPlaybackLifecycle || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixSpotifyPlaybackLifecycle;
    if (ns.ready) return;

    // A disconnected/degraded relay is ambiguous. Only an explicit client release intent or
    // fresh identity-verified helper reset retires local playback. Recovery never creates Play.
    function create({ remote, isActive, isStarting, applyState, currentRun,
        onRelease = () => {}, onDegraded = () => {}, notify = () => {} }) {
        let observer = null;
        remote()?.subscribe?.((detail) => {
            if (detail?.released === true && (isActive() || isStarting())) onRelease();
        });

        function ensureObserver() {
            if (observer) return observer;
            observer = window.EveAudioflixSpotifyStatusWatch?.create?.({
                remote, applyState, isActive, currentRun,
                onRecovery: ({ state, result }) => {
                    if (state === 'reset' && isActive()) onRelease(result);
                    else if (state === 'degraded' && isActive()) onDegraded();
                    notify();
                }
            }) || null;
            return observer;
        }

        return { ensureObserver };
    }

    Object.assign(ns, { ready: true, create });
})();
