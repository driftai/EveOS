// Shared Spotify management facade. It coordinates the existing authenticated relay, managed
// engine, Provider Capture, and Audioflix playback owners without introducing another transport.
window.EveAudioflixSpotifyManagement = window.EveAudioflixSpotifyManagement || {};
(function (ns) {
    'use strict';
    if (ns.ready) return;
    const remote = () => window.EveAudioflixSpotifyRemote;
    const managed = () => window.EveAudioflixSpotifyAnyBrowser;
    const captureUi = () => window.EveAudioflixProviderCaptureUi;
    const audio = () => window.EveAudioflixAudio;

    function currentItem() {
        const value = managed()?.snapshot?.() || {};
        return value.playback?.item || value.item || null;
    }
    function snapshot() {
        const relay = remote()?.snapshot?.() || {};
        const playback = managed()?.snapshot?.() || {};
        const managedState = relay.lastState?.managed || {};
        const engine = relay.lastState?.engine || playback.playback || {};
        const capture = captureUi()?.managedCaptureStatus?.() || managedState.capture || {};
        const item = currentItem();
        const policy = window.EveAudioflixPlaybackPolicy?.resolve?.(item || {}) || {};
        return { relay, playback, managed: managedState, engine, capture, item, policy };
    }
    async function connect(force = false) {
        const api = remote();
        if (!api) throw new Error('Spotify relay client is unavailable.');
        const result = force ? await api.retry?.() : await api.connect?.();
        return result || api.snapshot?.() || {};
    }
    async function takeControl() {
        const connection = await connect();
        if (!connection.connected) {
            if (connection.approvalRequired) return connection;
            throw new Error(connection.lastError || connection.reason || 'Spotify relay is unavailable.');
        }
        const result = await remote().send('take-control', {}, { timeout: 15000 });
        if (!result?.ok || result?.isOwner !== true) throw new Error(result?.reason || 'Could not take control of Spotify.');
        return result;
    }
    async function refresh() {
        const connection = await connect();
        if (!connection.connected) return connection;
        const result = await remote().status();
        if (!result?.ok) throw new Error(result?.reason || 'Spotify diagnostics are unavailable.');
        return result;
    }
    function approve() {
        if (!remote()?.openApproval?.()) throw new Error('No Spotify relay approval is waiting.');
        return { ok: true, pending: true };
    }
    async function authenticate() {
        const ownership = await takeControl();
        if (ownership.approvalRequired) return ownership;
        const result = await remote().send('auth', { openLogin: true, url: 'https://open.spotify.com/' }, { timeout: 30000 });
        if (!result?.ok) throw new Error(result?.reason || 'Spotify sign-in window could not be opened.');
        return result;
    }
    async function setPresentation(mode) {
        const ownership = await takeControl();
        if (ownership.approvalRequired) return ownership;
        const result = await remote().send('engine-presentation', { mode }, { timeout: 25000 });
        if (!result?.ok) throw new Error(result?.reason || `Could not set Spotify Engine to ${mode}.`);
        return result;
    }
    async function restart() {
        const ownership = await takeControl();
        if (ownership.approvalRequired) return ownership;
        const base = new URL(String(remote().snapshot?.().base || 'http://127.0.0.1:8765'));
        const reload = window.EveOSServiceReload;
        if (typeof reload?.restart !== 'function') throw new Error('Shared EveOS restart control is unavailable.');
        await audio()?.stopAll?.();
        const result = await reload.restart('spotifyEngine', {
            port: Number(base.port || (base.protocol === 'https:' ? 443 : 80)), timeoutS: 45
        });
        if (result?.serviceRestarted !== true) throw new Error(result?.message || 'Spotify Engine did not restart cleanly.');
        remote()?.disconnect?.();
        return result;
    }
    async function stopEngine() {
        const ownership = await takeControl();
        if (ownership.approvalRequired) return ownership;
        const result = await remote().send('engine-stop', {}, { timeout: 12000 });
        if (!result?.ok) throw new Error(result?.reason || 'Spotify Engine could not stop safely.');
        await audio()?.stopAll?.();
        return result;
    }
    async function toggleCapture() {
        const status = captureUi()?.managedCaptureStatus?.() || {};
        if (status.active === true) {
            const result = await remote()?.send?.('engine-capture-stop', {}, { timeout: 15000 });
            if (!result?.ok) throw new Error(result?.reason || 'Spotify Engine capture could not stop safely.');
            return result;
        }
        return captureUi()?.armManagedSpotify?.();
    }
    async function togglePlayback() {
        const value = snapshot();
        if (value.engine.paused === false || value.playback.playback?.paused === false) return audio()?.pause?.();
        if (!value.item) throw new Error('Choose a Spotify song before pressing Play.');
        return audio()?.playItem?.(value.item);
    }
    async function stopPlayback() { return audio()?.stopAll?.(); }

    Object.assign(ns, { ready: true, snapshot, currentItem, connect, refresh, approve, authenticate,
        takeControl, setPresentation, restart, stopEngine, toggleCapture, togglePlayback, stopPlayback });
})(window.EveAudioflixSpotifyManagement);
