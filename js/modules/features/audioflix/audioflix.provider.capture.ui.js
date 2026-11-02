window.EveAudioflixProviderCaptureUi = window.EveAudioflixProviderCaptureUi || {};
(function (ns) {
    'use strict';
    if (ns.ready) return;
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    let lastManagedCapture = null;

    function managedCaptureStatus() {
        const remoteCapture = window.EveAudioflixSpotifyRemote?.snapshot?.()?.lastState?.managed?.capture;
        if (remoteCapture && typeof remoteCapture === 'object') lastManagedCapture = { ...remoteCapture, source: remoteCapture.source || 'managed-spotify' };
        return lastManagedCapture || { state: 'idle', active: false, source: 'managed-spotify' };
    }

    function captureStatus() {
        const local = window.EveAudioflixProviderCapture?.getStatus?.() || {};
        return local.active === true ? local : managedCaptureStatus();
    }

    function renderCard() {
        const status = captureStatus();
        const active = status.active === true;
        const facts = [
            `Permission: ${status.authorization || 'required'}`,
            `Audio: ${status.audioTrack ? 'track present' : 'not captured'}`,
            `PCM: ${status.nonzeroPcm ? 'nonzero' : 'waiting'}`,
            `Transport: ${status.transport ? 'accepted' : 'waiting'}`,
            `Renderer: ${status.renderer ? 'running' : 'idle'}`,
            `Suppression: ${status.suppression || 'not checked'}`
        ].join(' · ');
        return `<section class="audioflix-status-grid"><article data-af-provider-card class="audioflix-status-card ${active ? 'is-on' : ''}">
            <span>Provider Audio Capture</span><strong data-af-provider-state>${esc(status.state || 'idle')}</strong>
            <p data-af-provider-message>${esc(status.message || 'Capture is not armed.')}</p>
            <p data-af-provider-facts class="audioflix-mini-status">${esc(facts)}</p>
            <p data-af-provider-counts class="audioflix-mini-status">Endpoint: ${esc(status.endpoint || 'not reserved')} · Gain ${Math.round((status.gain ?? 1) * 100)}% · Chunks ${status.chunks || 0} · Dropped ${status.dropped || 0}</p>
            <p class="audioflix-mini-status">Physical output: not independently verified; check the actual device meter.</p>
            <button type="button" data-af-action="provider-test-tone" ${active ? 'disabled' : ''}>Test Provider PCM</button>
            <button type="button" data-af-action="provider-managed-show" ${active ? 'disabled' : ''}>1. Show Spotify Engine</button>
            <button type="button" data-af-action="provider-managed-arm" ${active ? 'disabled' : ''}>2. Capture Engine to Native Output</button>
            <button type="button" data-af-action="provider-arm" ${active ? 'disabled' : ''}>Capture Another Provider Tab</button>
            <button type="button" data-af-action="provider-stop" ${active ? '' : 'disabled'}>Stop Capture</button>
        </article></section>`;
    }

    function syncLiveStatus() {
        const status = captureStatus();
        const facts = [
            `Permission: ${status.authorization || 'required'}`,
            `Audio: ${status.audioTrack ? 'track present' : 'not captured'}`,
            `PCM: ${status.nonzeroPcm ? 'nonzero' : 'waiting'}`,
            `Transport: ${status.transport ? 'accepted' : 'waiting'}`,
            `Renderer: ${status.renderer ? 'running' : 'idle'}`,
            `Suppression: ${status.suppression || 'not checked'}`
        ].join(' · ');
        document.querySelectorAll('[data-af-provider-card]').forEach(card => {
            card.classList.toggle('is-on', status.active === true);
            const write = (selector, value) => { const target = card.querySelector(selector); if (target) target.textContent = value; };
            write('[data-af-provider-state]', status.state || 'idle');
            write('[data-af-provider-message]', status.message || 'Capture is not armed.');
            write('[data-af-provider-facts]', facts);
            write('[data-af-provider-counts]', `Endpoint: ${status.endpoint || 'not reserved'} · Gain ${Math.round((status.gain ?? 1) * 100)}% · Chunks ${status.chunks || 0} · Dropped ${status.dropped || 0}`);
            for (const action of ['provider-test-tone', 'provider-managed-show', 'provider-managed-arm', 'provider-arm', 'provider-stop']) {
                const button = card.querySelector(`[data-af-action="${action}"]`);
                if (button) button.disabled = action === 'provider-stop' ? status.active !== true : status.active === true;
            }
        });
    }
    window.addEventListener('eve:audioflix-provider-capture', syncLiveStatus);

    function managedRoute() {
        const managed = window.EveAudioflixSpotifyAnyBrowser?.snapshot?.() || {};
        const item = managed.playback?.item || managed.item;
        const policy = window.EveAudioflixPlaybackPolicy?.resolve?.(item || {}) || {};
        if (policy.outputKind !== 'native' || !String(policy.outputId || '').startsWith('sd:')) {
            throw new Error('Managed Spotify capture needs an exact native output in Playback Policy.');
        }
        return { item, endpoint: { deviceId: policy.outputId, label: policy.outputLabel || policy.outputId } };
    }

    async function showManagedSpotify() {
        const remote = window.EveAudioflixSpotifyRemote;
        const connection = await remote?.connect?.();
        if (!connection?.connected && !remote?.snapshot?.().connected) {
            throw new Error(connection?.reason || 'Managed Spotify engine is unavailable.');
        }
        const ownership = await remote.send('take-control', {}, { timeout: 15000 });
        if (!ownership?.ok || ownership?.isOwner !== true) throw new Error(ownership?.reason || 'Could not take control of the managed Spotify engine.');
        const result = await remote.send('engine-presentation', { mode: 'window' }, { timeout: 25000 });
        if (!result?.ok) throw new Error(result?.reason || 'Could not show the managed Spotify engine.');
        return result;
    }

    async function armManagedSpotify() {
        const route = managedRoute();
        await window.EveAudioflixSpotifyNativeCapture?.ensure?.({
            outputKind: 'native', outputId: route.endpoint.deviceId, outputLabel: route.endpoint.label
        }, route.item);
        lastManagedCapture = { ...managedCaptureStatus(), source: 'managed-spotify' };
        return { ok: lastManagedCapture.active === true, capture: lastManagedCapture };
    }

    async function handleAction(_target, action, ctx) {
        if (!['provider-test-tone', 'provider-managed-show', 'provider-managed-arm', 'provider-arm', 'provider-stop'].includes(action)) return false;
        try {
            if (action === 'provider-test-tone') await window.EveAudioflixProviderCapture?.testTone?.();
            if (action === 'provider-managed-show') await showManagedSpotify();
            if (action === 'provider-managed-arm') await armManagedSpotify();
            if (action === 'provider-arm') await window.EveAudioflixProviderCapture?.armProviderTab?.();
            if (action === 'provider-stop') {
                if (managedCaptureStatus().active === true) {
                    const result = await window.EveAudioflixSpotifyRemote?.send?.('engine-capture-stop', {}, { timeout: 15000 });
                    if (!result?.ok) throw new Error(result?.reason || 'Managed Spotify capture could not stop safely.');
                    lastManagedCapture = { ...(result.captureResult?.capture || result.managed?.capture || {}), active: false, source: 'managed-spotify' };
                    await window.EveAudioflixAudio?.pause?.().catch?.(() => {});
                } else {
                    await window.EveAudioflixProviderCapture?.stop?.('user');
                }
            }
            ctx.playbackStatus = captureStatus().message || 'Provider capture updated.';
        } catch (error) {
            ctx.playbackStatus = error?.message || 'Provider capture failed.';
        }
        ctx.rerender();
        return true;
    }

    const routing = window.EveAudioflixRouting;
    if (routing?.renderStatusCards && !routing.__providerCaptureWrapped) {
        const original = routing.renderStatusCards;
        routing.renderStatusCards = (...args) => original(...args) + renderCard();
        routing.__providerCaptureWrapped = true;
    }
    Object.assign(ns, { ready: true, renderCard, handleAction, showManagedSpotify, armManagedSpotify, managedRoute, managedCaptureStatus, captureStatus });
})(window.EveAudioflixProviderCaptureUi);
