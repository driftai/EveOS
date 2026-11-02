window.EveAudioflixProviderLayers = window.EveAudioflixProviderLayers || {};
(function (ns) {
    'use strict';
    if (ns.ready) return;

    const text = value => String(value || '').trim();
    function capability(item) {
        const provider = window.EveAudioflixUrlProviders?.providerFor?.(item?.url) || '';
        const policy = window.EveAudioflixPlaybackPolicy?.policyOf?.(item) || item?._effectivePlaybackPolicy || {};
        if (!['spotify', 'youtube'].includes(provider)) return { handled: false, supported: false, provider };
        if (provider === 'spotify' && item?.spotifyPlaybackMode === 'managed-engine') {
            return { handled: true, supported: false, provider,
                reason: 'Managed Spotify owns one Engine session. Select Official embed or localize this track for independent Layer Play.' };
        }
        if (text(policy.outputId)) {
            return { handled: true, supported: false, provider,
                reason: `Independent ${provider} layers cannot follow the selected ${policy.outputLabel || 'custom output'}. Localize the track or use ordinary Play.` };
        }
        return { handled: true, supported: true, provider };
    }

    function reportUnsupported(result, item) {
        const status = result?.reason || `${result?.provider || 'Provider'} Layer Play is unavailable for this route.`;
        window.dispatchEvent?.(new CustomEvent('eve:audioflix-playback', {
            detail: { status, item, error: true, layer: true, provider: result?.provider || '' }
        }));
        return false;
    }

    async function start(item, hooks = {}) {
        const result = capability(item);
        if (!result.handled) return result;
        if (!result.supported) {
            if (hooks.canUseShared?.() === false) return { ...result, played: reportUnsupported(result, item) };
            const played = await hooks.playShared?.();
            if (hooks.cancelled?.()) { await hooks.cancelShared?.(); return { ...result, handled: true, played: false }; }
            return { ...result, handled: true, played: Boolean(played) };
        }
        let current = 0, duration = Number(item?.duration) || 0, paused = true, finished = false;
        let controller = window.EveAudioflixUrlPlayback?.createController?.({
            independentLayer: true,
            onPlayback(detail = {}) {
                const status = text(detail.status).toLowerCase();
                paused = status !== 'playing' && !status.startsWith('playing ');
                if (detail.error) {
                    void Promise.resolve(controller?.destroy?.()).catch(() => {});
                    hooks.onError?.(new Error(detail.status || 'Provider layer failed.'));
                }
                if (!finished && status === 'ended') { finished = true; hooks.onEnded?.(); }
            },
            onProgress(detail = {}) {
                current = Math.max(0, Number(detail.currentTime) || 0);
                duration = Math.max(0, Number(detail.duration) || duration);
                paused = detail.paused !== false;
                hooks.onProgress?.({ currentTime: current, duration, paused });
            }
        });
        if (!controller) throw new Error('Independent provider playback is not loaded.');
        try { await controller.play({ ...item, showProviderTransport: false }, { internalView: false }); }
        catch (error) { await Promise.resolve(controller.destroy?.()).catch(() => {}); throw error; }
        const player = {
            get currentTime() { return current; }, get duration() { return duration; }, get paused() { return paused; },
            get volume() { return Number(item?.volume ?? 1); },
            set volume(value) { item.volume = value; controller.setVolume?.(value, { persist: false }); },
            play() { paused = false; return controller.resume?.(); },
            pause() { paused = true; return controller.pause?.(); }
        };
        const handle = { ...result, player,
            stop: () => controller.destroy?.(),
            setVolume: value => controller.setVolume?.(value, { persist: false }) };
        if (hooks.cancelled?.()) { await handle.stop?.(); return { ...handle, handled: true, played: false }; }
        hooks.onStart?.(handle);
        return { ...handle, handled: true, played: true };
    }

    Object.assign(ns, { ready: true, capability, reportUnsupported, start });
})(window.EveAudioflixProviderLayers);
