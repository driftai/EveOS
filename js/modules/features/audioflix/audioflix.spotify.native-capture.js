window.EveAudioflixSpotifyNativeCapture = window.EveAudioflixSpotifyNativeCapture || {};
(function (ns) {
    'use strict';
    if (ns.ready) return;
    let boundRun = 0;
    let hooks = {};

    function configure(next = {}) { hooks = { ...hooks, ...next }; }
    function status() {
        return window.EveAudioflixProviderCaptureUi?.managedCaptureStatus?.()
            || window.EveAudioflixProviderCapture?.getStatus?.() || {};
    }
    function requireCapture(policy) {
        if (policy?.outputKind !== 'native') return false;
        const outputId = String(policy.outputId || '');
        if (!outputId.startsWith('sd:')) throw new Error('Managed Spotify needs an exact native output endpoint.');
        const capture = status();
        if (capture.active !== true || capture.source !== 'managed-spotify' || capture.endpoint !== outputId) {
            throw new Error('Show the Spotify Engine, then arm “Capture Engine to Native Output” before Play.');
        }
        return true;
    }
    function bind(run, required) { boundRun = required ? Number(run || 0) : 0; }
    function clear() { boundRun = 0; }
    function guard(result, run, item) {
        if (!boundRun || boundRun !== run) return true;
        const capture = result?.managed?.capture || {};
        const policy = hooks.resolvePolicy?.(item || {}) || {};
        if (capture.active === true && capture.source === 'managed-spotify' && capture.endpoint === policy.outputId) return true;
        clear();
        hooks.onLost?.();
        hooks.remote?.()?.send?.('pause', {}, { timeout: 5000 }).then((paused) => {
            if (paused?.ok) hooks.applyState?.(paused);
        }).catch(() => {});
        return false;
    }

    Object.assign(ns, { ready: true, configure, require: requireCapture, bind, clear, guard, status });
})(window.EveAudioflixSpotifyNativeCapture);
