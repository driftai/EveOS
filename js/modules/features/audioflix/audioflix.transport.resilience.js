window.EveAudioflixTransportResilience = window.EveAudioflixTransportResilience || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixTransportResilience;
    if (ns.ready) return;

    const PROVIDER_HOST_PATH = '/server/audioflix-provider-host.html';
    let pendingAdvance = '';

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

    function sendProviderVolume(level) {
        const info = providerFrameInfo();
        if (!info) return false;
        info.frame.contentWindow.postMessage({
            type: 'eve-audioflix-provider-command',
            token: info.token,
            action: 'volume',
            // Provider-host live commands use the YouTube player contract: integer 0..100.
            value: Math.round(clamp(level) * 100)
        }, info.url.origin);
        return true;
    }

    function scheduleQueueAdvance(itemId, source) {
        const bridge = window.EveAudioflix?.queueConnection;
        const snapshot = bridge?.snapshot?.();
        if (!snapshot?.isPlaying || snapshot.repeatOne || !snapshot.entries?.length) return false;

        const expectedIndex = Number(snapshot.currentIndex);
        const expectedItem = snapshot.entries[expectedIndex];
        if (!Number.isInteger(expectedIndex) || expectedIndex < 0 || !expectedItem) return false;

        const expectedId = String(expectedItem.id ?? '');
        if (itemId && expectedId && !sameId(itemId, expectedId)) return false;

        const key = `${expectedId}:${expectedIndex}`;
        if (pendingAdvance === key) return false;
        pendingAdvance = key;

        // Existing Audioflix Ended handlers run in microtasks. Wait one task, then only take over
        // if they did not move the queue. This makes the resilience path exact-once.
        setTimeout(() => {
            try {
                const latestBridge = window.EveAudioflix?.queueConnection;
                const latest = latestBridge?.snapshot?.();
                const latestItem = latest?.entries?.[latest.currentIndex];
                if (!latest?.isPlaying || latest.repeatOne
                    || Number(latest.currentIndex) !== expectedIndex
                    || String(latestItem?.id ?? '') !== expectedId) return;
                latestBridge.step?.(1);
                console.info(`[Audioflix] provider Ended handoff recovered via ${source}.`);
            } finally {
                if (pendingAdvance === key) pendingAdvance = '';
            }
        }, 0);
        return true;
    }

    document.addEventListener('input', (event) => {
        const target = event.target;
        if (!target?.matches?.('.audioflix-volume-slider, .audioflix-provider-volume')) return;

        const level = clamp(target.value);
        if (target.matches('.audioflix-volume-slider')) {
            const activeId = window.EveAudioflixAudio?.getPlaybackState?.()?.item?.id;
            const cardId = target.dataset.afId;
            // A non-active card must never control the currently playing provider.
            if (activeId === undefined || activeId === null || !sameId(activeId, cardId)) return;
        }

        // The normal controller remains authoritative. This is a live provider-host fallback for
        // file:// / localhost bridge playback when an adapter identity check drops the command.
        sendProviderVolume(level);
    });

    window.addEventListener('eve:audioflix-playback', (event) => {
        const detail = event.detail || {};
        if (detail.status !== 'Ended' || detail.browserOnly !== true) return;
        scheduleQueueAdvance(detail.item?.id, 'playback event');
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
        const activeId = window.EveAudioflixAudio?.getPlaybackState?.()?.item?.id;
        scheduleQueueAdvance(activeId, 'provider-host state');
    });

    Object.assign(ns, {
        ready: true,
        providerFrameInfo,
        sendProviderVolume,
        scheduleQueueAdvance
    });
})();
