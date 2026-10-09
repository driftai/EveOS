window.EveAudioflixTransportResilience = window.EveAudioflixTransportResilience || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixTransportResilience;
    if (ns.ready) return;

    const PROVIDER_HOST_PATH = '/server/audioflix-provider-host.html';
    let pendingAdvance = '';

    const audio = () => window.EveAudioflixAudio;
    const queue = () => window.EveAudioflix?.queueConnection;
    const clamp = (value) => Math.max(0, Math.min(1, Number(value) || 0));
    const sameId = (left, right) => String(left ?? '') === String(right ?? '');

    function providerFrameInfo() {
        const frames = document.querySelectorAll('.audioflix-provider-frame iframe');
        for (const frame of frames) {
            try {
                const url = new URL(frame.src, location.href);
                const token = url.searchParams.get('token') || '';
                if (url.pathname.endsWith(PROVIDER_HOST_PATH) && token && frame.contentWindow) {
                    return { frame, url, token };
                }
            } catch { /* ignore stale/non-URL frames */ }
        }
        return null;
    }

    function sendProviderCommand(action, value) {
        const info = providerFrameInfo();
        if (!info) return false;
        info.frame.contentWindow.postMessage({
            type: 'eve-audioflix-provider-command',
            token: info.token,
            action,
            ...(value === undefined ? {} : { value })
        }, info.url.origin);
        return true;
    }

    function sendProviderVolume(level) {
        // Provider-host live commands use the YouTube player contract: integer 0..100.
        const audible = window.EveAudioflixOutputPort?.effective?.(level) ?? clamp(level);
        return sendProviderCommand('volume', Math.round(audible * 100));
    }

    async function resume() {
        const controller = audio();
        const playback = controller?.getPlaybackState?.();
        if (!playback?.item) return false;
        if (playback.paused === false) return true;

        // A provider-host player is already the active EveOS transport. Resume that exact player
        // instead of routing Play back through playItem(), which can repeat source preparation and
        // rebuild a provider at 0:00. YouTube playVideo() resumes the currently loaded video.
        if (playback.browserOnly === true && sendProviderCommand('play')) return true;

        // Browser-safe/local audio has a real HTMLMediaElement owned by Audioflix. Resume it in
        // place so WatchFusion and any future transport client never need to know its source type.
        const player = controller?.getWaveformController?.()?.getActivePlayer?.();
        if (playback.browserOnly !== true && typeof player?.play === 'function') {
            await player.play();
            return true;
        }

        // Other provider adapters already implement same-item resume inside playItem/urlPlayback.
        // Keep that as the compatibility fallback for providers that are not hosted by EveOS yet.
        return await controller?.playItem?.(playback.item) !== false;
    }

    async function pause() {
        const controller = audio();
        if (!controller?.getPlaybackState?.()?.item) return false;
        await controller.pause?.();
        return true;
    }

    async function seek(seconds) {
        const controller = audio();
        if (!controller?.getPlaybackState?.()?.item) return false;
        return await controller.seek?.(Math.max(0, Number(seconds) || 0)) !== false;
    }

    function setRate(rate) {
        return audio()?.setPlaybackRate?.(rate);
    }

    function setVolume(level, options = {}) {
        const controller = audio();
        const playback = controller?.getPlaybackState?.();
        const activeId = playback?.item?.id;
        if (activeId === undefined || activeId === null) return false;
        if (options.itemId !== undefined && options.itemId !== null && !sameId(activeId, options.itemId)) return false;

        const safe = clamp(level);
        controller.updateItemVolume?.(activeId, safe);
        if (options.persist !== false) {
            const type = playback.item?.type || options.type || 'music';
            window.EveAudioflixState?.setItemVolume?.(type, activeId, safe);
        }

        // updateItemVolume routes through the active URL adapter. The direct provider-host command
        // is an idempotent fallback for localhost/file bridge transports if an adapter loses its
        // identity while a source is being resolved.
        if (playback.browserOnly === true) sendProviderVolume(safe);
        return true;
    }

    function scheduleQueueAdvance(itemId, source, settle) {
        const bridge = queue();
        const snapshot = bridge?.snapshot?.();
        if (!snapshot?.isPlaying || !snapshot.entries?.length) return false;

        const expectedIndex = Number(snapshot.currentIndex);
        const expectedItem = snapshot.entries[expectedIndex];
        if (!Number.isInteger(expectedIndex) || expectedIndex < 0 || !expectedItem) return false;

        const expectedId = String(expectedItem.id ?? '');
        if (itemId !== undefined && itemId !== null && expectedId && !sameId(itemId, expectedId)) return false;

        const repeatOne = snapshot.repeatOne === true;
        const expectedRunId = snapshot.playbackRunId;
        const key = `${expectedId}:${expectedRunId}:${repeatOne ? 'repeat' : 'next'}`;
        if (pendingAdvance === key) return false;
        pendingAdvance = key;

        // Wait for capture/provider settlement, then let the primary Ended handler go first.
        // Recover only for the same playback run and item, using the latest reordered queue.
        // provider-independent and exact-once across direct, localized, YouTube, Spotify fallback,
        // SoundCloud, Vimeo, Instagram, and future adapters that emit the common Ended event.
        Promise.resolve(settle).catch(() => false).then(() => setTimeout(() => {
            try {
                const latestBridge = queue();
                const latest = latestBridge?.snapshot?.();
                const latestItem = latest?.entries?.[latest.currentIndex];
                if (!latest?.isPlaying
                    || latest.playbackRunId !== expectedRunId
                    || String(latestItem?.id ?? '') !== expectedId) return;
                if (repeatOne && latest.repeatOne === true) latestBridge.action?.('restart');
                else if (!latest.repeatOne) latestBridge.step?.(1);
                console.info(`[Audioflix] Ended handoff recovered via ${source}.`);
            } finally {
                if (pendingAdvance === key) pendingAdvance = '';
            }
        }, 0));
        return true;
    }

    document.addEventListener('input', (event) => {
        const target = event.target;
        if (!target?.matches?.('.audioflix-volume-slider, .audioflix-provider-volume')) return;

        const level = clamp(target.value);
        if (target.matches('.audioflix-volume-slider')) {
            const activeId = audio()?.getPlaybackState?.()?.item?.id;
            const cardId = target.dataset.afId;
            // A non-active card must never control the currently playing transport.
            if (activeId === undefined || activeId === null || !sameId(activeId, cardId)) return;
        }

        // The normal controller remains authoritative. This is only the provider-host safety net.
        sendProviderVolume(level);
    });

    window.addEventListener('eve:audioflix-playback', (event) => {
        const detail = event.detail || {};
        if (detail.status !== 'Ended') return;
        scheduleQueueAdvance(detail.item?.id, 'playback event', detail.settle);
    });

    window.addEventListener('eve:audioflix-output-volume', () => {
        const playback = audio()?.getPlaybackState?.();
        if (playback?.browserOnly === true) sendProviderVolume(playback.item?.volume ?? 1);
    });

    // Observe the provider-host signal before any higher-level adapter can lose provenance/identity.
    window.addEventListener('message', (event) => {
        const info = providerFrameInfo();
        if (!info || event.source !== info.frame.contentWindow || event.origin !== info.url.origin) return;
        const detail = event.data;
        if (detail?.type !== 'eve-audioflix-provider'
            || detail.token !== info.token
            || detail.event !== 'state'
            || detail.state !== 'ended') return;
        const activeId = audio()?.getPlaybackState?.()?.item?.id;
        scheduleQueueAdvance(activeId, 'provider-host state');
    });

    const transport = window.EveAudioflixTransportControl = window.EveAudioflixTransportControl || {};
    Object.assign(transport, {
        resume,
        play: resume,
        pause,
        seek,
        setRate,
        setVolume,
        getPlaybackState: () => audio()?.getPlaybackState?.()
    });

    Object.assign(ns, {
        ready: true,
        providerFrameInfo,
        sendProviderCommand,
        sendProviderVolume,
        scheduleQueueAdvance,
        transport
    });
})();
