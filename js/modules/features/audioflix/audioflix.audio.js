window.EveAudioflixAudio = window.EveAudioflixAudio || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixAudio;
    if (ns.ready) return;

    let audio = null;
    let waveformController = null;
    let currentItem = null;
    let lastStatus = 'Idle';
    let activeNativeController = null;
    let activeNativeBuffer = null;
    let activeNativeMode = '';
    let nativePausedAt = 0;
    let nativeGeneration = 0;
    let nativeFallbackNoticeShown = false;
    let activeStreamVolume = 1.0;
    let urlPlayback = null;

    async function getDecodedBuffer(url) {
        return window.EveAudioflixAudioCodec.getDecodedBuffer(
            url,
            () => waveformController?.getContext?.()
        );
    }
    function encodeBufferToBase64(audioBuffer, startAt = 0) {
        return window.EveAudioflixAudioCodec.encodeBufferToBase64(audioBuffer, startAt);
    }
    function state() {
        return window.EveAudioflixState?.ensure?.() || {};
    }
    function dispatch(name, detail) {
        window.dispatchEvent(new CustomEvent(name, { detail }));
    }
    urlPlayback = window.EveAudioflixUrlPlayback?.createController?.({
        onPlayback(detail) {
            currentItem = detail.item || currentItem;
            lastStatus = detail.status || lastStatus;
            dispatch('eve:audioflix-playback', detail);
        },
        onProgress(detail) { dispatch('eve:audioflix-progress', detail); },
        onPlayer(player) { waveformController?.attachPlayer?.(player); },
        onStep: (delta) => queueBridge?.step?.(delta),
        onJump: (index) => queueBridge?.jump?.(index)
    }) || null;
    let queueBridge = null;
    function setQueueBridge(bridge) { queueBridge = bridge || null; }
    function syncQueueView() {
        urlPlayback?.setQueue?.(queueBridge?.list?.() || [], queueBridge?.index?.() ?? 0);
    }
    function setPlaybackRate(rate) {
        const safe = Math.max(0.25, Math.min(4, Number(rate) || 1));
        try { ensureAudio().playbackRate = safe; } catch { /* element not built yet */ }
        urlPlayback?.setRate?.(safe);
        return safe;
    }
    const nativeRuntime = {
        get controller() { return activeNativeController; }, set controller(v) { activeNativeController = v; },
        get buffer() { return activeNativeBuffer; }, set buffer(v) { activeNativeBuffer = v; },
        get mode() { return activeNativeMode; }, set mode(v) { activeNativeMode = v; },
        get pausedAt() { return nativePausedAt; }, set pausedAt(v) { nativePausedAt = v; },
        get generation() { return nativeGeneration; }, set generation(v) { nativeGeneration = v; },
        get streamVolume() { return activeStreamVolume; }, set streamVolume(v) { activeStreamVolume = v; },
        get lastStatus() { return lastStatus; }, set lastStatus(v) { lastStatus = v; }
    };
    const { nativeProgress, finishNative, startNativeBuffer, stopNativePlayback } =
        window.EveAudioflixAudioNative.createController({
            runtime: nativeRuntime, dispatch, getCurrentItem: () => currentItem, encodeBufferToBase64,
            playBufferWaveform: (...args) => waveformController?.playBufferWaveform?.(...args),
            stopWaveform: () => waveformController?.stop?.()
        });

    function getPlaybackState() {
        if (urlPlayback?.isActive?.()) return urlPlayback.getPlaybackState();
        if (activeNativeMode) {
            const duration = Number(activeNativeBuffer?.duration || currentItem?.resolvedDuration || 0) || 0;
            const currentTime = activeNativeController?.currentTime?.() ?? nativePausedAt;
            return { item: currentItem, currentTime, duration, paused: !activeNativeController, native: true };
        }
        const player = audio;
        return {
            item: currentItem,
            currentTime: Number(player?.currentTime || 0) || 0,
            duration: Number.isFinite(player?.duration) ? player.duration : Number(currentItem?.resolvedDuration || 0) || 0,
            paused: player?.paused !== false,
            native: false
        };
    }

    function ensureAudio() {
        if (audio) return audio;
        audio = new Audio();
        audio.crossOrigin = 'anonymous';
        audio.preload = 'metadata';
        audio.addEventListener('play', function () {
            activeNativeMode = '';
            activeNativeBuffer = null;
            nativePausedAt = 0;
            lastStatus = `Playing ${currentItem?.title || 'audio'}${activeBrowserRouteLabel ? ` -> ${activeBrowserRouteLabel}` : ''}`;
            dispatch('eve:audioflix-playback', { status: lastStatus, item: currentItem });
            dispatch('eve:audioflix-progress', getPlaybackState());
            waveformController?.start?.();
        });
        audio.addEventListener('pause', function () {
            if (activeNativeMode) return;
            lastStatus = 'Paused';
            dispatch('eve:audioflix-playback', { status: lastStatus, item: currentItem });
            dispatch('eve:audioflix-progress', getPlaybackState());
        });
        audio.addEventListener('ended', function () {
            const endedItem = currentItem;
            const settle = Promise.resolve(musicCapture?.stop({ drain: true })).catch(() => false);
            lastStatus = 'Ended';
            dispatch('eve:audioflix-playback', { status: lastStatus, item: endedItem, settle });
            dispatch('eve:audioflix-progress', getPlaybackState());
            window.EveAudioflixLocalPlayback?.clearMediaSource?.(audio);
        });
        ['loadedmetadata', 'durationchange', 'timeupdate', 'seeked'].forEach((eventName) => {
            audio.addEventListener(eventName, () => {
                if (currentItem && audio.duration && isFinite(audio.duration) && audio.duration > 0 && (!currentItem.duration || currentItem.duration <= 0)) {
                    currentItem.duration = audio.duration;
                    window.EveAudioflixState?.updateItem?.(currentItem.type || 'music', currentItem.id, { duration: audio.duration });
                }
                if (!activeNativeMode) dispatch('eve:audioflix-progress', getPlaybackState());
            });
        });
        audio.addEventListener('error', function () {
            lastStatus = 'Audio failed to load';
            dispatch('eve:audioflix-playback', { status: lastStatus, item: currentItem, error: true });
        });
        return audio;
    }

    waveformController = window.EveAudioflixAudioWaveform?.createController?.(ensureAudio) || null;

    const outputRuntime = {
        get lastStatus() { return lastStatus; },
        set lastStatus(value) { lastStatus = value; },
        get currentItem() { return currentItem; },
        set currentItem(value) { currentItem = value; }
    };
    const outputController = window.EveAudioflixAudioOutput.createController({
        ensureAudio, getAudioContext: () => waveformController?.getContext?.(),
        state,
        dispatch,
        runtime: outputRuntime
    });
    const {
        applySink,
        selectOutput,
        listOutputs,
        setOutputById,
        unlockDeviceLabels,
        tryNativePlayback,
        browserOutputStatus,
        resolvePlaybackSink,
        routeBrowserStream
    } = outputController;

    // Label of the endpoint the continuous browser music stream was routed to (for status text).
    let activeBrowserRouteLabel = '';
    const musicCapture = window.EveAudioflixAudioCapture?.createController?.(
        { getWaveform: () => waveformController, getPlayer: () => audio, getVolume: () => activeStreamVolume }) || null;

    async function playUrlItem(item, playOptions = {}) {
        if (!urlPlayback?.canHandle?.(item)) throw new Error('This linked track needs the EveOS resolver server.');
        await musicCapture?.stop?.().catch(() => false);
        if (audio) {
            audio.pause();
            window.EveAudioflixLocalPlayback?.clearMediaSource?.(audio, item?.url);
        }
        await stopNativePlayback(false);
        currentItem = item;
        await urlPlayback.play(item, playOptions);
        window.EveAudioflixState?.recordPlay?.(item);
        return true;
    }

    async function preparePlaybackItem(item) {
        let prepared;
        try {
            prepared = await window.EveAudioflixLocalPlayback?.prepare?.(item) || {
                item: item && typeof item === 'object' ? { ...item } : item,
                localPath: '',
                status: ''
            };
            // Spotify playback-source ownership is an Audioflix invariant. Invoke the source
            // mapper explicitly after local-file preparation so a script/DOMContentLoaded race
            // cannot silently route an ordinary library play back into Spotify's iframe.
            prepared = await window.EveAudioflixNativeSpotify?.preparePlaybackSource?.(item, prepared) || prepared;
        } catch (error) {
            lastStatus = error?.message || 'The local audio source is unavailable.';
            throw error;
        }
        if (prepared?.status) lastStatus = prepared.status;
        return prepared;
    }

    async function openInternalView(item) {
        const prior = getPlaybackState();
        const sameItem = String(prior?.item?.id || '') === String(item?.id || '');
        const prepared = await preparePlaybackItem(item);
        const requestedItem = prepared?.item || (item && typeof item === 'object' ? { ...item } : {});
        if (!requestedItem.url) throw new Error('Audioflix item is missing a URL.');
        let playableItem = requestedItem;
        if (window.EveAudioflixAudioSource?.needsResolution?.(requestedItem.url) && window.EveAudioflixUrlProviders?.providerFor?.(requestedItem.url) !== 'instagram') {
            try { playableItem = await window.EveAudioflixAudioSource.resolveItem(requestedItem); }
            catch { /* Provider playback remains available when the resolver is offline. */ }
        }
        const opened = await playUrlItem(playableItem, { internalView: true });
        if (sameItem && Number(prior.currentTime) > 0) {
            await urlPlayback?.seek?.(prior.currentTime);
            if (prior.paused) await urlPlayback?.pause?.();
        }
        return opened;
    }
    async function playItem(item) {
        // Resume an existing provider controller before any async preparation can consume the
        // originating click gesture. This matters for protected iframe players such as Spotify.
        if (urlPlayback?.isActive?.()
            && urlPlayback.matches(item)
            && urlPlayback.shouldPreferBrowser?.(item)) {
            currentItem = item;
            await urlPlayback.play(item);
            window.EveAudioflixState?.recordPlay?.(item);
            return true;
        }
        const prepared = await preparePlaybackItem(item);
        const requestedItem = prepared?.item || (item && typeof item === 'object' ? { ...item } : {});
        if (!requestedItem.url) throw new Error('Audioflix item is missing a URL.');

        const needsResolution = window.EveAudioflixAudioSource?.needsResolution?.(requestedItem.url);
        if (urlPlayback?.shouldPreferBrowser?.(requestedItem) && !needsResolution) {
            // Provider page URLs are not media streams. Never fall through to the generic
            // <audio> path just because the native bridge happens to be online.
            return await playUrlItem(requestedItem);
        }

        if (activeNativeMode && activeNativeBuffer && nativePausedAt > 0
            && currentItem?.id === requestedItem.id
            && window.EveAudioflixNative?.shouldSuppressBrowserPlayback?.()) {
            currentItem = Object.assign({}, currentItem, { volume: requestedItem.volume ?? currentItem.volume });
            await startNativeBuffer(activeNativeBuffer, currentItem, nativePausedAt, activeNativeMode);
            lastStatus = `Playing ${currentItem.title || 'audio'}`;
            dispatch('eve:audioflix-playback', { status: lastStatus, item: currentItem, native: true });
            return true;
        }

        await stopNativePlayback(false);
        let safeItem = requestedItem;
        if (needsResolution) {
            lastStatus = `Resolving audio stream for ${safeItem.title || 'link'}...`;
            dispatch('eve:audioflix-playback', { status: lastStatus, item: safeItem });
            try {
                safeItem = await window.EveAudioflixAudioSource.resolveItem(safeItem);
            } catch (error) {
                try { return await playUrlItem(safeItem); }
                catch (fallbackError) {
                    lastStatus = `Could not play ${safeItem.title || 'audio link'}: ${fallbackError.message || error.message}`;
                    dispatch('eve:audioflix-playback', { status: lastStatus, item: safeItem, error: true });
                    throw fallbackError;
                }
            }
        }

        const resolvedProvider = window.EveAudioflixUrlProviders?.providerFor?.(safeItem.url);
        if (resolvedProvider && resolvedProvider !== 'direct'
            && urlPlayback?.shouldPreferBrowser?.(safeItem)) {
            return await playUrlItem(safeItem);
        }

        // Keep the currently authorized provider alive until the replacement transport is known.
        // Consecutive Spotify-derived YouTube matches can then reuse one YouTube player in the
        // background instead of destroying it before resolution and asking Chrome to autoplay a
        // brand-new iframe. Direct/native replacements still stop the old provider here.
        if (urlPlayback?.isActive?.() && !urlPlayback.matches(safeItem)) {
            await urlPlayback.stop();
        }

        if (safeItem.type === 'sound' && window.EveAudioflixNative?.shouldSuppressBrowserPlayback?.()) {
            try {
                lastStatus = `Decoding ${safeItem.title || 'audio'}...`;
                dispatch('eve:audioflix-playback', { status: lastStatus, item: safeItem });
                const audioBuffer = await getDecodedBuffer(safeItem.url);
                currentItem = safeItem;
                lastStatus = `Native route playing ${safeItem.title || 'audio'} -> ${state().nativeOutputLabel || 'selected output'}`;
                dispatch('eve:audioflix-playback', { status: lastStatus, item: safeItem, native: true });
                await startNativeBuffer(audioBuffer, safeItem, 0);
                nativeFallbackNoticeShown = false;
                window.EveAudioflixState?.recordPlay?.(safeItem);
                return true;
            } catch (err) {
                await stopNativePlayback(false).catch(() => {});
                if (await tryNativePlayback(safeItem).catch(() => false)) return true;
                if (String(err?.message || '').includes('Native bridge unreachable')) {
                    if (!nativeFallbackNoticeShown) {
                        nativeFallbackNoticeShown = true;
                        console.info('[Audioflix] Native bridge offline — playing through the browser route instead.');
                    }
                } else {
                    console.warn('[Audioflix] native stream failed, falling back:', err);
                }
            }
        }

        const player = ensureAudio();
        waveformController?.attachPlayer?.(player);
        player.volume = activeStreamVolume = window.EveAudioflixState.normalizeVolume(safeItem.volume, 1);
        window.EveAudioflixLocalPlayback?.setMediaSource?.(player, safeItem.url) || (player.src = safeItem.url);
        currentItem = safeItem;
        const directRoute = await routeBrowserStream(safeItem) || '';
        const nativeMusic = safeItem.type === 'music' && !directRoute
            && window.EveAudioflixNative?.shouldSuppressBrowserPlayback?.()
            && await musicCapture?.start(player, safeItem.id);
        if (!nativeMusic) await musicCapture?.stop?.().catch(() => false);
        activeBrowserRouteLabel = nativeMusic ? (state().nativeOutputLabel || 'native route') : directRoute;
        try {
            await player.play();
        } catch (error) {
            if (!/^https?:\/\//i.test(safeItem.url || '')) throw error;
            player.pause();
            window.EveAudioflixLocalPlayback?.clearMediaSource?.(player);
            return await playUrlItem(safeItem);
        }
        window.EveAudioflixState?.recordPlay?.(safeItem);
        return true;
    }
    const playTestSignal = window.EveAudioflixAudioTest?.createController?.({
        playItem,
        state,
        dispatch,
        setStatus(value) { lastStatus = value; }
    }) || (async () => false);
    const layerController = window.EveAudioflixAudioLayers.createController({
        state, dispatch, tryNativePlayback, getDecodedBuffer, encodeBufferToBase64, playUrlItem,
        canPlayUrl: (item) => urlPlayback?.canHandle?.(item),
        shouldPreferUrl: (item) => urlPlayback?.shouldPreferBrowser?.(item),
        stopUrlPlayback: (id) => {
            const item = urlPlayback?.getPlaybackState?.()?.item;
            return String(item?.id || item?.url || '') === String(id || '') && urlPlayback?.stop?.();
        },
        stopNativeItem: (id) => window.EveAudioflixNative?.stopStream?.({ allDevices: true, itemId: id })
    });
    const layerPlay = layerController.layerPlay;
    async function stopItemLayers(itemId, preserveProvider = false) {
        waveformController?.stop?.();
        const pending = [...layerController.stopItemLayers(itemId), window.EveAudioflixNative?.stopStream?.({ allDevices: true, itemId: String(itemId || '') })];
        const currentId = String(currentItem?.id || currentItem?.url || '');
        if (currentId && currentId === String(itemId || '') && !(preserveProvider && urlPlayback?.isActive?.() && urlPlayback?.matches?.(itemId))) {
            const stoppedItem = currentItem;
            await musicCapture?.stop?.().catch(() => false);
            await urlPlayback?.stop?.().catch?.(() => {});
            await stopNativePlayback(false).catch(() => {});
            if (audio) {
                audio.pause();
                try { audio.currentTime = 0; } catch {}
                window.EveAudioflixLocalPlayback?.clearMediaSource?.(audio);
            }
            currentItem = null;
            lastStatus = 'Stopped';
            dispatch('eve:audioflix-playback', { status: lastStatus, item: stoppedItem });
            dispatch('eve:audioflix-progress', { item: stoppedItem, currentTime: 0, duration: 0, paused: true });
        }
        await Promise.allSettled(pending);
        return true;
    }
    async function stopAll() {
        const stoppedItem = currentItem;
        const pending = layerController.stopAll();
        waveformController?.stop?.();
        await musicCapture?.stop?.().catch(() => false);
        if (audio) {
            audio.pause();
            try { audio.currentTime = 0; } catch {}
            window.EveAudioflixLocalPlayback?.clearMediaSource?.(audio);
        }
        await urlPlayback?.stop?.().catch?.(() => {});
        await stopNativePlayback(false).catch(() => {});
        await Promise.allSettled(pending);
        currentItem = null;
        lastStatus = 'Stopped';
        dispatch('eve:audioflix-playback', { status: lastStatus, item: stoppedItem });
        dispatch('eve:audioflix-progress', { item: stoppedItem, currentTime: 0, duration: 0, paused: true });
    }
    async function pause() {
        if (urlPlayback?.isActive?.()) return urlPlayback.pause();
        if (activeNativeMode) {
            await stopNativePlayback(true);
            lastStatus = 'Paused';
            dispatch('eve:audioflix-playback', { status: lastStatus, item: currentItem, native: true });
            nativeProgress(nativePausedAt, activeNativeBuffer?.duration || 0, true);
            return;
        }
        await musicCapture?.stop?.().catch(() => false);
        ensureAudio().pause();
    }
    async function seek(seconds) {
        const target = Math.max(0, Number(seconds || 0) || 0);
        if (urlPlayback?.isActive?.()) return urlPlayback.seek(target);
        if (activeNativeMode && activeNativeBuffer) {
            const duration = activeNativeBuffer.duration || 0;
            const next = Math.min(target, duration);
            const wasPlaying = !!activeNativeController;
            const mode = activeNativeMode;
            const buffer = activeNativeBuffer;
            await stopNativePlayback(true);
            nativePausedAt = next;
            if (wasPlaying) {
                await startNativeBuffer(buffer, currentItem, next, mode);
            }
            else nativeProgress(next, duration, true);
            return true;
        }
        const player = ensureAudio();
        if (!Number.isFinite(player.duration) || player.duration <= 0) return false;
        player.currentTime = Math.min(target, player.duration);
        dispatch('eve:audioflix-progress', getPlaybackState());
        return true;
    }

    function updateItemVolume(itemId, vol) {
        const safeVolume = Math.max(0, Math.min(1, Number(vol) || 0));
        const requestedId = String(itemId ?? '');
        const currentId = String(currentItem?.id ?? currentItem?.url ?? '');
        const activeUrlMatch = urlPlayback?.matches?.(itemId) === true;
        if ((requestedId && currentId === requestedId) || activeUrlMatch) {
            // The provider controller is the authoritative live identity. Resolved Spotify tracks
            // can cross several adapters before reaching a YouTube/provider iframe, so do not let
            // an intermediate ID representation prevent a live volume command from reaching it.
            if (activeUrlMatch) urlPlayback.setVolume(safeVolume);
            ensureAudio().volume = safeVolume;
            window.EveAudioflixNative?.setVoiceVolume?.('singleton-main', safeVolume);
            activeStreamVolume = safeVolume;
            activeNativeController?.setVolume?.(safeVolume);
            if (currentItem) currentItem.volume = safeVolume;
        }
        layerController.updateVolume(itemId, safeVolume);
    }

    function attachWaveform(targetCanvas) {
        waveformController?.attach?.(targetCanvas);
        const internalPlayer = urlPlayback?.getAudioElement?.();
        if (targetCanvas && internalPlayer?._eveAudioflixWaveformSafe) {
            waveformController?.attachPlayer?.(internalPlayer);
        }
    }

    Object.assign(ns, {
        ready: true, playItem, openInternalView, pause, seek, selectOutput, listOutputs, setOutputById,
        unlockDeviceLabels, playTestSignal, applySink, attachWaveform, browserOutputStatus, resolvePlaybackSink,
        layerPlay, stopItemLayers, stopAll, updateItemVolume, getDecodedBuffer, encodeBufferToBase64,
        getAudioElement: ensureAudio, getPlaybackState,
        setQueueBridge, syncQueueView, setPlaybackRate,
        isInternalViewOpen: () => urlPlayback?.isInternalViewOpen?.() === true,
        hideInternalView: () => urlPlayback?.hideInternalView?.(),
        closeInternalView: () => urlPlayback?.closeInternalView?.(),
        getPlaybackRate: () => urlPlayback?.getRate?.() ?? 1,
        getMusicCapture: () => musicCapture,
        getWaveformController: () => waveformController,
        getStatus() {
            const o = browserOutputStatus();
            return { status: lastStatus, item: currentItem, playback: getPlaybackState(), sinkId: o.activeSinkId, hasSetSinkId: o.hasSetSinkId, hasAudioContextSink: o.hasAudioContextSink, hasOutputPicker: o.hasOutputPicker, hasEnumerate: o.hasEnumerate, secureContext: o.secureContext };
        }
    });
})();
