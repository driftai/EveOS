window.EveAudioflixSpotifyPlaybackLifecycle = window.EveAudioflixSpotifyPlaybackLifecycle || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixSpotifyPlaybackLifecycle;
    if (ns.ready) return;

    // A disconnected/degraded relay is ambiguous. Only an explicit client release intent
    // retires local playback; reconnect/status recovery never creates a new Play intent.
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
                onRecovery: ({ state }) => {
                    if (state === 'degraded' && isActive()) onDegraded();
                    notify();
                }
            }) || null;
            return observer;
        }

        return { ensureObserver };
    }

    Object.assign(ns, { ready: true, create });
})();
