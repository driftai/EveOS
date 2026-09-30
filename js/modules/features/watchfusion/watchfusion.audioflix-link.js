(function () {
    'use strict';
    if (window.__eveWatchFusionAudioflixLinkReady) return;
    window.__eveWatchFusionAudioflixLinkReady = true;
    let publisher = null, tap = null, timer = null, activeId = '', peerLoader = null, releaseMonitorMute = null;
    const pending = new Map();
    const audio = () => window.EveAudioflixAudio;
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
            document.head.append(script);
        });
        return peerLoader;
    }
    function playable() {
        const playback = audio()?.getPlaybackState?.();
        const player = audio()?.getWaveformController?.()?.getActivePlayer?.();
        if (!playback?.item || playback.native || !player || player._eveAudioflixWaveformSafe === false
            || (playback.browserOnly && playback.provider !== 'direct')) {
            throw new Error('This source uses a separate provider player. Use Link a playing tab for it, or play a local/browser audio track in Music Library.');
        }
        return { playback, player };
    }
    function snapshot() {
        const { playback, player } = playable();
        const q = queue()?.snapshot?.() || {};
        return { title: playback.item.title || 'Music Library', group: q.groupName || '', queue: q.entries || [], index: q.currentIndex,
            shuffle: q.shuffle, loop: q.loop, actions: q.actions || [], paused: playback.paused, currentTime: playback.currentTime,
            duration: playback.duration, rate: player.playbackRate || 1, volume: player.volume ?? 1 };
    }
    function publish() {
        try { publisher?.metadata(snapshot()); }
        catch (error) { publisher?.metadata({ title: 'Audioflix', status: error.message, paused: true }); }
    }
    async function control(action, value) {
        try {
            const { playback, player } = playable();
            if (action === 'toggle') { if (playback.paused) await player.play(); else await audio().pause(); }
            if (action === 'play') await player.play();
            if (action === 'pause') await audio().pause();
            if (action === 'seek') await audio().seek(Math.max(0, Math.min(value, playback.duration || 0)));
            if (action === 'rate') audio().setPlaybackRate(value);
            if (action === 'volume') {
                const volume = Math.max(0, Math.min(1, value));
                audio().updateItemVolume(playback.item.id, volume);
                window.EveAudioflixState?.updateItem?.('music', playback.item.id, { volume });
            }
            if (action === 'prev' || action === 'next') await queue()?.step?.(action === 'prev' ? -1 : 1);
            if (action === 'jump') await queue()?.jump?.(Math.floor(value));
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
        playable(); await loadPeer(); stop();
        try {
            tap = await audio().getWaveformController().createLiveTap();
            releaseMonitorMute = audio().getWaveformController().acquireSpeakerMute?.('watchfusion-live') || null;
            activeId = config.id;
            publisher = new window.WatchFusionLivePeer({ ...config, stream: tap.stream, onReady: publish, onControl: control,
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
