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
        return true;
    }
    async function ensure(policy, item = null) {
        if (!requireCapture(policy)) return false;
        const outputId = String(policy.outputId || '');
        const current = status();
        if (current.active === true && current.source === 'managed-spotify' && current.endpoint === outputId) return true;
        const R = hooks.remote?.();
        if (!R?.ready) throw new Error('Managed Spotify relay is unavailable.');
        const connection = await R.connect?.();
        if (!connection?.connected && !R.snapshot?.().connected) {
            throw new Error(connection?.reason || 'Managed Spotify relay is unavailable.');
        }
        const ownership = await R.send('take-control', {}, { timeout: 15000 });
        if (!ownership?.ok || ownership?.isOwner !== true) {
            throw new Error(ownership?.reason || 'Could not take control of the managed Spotify engine.');
        }
        const result = await R.send('engine-capture-start', {
            deviceId: outputId,
            label: String(policy.outputLabel || outputId),
            itemId: String(item?.id || '')
        }, { timeout: 45000 });
        const capture = result?.captureResult?.capture || result?.managed?.capture || result?.captureResult || {};
        if (!result?.ok || capture.active !== true || capture.source !== 'managed-spotify' || capture.endpoint !== outputId) {
            throw new Error(result?.reason || result?.captureResult?.reason || 'Managed Spotify PCM capture did not become active.');
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

    Object.assign(ns, { ready: true, configure, require: requireCapture, ensure, bind, clear, guard, status });
})(window.EveAudioflixSpotifyNativeCapture);
