window.EveAudioflixUrlDirect = window.EveAudioflixUrlDirect || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixUrlDirect;
    if (ns.ready) return;
    function create(deps) {
        const { playback, ensureStage, setStageStatus, emitPlayback, emitProgress } = deps;
        return async function playDirect(item) {
            if (deps.internalView()) {
                ensureStage(item, 'Direct audio', false);
                setStageStatus('Playing this linked audio inside EveOS.');
            }
            const player = new Audio();
            // CORS mode must be decided before assigning src.
            const nativeMusic = window.EveAudioflixNative?.shouldSuppressBrowserPlayback?.() === true;
            let waveformSafe = /^(?:blob:|data:audio\/)/i.test(item.url);
            try {
                const parsed = new URL(item.url, location.href);
                waveformSafe = waveformSafe
                    || parsed.origin === location.origin
                    || ['localhost', '127.0.0.1'].includes(parsed.hostname);
            } catch {}
            waveformSafe = waveformSafe || nativeMusic;
            if (waveformSafe && /^https?:\/\//i.test(item.url)) player.crossOrigin = 'anonymous';
            player._eveAudioflixWaveformSafe = waveformSafe;
            player.preload = 'auto';
            player.volume = Math.max(0, Math.min(1, Number(item.volume ?? 1)));
            player.playbackRate = deps.rate();   // carry the chosen speed across queue tracks
            window.EveAudioflixLocalPlayback?.setMediaSource?.(player, item.url) || (player.src = item.url);
            let routedLabel = '';
            let capturing = false;
            if (nativeMusic) {
                const capture = window.EveAudioflixAudio?.getMusicCapture?.();
                capturing = capture ? (await capture.start(player)) === true : false;
                if (capturing) routedLabel = window.EveAudioflixState?.ensure?.()?.nativeOutputLabel || 'native route';
            }
            if (!capturing) {
                try {
                    const routed = typeof player.setSinkId === 'function' && await window.EveAudioflixAudio?.resolvePlaybackSink?.();
                    if (routed?.deviceId) { await player.setSinkId(routed.deviceId); routedLabel = routed.label || ''; }
                } catch { }
            }
            const session = { kind: 'direct', player };
            deps.activate(session);
            if (waveformSafe) deps.onPlayer?.(player);
            const update = () => {
                playback.currentTime = Number(player.currentTime || 0) || 0;
                playback.duration = Number.isFinite(player.duration) ? player.duration : playback.duration;
                playback.paused = player.paused;
                emitProgress();
            };
            player.addEventListener('timeupdate', update);
            player.addEventListener('durationchange', update);
            player.addEventListener('play', () => { if (deps.active() !== session) return; update(); emitPlayback(`Playing ${item.title || 'linked audio'} directly from the browser${routedLabel ? ` -> ${routedLabel}` : ''}`); });
            player.addEventListener('pause', () => { update(); emitPlayback('Paused'); });
            player.addEventListener('ended', () => {
                // A replaced transport must never report Ended for the track that superseded it.
                if (deps.active() !== session) { window.EveAudioflixLocalPlayback?.clearMediaSource?.(player); return; }
                update();
                // Same contract as the local player: the queue completion owner waits on `settle`
                // so the next track cannot flush or overlap the drained native-capture tail.
                const settle = capturing
                    ? Promise.resolve(window.EveAudioflixAudio?.getMusicCapture?.()?.stop?.({ drain: true })).catch(() => false)
                    : undefined;
                emitPlayback('Ended', false, { item, settle });
                window.EveAudioflixLocalPlayback?.clearMediaSource?.(player);
            });
            player.addEventListener('error', async () => {
                if (!item._retriedDirect && item.rawAudioUrl) {
                    try {
                        item._retriedDirect = true;
                        if (deps.internalView()) setStageStatus('Proxy blocked — attempting direct stream playback...');
                        player.src = item.rawAudioUrl;
                        player.load();
                        await player.play();
                        return;
                    } catch {}
                }
                if (!item._retried && window.EveAudioflixNative?.resolveUrl && item.originalUrl) {
                    try {
                        item._retried = true;
                        if (deps.internalView()) setStageStatus('Stream expired — re-resolving fresh YouTube audio link...');
                        const resolved = await window.EveAudioflixNative.resolveUrl(item.originalUrl, true);
                        if (deps.active() === session && resolved && resolved.ok && resolved.audioUrl) {
                            const freshProxy = window.EveAudioflixNative?.getProxyUrl?.(resolved.audioUrl) || resolved.audioUrl;
                            item.rawAudioUrl = resolved.audioUrl;
                            player.src = freshProxy;
                            player.load();
                            await player.play();
                            return;
                        }
                    } catch {}
                }
                update();
                emitPlayback('Linked audio failed to load', true);
            });
            await player.play();
        };
    }
    Object.assign(ns, { ready: true, create });
})();
