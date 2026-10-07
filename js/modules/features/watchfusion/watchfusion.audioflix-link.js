(function () {
    'use strict';
    if (window.__eveWatchFusionAudioflixLinkReady) return;
    window.__eveWatchFusionAudioflixLinkReady = true;
    let publisher = null, tap = null, timer = null, activeId = '', peerLoader = null, releaseMonitorMute = null;
    const pending = new Map();
    const audio = () => window.EveAudioflixAudio;
    const transport = () => window.EveAudioflixTransportControl;
    const queue = () => window.EveAudioflix?.queueConnection;
    function trusted(event) {
        const embedded = document.querySelector('#watchfusion-overlay .watchfusion-frame')?.contentWindow;
        const detached = window.EveWatchFusion?.getDetachedWindow?.();
        return !!event.source && (event.source === embedded || event.source === detached)
            && window.EveWatchFusionRuntimeSensor?.isCandidateOrigin?.(event.origin) === true;
    }
    function loadPeer() {
        if (window.WatchFusionLivePeer) return Promise.resolve();
        if (peerLoader) return peerLoader;
        peerLoader = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = new URL('tools/WatchFusion/browser-extension/live-peer.js?v=3ebe77853c8b', document.baseURI).href;
            script.onload = resolve;
            script.onerror = () => { peerLoader = null; script.remove(); reject(new Error('Could not load the media link. Reload EveOS.')); };
            document.head.appendChild(script);
        });
        return peerLoader;
    }
    function playable() {
        const playback = audio()?.getPlaybackState?.();
        if (!playback?.item || playback.native) {
            throw new Error('Play a Music Library track before connecting Audioflix to WatchFusion.');
        }
        const providerOnly = playback.browserOnly === true && playback.provider !== 'direct';
        const player = providerOnly ? null : audio()?.getWaveformController?.()?.getActivePlayer?.();
        if (!providerOnly && (!player || player._eveAudioflixWaveformSafe === false)) {
            throw new Error('This track cannot be captured safely. Play a local or browser-safe Audioflix track, or use a provider-backed Music Library item.');
        }
        return { playback, player, providerOnly };
    }
    function snapshot() {
        const { playback, player, providerOnly } = playable();
        const q = queue()?.snapshot?.() || {};
        const item = playback.item || {};
        const provider = playback.provider || (providerOnly ? 'provider' : 'direct');
        return { title: item.title || 'Music Library', group: q.groupName || '', queue: q.entries || [], index: q.currentIndex,
            shuffle: q.shuffle, loop: q.loop, canReorder: typeof queue()?.move === 'function', actions: q.actions || [], paused: playback.paused, currentTime: playback.currentTime,
            duration: playback.duration, rate: Number(player?.playbackRate || playback.rate || 1) || 1,
            volume: Math.max(0, Math.min(1, Number(item.volume ?? player?.volume ?? 1))),
            provider, providerOnly, itemId: item.id, itemUrl: item.url || '',
            status: providerOnly ? `${provider} provider linked · queue and controls are synced; provider audio stays in Audioflix on this device.` : '' };
    }
    function publish() {
        try { publisher?.metadata(snapshot()); }
        catch (error) { publisher?.metadata({ title: 'Audioflix', status: error.message, paused: true }); }
    }
    async function control(action, value) {
        try {
            const { playback, player, providerOnly } = playable();
            const controller = transport();
            const resumeCurrent = async () => {
                if (typeof controller?.resume === 'function') return controller.resume();
                return providerOnly ? audio().playItem?.(playback.item) : player.play();
            };
            const pauseCurrent = async () => {
                if (typeof controller?.pause === 'function') return controller.pause();
                return audio().pause();
            };
            if (action === 'toggle') { if (playback.paused) await resumeCurrent(); else await pauseCurrent(); }
            if (action === 'play') await resumeCurrent();
            if (action === 'pause') await pauseCurrent();
            if (action === 'seek') {
                const target = Math.max(0, Math.min(value, playback.duration || 0));
                if (typeof controller?.seek === 'function') await controller.seek(target);
                else await audio().seek(target);
            }
            if (action === 'rate') {
                if (typeof controller?.setRate === 'function') controller.setRate(value);
                else audio().setPlaybackRate(value);
            }
            if (action === 'volume') {
                const volume = Math.max(0, Math.min(1, value));
                if (typeof controller?.setVolume === 'function') {
                    controller.setVolume(volume, { itemId: playback.item.id, type: 'music', persist: true });
                } else {
                    audio().updateItemVolume(playback.item.id, volume);
                    window.EveAudioflixState?.updateItem?.('music', playback.item.id, { volume });
                }
            }
            if (action === 'prev' || action === 'next') await queue()?.step?.(action === 'prev' ? -1 : 1);
            if (action === 'jump') await queue()?.jump?.(Math.floor(value));
            if (action === 'queue-move-up' || action === 'queue-move-down') {
                const from = Math.floor(value), delta = action === 'queue-move-up' ? -1 : 1;
                queue()?.move?.(from, from + delta);
            }
            if (action === 'shuffle' || action === 'loop') await queue()?.action?.(`${action}-music-group`);
            else if ((queue()?.snapshot?.()?.actions || []).some(item => item.id === action)) await queue()?.action?.(action);
            publish();
        } catch (error) { publisher?.metadata({ title: 'Audioflix', status: error.message }); }
    }
    function stop() {
        clearInterval(timer); timer = null; publisher?.stop(); publisher = null;
        tap?.release?.(); tap = null; activeId = '';
        releaseMonitorMute?.(); releaseMonitorMute = null;
    }
    async function start(config) {
        if (activeId === config.id && publisher) return;
        const source = playable(); await loadPeer(); stop();
        try {
            if (!source.providerOnly) {
                tap = await audio().getWaveformController().createLiveTap();
                releaseMonitorMute = audio().getWaveformController().acquireSpeakerMute?.('watchfusion-live') || null;
            }
            activeId = config.id;
            publisher = new window.WatchFusionLivePeer({ ...config,
                ...(tap?.stream ? { stream: tap.stream } : { publisher: true }),
                onReady: publish, onControl: control,
                onStatus: status => { if (/stopped|expired|denied|replaced/i.test(status)) stop(); }
            });
            timer = setInterval(publish, 500);
        } catch (error) { stop(); throw error; }
    }
    window.addEventListener('message', async event => {
        const data = event.data;
        if (!data || !['watchfusion:audioflix-probe', 'watchfusion:audioflix-start'].includes(data.type) || !trusted(event)) return;
        if (data.type === 'watchfusion:audioflix-probe') {
            pending.set(data.requestId, { source: event.source, at: Date.now() });
            setTimeout(() => pending.delete(data.requestId), 10000);
            event.source.postMessage({ type: 'watchfusion:audioflix-ready', requestId: data.requestId }, event.origin);
            return;
        }
        const request = pending.get(data.requestId); pending.delete(data.requestId);
        if (request?.source !== event.source || Date.now() - request.at > 10000) return;
        let error = '';
        try {
            if (new URL(data.config?.base).origin !== event.origin) throw new Error('WatchFusion source origin changed. Reconnect it.');
            await start(data.config);
        } catch (failure) { error = failure.message; }
        event.source.postMessage({ type: 'watchfusion:audioflix-result', requestId: data.requestId, error }, event.origin);
    });
    window.addEventListener('beforeunload', stop);
    window.EveWatchFusionAudioflixLink = { stop, active: () => !!publisher };
})();
