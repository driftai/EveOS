window.EveAudioflixUrlPlayback = window.EveAudioflixUrlPlayback || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixUrlPlayback;
    if (ns.ready) return;
    const SCRIPT_TIMEOUT_MS = 12000;
    const YOUTUBE_FILE_MESSAGE = 'YouTube requires an HTTPS/app identity that a plain file:// page cannot send. Use Play on YouTube, replace this track URL with a direct media URL, cache a local copy, or start EveOS localhost to play it inside Audioflix.';
    const { loadScript, loadYouTubeApi } = window.EveAudioflixUrlLoaders;
    const { providerFor, youtubeId, shouldPreferBrowser } = window.EveAudioflixUrlProviders;
    function itemKey(item) {
        return String(item?.id || item?.url || '');
    }
    function routedOutputNote() {
        const s = window.EveAudioflixState?.ensure?.() || {};
        return (s.preferredSinkId || (s.nativeBridgeEnabled === true && s.nativeOutputId))
            ? ' Note: provider players cannot follow the routed output, so this audio uses the system default device.' : '';
    }
    function createController(options = {}) {
        let active = null;
        let timer = 0;
        let requestedInternalView = false;
        let playbackRate = 1;
        const playback = { item: null, currentTime: 0, duration: 0, paused: true, provider: '' };
        const view = window.EveAudioflixInternalPlayer?.createController?.({
            onClose: () => hideInternalView(),
            onToggle: () => playback.paused ? resume() : pause(),
            onSeek: (value) => seek(value),
            onVolume: (value) => setVolume(value),
            onRate: (value) => setRate(value),
            onStep: (delta) => options.onStep?.(delta),
            onJump: (index) => options.onJump?.(index)
        });
        const emitPlayback = (status, error = false) => options.onPlayback?.({
            status, item: playback.item, provider: playback.provider, browserOnly: true, error
        });
        const emitProgress = () => {
            view?.sync?.(playback);
            options.onProgress?.({ ...playback, browserOnly: true });
        };
        function ensureStage(item, provider, visual = true) {
            if (!view) throw new Error('Audioflix internal player is unavailable. Reload EveOS and try again.');
            const host = view.open(item, provider, {
                expanded: requestedInternalView,
                visible: requestedInternalView
            });
            view.setVisualVisible(visual);
            host.replaceChildren();
            return host;
        }
        function setStageStatus(message, isError = false) {
            view?.setStatus?.(message, isError);
        }
        function clearTimer() {
            if (timer) clearInterval(timer);
            timer = 0;
        }
        function resetPlayback(item, provider) {
            Object.assign(playback, { item, currentTime: 0, duration: Number(item.resolvedDuration || 0) || 0, paused: true, provider });
        }
        async function stop(options = {}) {
            clearTimer();
            const session = active;
            active = null;
            window.EveAudioflixAudio?.getMusicCapture?.()?.stop?.();
            try {
                if (session?.kind === 'direct') { session.player.pause(); session.player.removeAttribute('src'); session.player.load(); }
                else if (session?.kind === 'youtube') session.player.destroy?.();
                else if (session?.kind === 'soundcloud') session.player.pause?.();
                else if (['vimeo', 'spotify', 'instagram'].includes(session?.kind)) await session.player.destroy?.();
            } catch { }
            playback.paused = true;
            emitProgress();
            if (options?.closeView || !requestedInternalView) {
                requestedInternalView = false;
                view?.hide?.();
            }
        }
        async function playDirect(item) {
            if (requestedInternalView) {
                ensureStage(item, 'Direct audio', false);
                setStageStatus('Playing this linked audio inside EveOS.');
            }
            const player = new Audio();
            // Only tag the element for CORS when we are actually going to tap it into Web Audio
            // (the native capture route needs an untainted element). Setting it unconditionally
            // makes any host that does not send Access-Control-Allow-Origin refuse to load at
            // all, so ordinary direct links silently stopped playing in the browser-only case.
            // It has to be decided BEFORE src — assigning it afterwards does nothing until the
            // resource is reloaded.
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
            player.playbackRate = playbackRate;   // carry the chosen speed across queue tracks
            player.src = item.url;
            // Follow the routed output (picked sink or matched native endpoint) so linked music
            // shares the soundboard's control layer; resolvePlaybackSink covers both cases.
            let routedLabel = '';
            // capture.start() declines when the bridge device will not open. Ignoring that return
            // left us claiming "native route" for a stream nobody was listening to, and skipped
            // the sink selection that would have made it audible.
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
            active = { kind: 'direct', player };
            if (waveformSafe) options.onPlayer?.(player);
            const update = () => {
                playback.currentTime = Number(player.currentTime || 0) || 0;
                playback.duration = Number.isFinite(player.duration) ? player.duration : playback.duration;
                playback.paused = player.paused;
                emitProgress();
            };
            player.addEventListener('timeupdate', update);
            player.addEventListener('durationchange', update);
            player.addEventListener('play', () => { update(); emitPlayback(`Playing ${item.title || 'linked audio'} directly from the browser${routedLabel ? ` -> ${routedLabel}` : ''}`); });
            player.addEventListener('pause', () => { update(); emitPlayback('Paused'); });
            player.addEventListener('ended', () => {
                update();
                if (capturing) window.EveAudioflixAudio?.getMusicCapture?.()?.stop?.({ drain: true });
                emitPlayback('Ended');
            });
            player.addEventListener('error', async () => {
                if (!item._retriedDirect && item.rawAudioUrl) {
                    try {
                        item._retriedDirect = true;
                        if (requestedInternalView) setStageStatus('Proxy blocked — attempting direct stream playback...');
                        player.src = item.rawAudioUrl;
                        player.load();
                        await player.play();
                        return;
                    } catch {}
                }
                if (!item._retried && window.EveAudioflixNative?.resolveUrl && item.originalUrl) {
                    try {
                        item._retried = true;
                        if (requestedInternalView) setStageStatus('Stream expired — re-resolving fresh YouTube audio link...');
                        const resolved = await window.EveAudioflixNative.resolveUrl(item.originalUrl, true);
                        if (resolved && resolved.ok && resolved.audioUrl) {
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
        }

        async function playYouTube(item) {
            const id = youtubeId(item.url);
            if (!id) throw new Error('This YouTube URL does not contain a playable video ID.');
            if (location.protocol === 'file:') {
                ensureStage(item, 'YouTube');
                setStageStatus('Connecting through the EveOS localhost provider host...');
                const bridge = await view.connectYouTubeBridge(item, id, {
                    expanded: requestedInternalView,
                    visible: requestedInternalView,
                    onReady(detail) {
                        playback.duration = Number(detail.duration) || 0;
                        setStageStatus('Playing with YouTube inside EveOS.' + routedOutputNote());
                        emitProgress();
                    },
                    onProgress(detail) {
                        playback.currentTime = Number(detail.currentTime) || 0;
                        playback.duration = Number(detail.duration || playback.duration) || 0;
                        emitProgress();
                    },
                    onState(state) {
                        playback.paused = state !== 'playing';
                        if (state === 'playing') emitPlayback(`Playing ${item.title || 'YouTube audio'} with YouTube`);
                        else if (state === 'paused') emitPlayback('Paused');
                        else if (state === 'ended') emitPlayback('Ended');
                        emitProgress();
                    },
                    onError(error) {
                        playback.paused = true;
                        setStageStatus(error.message, true);
                        emitPlayback(error.message, true);
                        emitProgress();
                    }
                });
                if (!bridge) {
                    if (window.EveAudioflixNative?.resolveUrl) {
                        try {
                            setStageStatus('Resolving direct YouTube audio stream via EveOS bridge...');
                            const resolved = await window.EveAudioflixNative.resolveUrl(item.url, true);
                            if (resolved && resolved.ok && resolved.audioUrl) {
                                const proxyUrl = /^https?:\/\//i.test(resolved.audioUrl) ? (window.EveAudioflixNative?.getProxyUrl?.(resolved.audioUrl) || resolved.audioUrl) : resolved.audioUrl;
                                setStageStatus(`Playing stream — "${resolved.title || item.title}"`);
                                return await playDirect({ ...item, url: proxyUrl, rawAudioUrl: resolved.audioUrl, originalUrl: item.url, resolvedDuration: resolved.duration });
                            }
                        } catch {}
                    }
                    playback.paused = true;
                    setStageStatus(YOUTUBE_FILE_MESSAGE, true);
                    emitPlayback(YOUTUBE_FILE_MESSAGE, true);
                    emitProgress();
                    const error = new Error(YOUTUBE_FILE_MESSAGE);
                    error.eveReported = true;
                    throw error;
                }
                active = { kind: 'youtube', player: bridge };
                return;
            }
            const host = ensureStage(item, 'YouTube');
            await loadYouTubeApi();
            await new Promise((resolve, reject) => {
                let settled = false;
                const finish = (error) => {
                    if (settled) return;
                    settled = true;
                    error ? reject(error) : resolve();
                };
                const playerVars = { autoplay: 1, controls: 1, playsinline: 1, rel: 0 };
                if (/^https?:$/.test(location.protocol)) playerVars.origin = location.origin;
                const player = new window.YT.Player(host, {
                    width: 480,
                    height: 270,
                    videoId: id,
                    playerVars,
                    events: {
                        onReady(event) {
                            active = { kind: 'youtube', player: event.target };
                            event.target.setVolume(Math.round(Math.max(0, Math.min(1, Number(item.volume ?? 1))) * 100));
                            event.target.playVideo();
                            playback.duration = Number(event.target.getDuration?.() || 0) || 0;
                            setStageStatus('Playing with YouTube\'s browser player.' + routedOutputNote());
                            finish();
                        },
                        onStateChange(event) {
                            const states = window.YT.PlayerState || {};
                            playback.paused = event.data !== states.PLAYING;
                            if (event.data === states.PLAYING) emitPlayback(`Playing ${item.title || 'YouTube audio'} with YouTube`);
                            if (event.data === states.PAUSED) emitPlayback('Paused');
                            if (event.data === states.ENDED) emitPlayback('Ended');
                            emitProgress();
                        },
                        onError(event) {
                            const message = event.data === 153
                                ? YOUTUBE_FILE_MESSAGE
                                : `YouTube could not play this link (error ${event.data}).`;
                            clearTimer();
                            try { event.target?.destroy?.(); } catch { }
                            active = null;
                            playback.paused = true;
                            setStageStatus(message, true);
                            emitPlayback(message, true);
                            emitProgress();
                            const error = new Error(message);
                            error.eveReported = true;
                            finish(error);
                        }
                    }
                });
                active = { kind: 'youtube', player };
            });
            clearTimer();
            timer = setInterval(() => {
                if (active?.kind !== 'youtube') return;
                playback.currentTime = Number(active.player.getCurrentTime?.() || 0) || 0;
                playback.duration = Number(active.player.getDuration?.() || playback.duration) || 0;
                emitProgress();
            }, 250);
        }

        const { playSoundCloud, playVimeo } = window.EveAudioflixUrlWidgets.create({
            ensureStage, setStageStatus, emitPlayback, emitProgress, loadScript, SCRIPT_TIMEOUT_MS,
            view: {
                get active() { return active; }, set active(v) { active = v; },
                get playback() { return playback; }
            }
        });
        const providerView = { get active() { return active; }, set active(v) { active = v; }, get playback() { return playback; } };
        const providerDeps = { ensureStage, setStageStatus, emitPlayback, emitProgress, view: providerView };
        const spotifyAdapter = window.EveAudioflixSpotifyPlayback?.create?.(providerDeps);
        const instagramAdapter = window.EveAudioflixInstagramPlayback?.create?.({ ...providerDeps, isInternalView: () => requestedInternalView });
        const playSpotify = spotifyAdapter?.playSpotify || (async () => { throw new Error('Spotify playback support is not loaded yet.'); });
        const playInstagram = instagramAdapter?.playInstagram || (async () => { throw new Error('Instagram playback support is not loaded yet.'); });

        async function play(item, playOptions = {}) {
            const provider = providerFor(item?.url);
            if (!provider) throw new Error('This URL cannot be played directly by the browser.');
            requestedInternalView = playOptions.internalView === true;
            if (active && itemKey(playback.item) === itemKey(item)) {
                if (requestedInternalView && provider === 'direct') {
                    ensureStage(item, 'Direct audio', false);
                    setStageStatus('Playing this linked audio inside EveOS.');
                } else if (requestedInternalView) view?.setExpanded?.(true);
                else if (provider !== 'direct') view?.setTransportOnly?.(true);
                else view?.hide?.();
                if (playback.paused) await resume();
                return true;
            }
            // Reuse the proven protected-media session for Spotify queue transitions. Recreating
            // the iframe can lose its playback grant and leave a Spotify->Spotify queue stalled.
            if (active?.kind === 'spotify' && provider === 'spotify' && active.player?.loadItem) {
                resetPlayback(item, provider);
                if (requestedInternalView) view?.setExpanded?.(true); else view?.setTransportOnly?.(true);
                await active.player.loadItem(item);
                return true;
            }
            await stop();
            resetPlayback(item, provider);
            try {
                if (provider === 'youtube') await playYouTube(item);
                else if (provider === 'spotify') await playSpotify(item);
                else if (provider === 'instagram') await playInstagram(item);
                else if (provider === 'soundcloud') await playSoundCloud(item);
                else if (provider === 'vimeo') await playVimeo(item);
                else await playDirect(item);
                return true;
            } catch (error) {
                clearTimer();
                const session = active;
                active = null;
                try {
                    if (session?.kind === 'direct') session.player.pause?.();
                    else if (session?.kind === 'youtube') session.player.destroy?.();
                    else if (session?.kind === 'soundcloud') session.player.pause?.();
                    else if (['vimeo', 'spotify', 'instagram'].includes(session?.kind)) await session.player.destroy?.();
                } catch { }
                playback.paused = true;
                emitProgress();
                if (provider === 'direct') {
                    const originalError = error;
                    error = new Error('This URL did not expose browser-playable audio. Use a direct media URL (such as MP3, M4A, OGG, WAV, or WebM), cache the track locally, or start EveOS localhost to resolve the page.');
                    error.cause = originalError;
                }
                if (!error?.eveReported) {
                    const message = error?.message || 'The linked track could not be played in this browser.';
                    if (provider !== 'direct' || requestedInternalView) setStageStatus(message, true);
                    emitPlayback(message, true);
                }
                throw error;
            }
        }
        async function resume() {
            if (!active) return false;
            if (active.kind === 'direct') await active.player.play();
            else if (active.kind === 'youtube') active.player.playVideo?.();
            else if (active.kind === 'soundcloud') active.player.play?.();
            else if (['vimeo', 'spotify', 'instagram'].includes(active.kind)) await active.player.play?.();
            playback.paused = false;
            emitProgress();
            return true;
        }
        async function pause() {
            if (!active) return false;
            if (active.kind === 'direct') active.player.pause();
            else if (active.kind === 'youtube') active.player.pauseVideo?.();
            else if (active.kind === 'soundcloud') active.player.pause?.();
            else if (['vimeo', 'spotify', 'instagram'].includes(active.kind)) await active.player.pause?.();
            playback.paused = true;
            emitPlayback('Paused');
            emitProgress();
            return true;
        }
        async function seek(seconds) {
            if (!active) return false;
            const target = Math.max(0, Math.min(Number(seconds || 0), playback.duration || Infinity));
            if (active.kind === 'direct') active.player.currentTime = target;
            else if (active.kind === 'youtube') active.player.seekTo?.(target, true);
            else if (active.kind === 'soundcloud') active.player.seekTo?.(target * 1000);
            else if (['vimeo', 'spotify', 'instagram'].includes(active.kind)) await active.player.setCurrentTime?.(target);
            playback.currentTime = target;
            emitProgress();
            return true;
        }
        function setVolume(volume) {
            if (!active) return;
            const safe = Math.max(0, Math.min(1, Number(volume || 0)));
            if (active.kind === 'direct') active.player.volume = safe;
            else if (active.kind === 'youtube' || active.kind === 'soundcloud') active.player.setVolume?.(Math.round(safe * 100));
            else if (['vimeo', 'spotify', 'instagram'].includes(active.kind)) active.player.setVolume?.(safe)?.catch?.(() => {});
            // Both views must agree: only the card slider persisted, so panel levels never stuck.
            if (playback.item) playback.item.volume = safe;
            if (playback.item?.id) window.EveAudioflixState?.setItemVolume?.(playback.item.type || 'music', playback.item.id, safe);
            view?.setVolume?.(safe);
        }
        // Playback speed. Providers exposing a rate control get it; SoundCloud's widget API has
        // none, so it is left alone rather than silently pretending.
        function setRate(rate) {
            const safe = Math.max(0.25, Math.min(4, Number(rate) || 1));
            playbackRate = safe;
            view?.setRate?.(safe);
            if (!active) return;
            if (active.kind === 'direct') active.player.playbackRate = safe;
            // Vimeo's returns a promise, YouTube's returns undefined; ?.catch covers both.
            else if (active.kind === 'youtube' || active.kind === 'vimeo') active.player.setPlaybackRate?.(safe)?.catch?.(() => {});
        }
        function hideInternalView() {
            requestedInternalView = false;
            if (active && active.kind !== 'direct') view?.setTransportOnly?.(true);
            else view?.hide?.();
            return true;
        }

        return {
            play, openInternalView: (item) => play(item, { internalView: true }), pause, seek, stop, setVolume,
            setRate, getRate: () => playbackRate,
            isInternalViewOpen: () => requestedInternalView && view?.isOpen?.() === true,
            hideInternalView,
            closeInternalView: hideInternalView,
            setQueue: (entries, index) => view?.setQueue?.(entries, index),
            canHandle: (item) => !!providerFor(item?.url),
            shouldPreferBrowser,
            isActive: () => !!active,
            getAudioElement: () => active?.kind === 'direct' ? active.player : null,
            matches: (itemOrId) => typeof itemOrId === 'object'
                ? itemKey(playback.item) === itemKey(itemOrId)
                : String(playback.item?.id || '') === String(itemOrId || ''),
            getPlaybackState: () => ({ ...playback, browserOnly: true })
        };
    }

    Object.assign(ns, { ready: true, providerFor, youtubeId, createController });
})();
