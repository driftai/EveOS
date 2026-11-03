// Electron Direct Embed transport adapter. The existing Audioflix queue and playbackRunId remain
// authoritative; this module only translates an `electron` Spotify policy into server commands.
window.EveAudioflixSpotifyDirect = window.EveAudioflixSpotifyDirect || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixSpotifyDirect;
    if (ns.ready) return;
    const media = () => window.EveAudioflixSpotifyMedia;
    const native = () => window.EveAudioflixNative;
    let installed = false, active = false, starting = false, item = null, pollTimer = 0, run = 0;
    let lastStatus = '', lastCompletionId = '', activeQueueRun = null;
    let playback = { item: null, currentTime: 0, duration: 0, paused: true,
        provider: 'spotify', browserOnly: true, electronDirect: true };

    const dispatch = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
    const same = (left, right) => media()?.fromItem?.(left)?.spotifyUri === media()?.fromItem?.(right)?.spotifyUri;
    const queueRun = () => window.EveAudioflix?.queueConnection?.snapshot?.()?.playbackRunId ?? null;
    const sameIntent = (left, right) => same(left, right) && String(left?.id || '') === String(right?.id || '')
        && activeQueueRun === queueRun();
    const gain = (value) => window.EveAudioflixSpotifyVolume?.effectiveGain?.(value) ?? Math.max(0, Math.min(1, Number(value) || 0));
    function emit(status, error = false, detail = {}) {
        dispatch('eve:audioflix-playback', { status, item, provider: 'spotify', browserOnly: true,
            electronDirect: true, error, ...detail });
    }
    function progress() { dispatch('eve:audioflix-progress', { ...playback }); }
    function stateFrom(result) { return result?.state || result?.host?.state || {}; }
    async function request(action, payload = {}, timeout = 20000) {
        const result = await native()?.request?.('/api/audioflix/spotify-direct/command', {
            method: 'POST', timeout, body: JSON.stringify({ action, payload })
        });
        if (!result?.ok) throw new Error(result?.reason || result?.message || 'Electron Direct Embed failed.');
        return result;
    }
    function apply(result, expectedRun = run) {
        if (!active || expectedRun !== run) return false;
        const state = stateFrom(result), identity = state.identity;
        const expected = media()?.fromItem?.(item);
        if (identity?.spotifyUri && expected?.spotifyUri !== identity.spotifyUri) return false;
        playback.currentTime = Math.max(0, Number(state.currentTime || 0));
        playback.duration = Math.max(0, Number(state.duration || playback.duration || item?.duration || 0));
        playback.paused = state.paused !== false;
        const status = String(state.status || '').toLowerCase();
        if (status === 'playing' && lastStatus !== 'playing') {
            lastStatus = 'playing'; emit(`Playing ${item?.title || 'Spotify track'} with Electron Direct Embed`);
        } else if (status === 'paused' && lastStatus !== 'paused') {
            lastStatus = 'paused'; emit('Paused');
        } else if (status === 'error' && lastStatus !== 'error') {
            lastStatus = 'error'; emit(state.captureError || state.lastError || 'Electron Direct Embed stopped unexpectedly.', true,
                { terminal: true });
        }
        const completionId = String(state.completionId || '');
        if (status === 'ended' && completionId && completionId !== lastCompletionId) {
            lastCompletionId = completionId; lastStatus = 'ended'; playback.paused = true; emit('Ended');
        }
        progress();
        return true;
    }
    async function poll() {
        const expectedRun = run;
        try {
            const result = await native()?.request?.('/api/audioflix/spotify-direct/status', { method: 'GET', timeout: 2500 });
            if (expectedRun !== run || !active) return;
            if (!result?.running) {
                if (lastStatus !== 'error') { lastStatus = 'error'; emit(result?.lastError || 'Electron Direct Embed host stopped.', true,
                    { terminal: true }); }
                return;
            }
            apply(result, expectedRun);
        } catch {}
    }
    function startPoll() {
        clearInterval(pollTimer);
        pollTimer = setInterval(poll, 500);
    }
    function stopPoll() { clearInterval(pollTimer); pollTimer = 0; }
    async function preferredLocal(nextItem, policy) {
        if (policy.sourcePreference === 'original') return null;
        try {
            const prepared = await window.EveAudioflixLocalPlayback?.prepare?.(nextItem);
            if (!prepared?.localPath) return null;
            window.EveAudioflixLocalPlayback?.handoffPrepared?.(prepared.item || nextItem, prepared.localPath);
            return prepared.item || nextItem;
        } catch { return null; }
    }
    async function playDirect(nextItem, policy, original) {
        const identity = media()?.fromItem?.(nextItem);
        if (!identity) throw new Error('Electron Direct Embed requires a valid Spotify track or episode.');
        if (policy.outputKind !== 'native' || !/^sd:\d+$/.test(String(policy.outputId || ''))) {
            throw new Error('Electron Direct Embed needs an exact native output. Choose CABLE or another sd:* endpoint in Playback policy.');
        }
        if (active && sameIntent(item, nextItem) && lastStatus !== 'ended') {
            if (playback.paused) {
                const result = await request('resume'); apply(result);
            }
            return true;
        }
        const expectedRun = ++run;
        starting = true;
        await original.stopAll(); // exclusive provider ownership: no Spotify/unrelated overlap
        item = nextItem; activeQueueRun = queueRun();
        playback = { item, currentTime: 0, duration: Number(item.duration || item.resolvedDuration || 0) || 0,
            paused: true, provider: 'spotify', browserOnly: true, electronDirect: true };
        lastStatus = 'starting'; lastCompletionId = '';
        try {
            const result = await request('play', { ...identity, itemId: String(item.id || ''), title: item.title || '',
                duration: playback.duration, deviceId: policy.outputId, gain: gain(item.volume ?? 1) }, 100000);
            if (expectedRun !== run) return false;
            active = true; apply(result, expectedRun); startPoll();
            return true;
        } finally { if (expectedRun === run) starting = false; }
    }
    async function stopDirect(released = false) {
        const stopped = item; ++run; starting = false; stopPoll();
        if (active || stopped) await request('stop').catch(() => null);
        active = false; item = null; activeQueueRun = null; lastStatus = 'stopped'; lastCompletionId = '';
        playback = { item: stopped, currentTime: 0, duration: 0, paused: true,
            provider: 'spotify', browserOnly: true, electronDirect: true };
        if (stopped) { emit('Stopped', false, { item: stopped, released }); progress(); }
    }
    function install() {
        if (installed || !window.EveAudioflixAudio?.ready || !native()?.ready || !media()?.ready) return false;
        installed = true;
        const audio = window.EveAudioflixAudio;
        const original = { playItem: audio.playItem.bind(audio), openInternalView: audio.openInternalView.bind(audio),
            pause: audio.pause.bind(audio), resume: audio.resume.bind(audio), seek: audio.seek.bind(audio),
            stopAll: audio.stopAll.bind(audio), stopItemLayers: audio.stopItemLayers.bind(audio),
            updateItemVolume: audio.updateItemVolume.bind(audio), getPlaybackState: audio.getPlaybackState.bind(audio),
            getStatus: audio.getStatus?.bind(audio) };
        audio.playItem = async function directPlay(nextItem) {
            const policy = window.EveAudioflixPlaybackPolicy?.resolve?.(nextItem) || { spotifyMethod: 'managed' };
            if (policy.spotifyMethod !== 'electron' || !media().fromItem(nextItem)) {
                if (active || starting) await stopDirect(true);
                return original.playItem(nextItem);
            }
            const local = await preferredLocal(nextItem, policy);
            if (local) { if (active || starting) await stopDirect(true); return original.playItem(local); }
            return playDirect(nextItem, policy, original);
        };
        audio.openInternalView = async function directInternal(nextItem) {
            const policy = window.EveAudioflixPlaybackPolicy?.resolve?.(nextItem) || { spotifyMethod: 'managed' };
            if (policy.spotifyMethod !== 'electron' || !media().fromItem(nextItem)) {
                if (active || starting) await stopDirect(true);
                return original.openInternalView(nextItem);
            }
            return audio.playItem(nextItem);
        };
        audio.pause = async function directPause() {
            if (!active && !starting) return original.pause();
            const result = await request('pause'); apply(result); return true;
        };
        audio.resume = async function directResume() {
            if (!active && !starting) return original.resume();
            if (!item || lastStatus === 'ended') return false;
            const result = await request('resume'); apply(result); return true;
        };
        audio.seek = async function directSeek(seconds) {
            if (!active) return original.seek(seconds);
            const result = await request('seek', { seconds: Math.max(0, Number(seconds || 0)) }); apply(result); return true;
        };
        audio.stopAll = async function directStopAll() {
            if (active || starting || item) await stopDirect();
            await original.stopAll(); return true;
        };
        audio.stopItemLayers = async function directStopItem(itemId, preserveProvider = false) {
            if (!preserveProvider && (active || starting) && String(item?.id || '') === String(itemId || '')) await stopDirect();
            return original.stopItemLayers(itemId, preserveProvider);
        };
        audio.updateItemVolume = function directVolume(itemId, value, options = {}) {
            if (!active || String(item?.id || '') !== String(itemId || '')) return original.updateItemVolume(itemId, value, options);
            const safe = Math.max(0, Math.min(1, Number(value) || 0)); item.volume = safe; playback.item = item;
            request('volume', { gain: gain(safe) }, 5000).catch(() => {});
        };
        audio.getPlaybackState = () => active ? { ...playback } : original.getPlaybackState();
        if (original.getStatus) audio.getStatus = () => active
            ? { ...original.getStatus(), item, playback: { ...playback }, spotifyDirect: ns.snapshot() } : original.getStatus();
        window.addEventListener('eve:audioflix-output-volume', () => {
            if (active && item) request('volume', { gain: gain(item.volume ?? 1) }, 5000).catch(() => {});
        });
        return true;
    }
    Object.assign(ns, { ready: true, install, stop: stopDirect,
        snapshot: () => ({ active, starting, item, playback: { ...playback }, status: lastStatus }),
        show: () => request('show'), hide: () => request('hide') });
    if (!install()) window.addEventListener('load', install, { once: true });
})();
