window.EveAudioflixSpotifyEngine = window.EveAudioflixSpotifyEngine || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixSpotifyEngine;
    if (ns.ready) return;

    const SDK_URL = 'https://open.spotify.com/embed/iframe-api/v1';
    const READY_TIMEOUT_MS = 12000;
    const END_TOLERANCE_MS = 1500;
    const END_RESET_MAX_MS = 500;
    // A successful seek close to the provider's end can be followed only by a paused/zero reset.
    // Keep this wider than END_TOLERANCE_MS without widening ordinary end/stall detection.
    const SEEK_END_RESET_TOLERANCE_MS = 4000;
    // Spotify's embed reports the final frame as position === duration with isPaused:false and
    // then goes silent (verified against the live iframe API), so a paused update never arrives.
    const END_REACHED_MS = 250;
    const END_STALL_MS = 2500;
    let endStallTimer = 0;
    const mount = document.getElementById('spotify-engine-player');
    const state = {
        version: 1,
        status: 'idle',
        spotifyId: '',
        title: '',
        generation: 0,
        currentTime: 0,
        duration: 0,
        paused: true,
        started: false,
        ended: false,
        error: '',
        eventCursor: 0,
        completionId: '',
        lastEventAt: 0,
        providerPaused: false
    };
    let apiPromise = null;
    let controller = null;
    let controllerReady = null;
    let lastPlayingPositionMs = 0;
    let lastDurationMs = 0;
    let seekEndResetGeneration = 0;
    let resetting = false;
    let awaitingReplayStart = false;
    let replayRequested = false;
    let playRequestedGeneration = 0;
    const recentEvents = [];
    const trace = (kind, data = {}) => {
        recentEvents.push({ at: Date.now(), generation: state.generation, kind, status: state.status,
            position: data.position, duration: data.duration, paused: data.isPaused, buffering: data.isBuffering });
        if (recentEvents.length > 32) recentEvents.shift();
    };

    const text = (value) => String(value ?? '').trim();
    const trackId = (value) => text(value)
        .match(/(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)?([A-Za-z0-9]{22})(?:[?/#]|$)?/i)?.[1] || '';
    const bump = () => {
        state.eventCursor += 1;
        state.lastEventAt = Date.now();
    };
    function snapshot() {
        return {
            ...state,
            currentTime: Number(state.currentTime || 0),
            duration: Number(state.duration || 0),
            ready: Boolean(controller),
            playRequested: playRequestedGeneration === state.generation && state.generation > 0,
            replayPending: awaitingReplayStart,
            recentEvents: recentEvents.slice(),
            spotifyUri: state.spotifyId ? `spotify:track:${state.spotifyId}` : ''
        };
    }
    function setStatus(status, patch = {}) {
        Object.assign(state, patch, { status });
        bump();
        return snapshot();
    }
    function loadApi() {
        if (apiPromise) return apiPromise;
        apiPromise = new Promise((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                apiPromise = null;
                reject(new Error('Spotify iframe API timed out.'));
            }, READY_TIMEOUT_MS);
            const previous = window.onSpotifyIframeApiReady;
            window.onSpotifyIframeApiReady = (api) => {
                try { previous?.(api); } catch {}
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve(api);
            };
            if ([...document.scripts].some((script) => script.src === SDK_URL)) return;
            const script = Object.assign(document.createElement('script'), { src: SDK_URL, async: true });
            script.addEventListener('error', () => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                apiPromise = null;
                reject(new Error('Spotify iframe API failed to load.'));
            }, { once: true });
            document.head.appendChild(script);
        });
        return apiPromise;
    }
    function markEnded(durationMs = 0) {
        if (state.ended) return false;
        const effective = Math.max(Number(durationMs || lastDurationMs || 0), 0);
        seekEndResetGeneration = 0;
        state.ended = true;
        state.started = false;
        state.paused = true;
        state.providerPaused = false;
        state.status = 'ended';
        if (effective > 0) {
            state.duration = effective / 1000;
            state.currentTime = state.duration;
        }
        state.completionId = `${state.generation}:${state.eventCursor + 1}`;
        bump();
        return true;
    }
    function attachListeners(target) {
        target.addListener?.('ready', () => setStatus('loaded', { paused: true, error: '' }));
        target.addListener?.('playback_started', () => {
            trace('provider-started');
            if (resetting) return;
            if (awaitingReplayStart) { setStatus('starting'); return; }
            state.started = true;
            state.ended = false;
            state.paused = false;
            state.providerPaused = false;
            state.error = '';
            setStatus('playing');
        });
        target.addListener?.('playback_update', (event) => {
            trace('provider-update', event?.data || event || {});
            if (resetting) return;
            const data = event?.data || event || {};
            const playingId = trackId(data.playingURI);
            if (playingId && state.spotifyId && playingId !== state.spotifyId) return;
            const positionMs = Math.max(0, Number(data.position || 0));
            const durationMs = Math.max(0, Number(data.duration || 0));
            const paused = data.isPaused !== false;
            const effectiveDurationMs = durationMs || lastDurationMs;
            // Same-URI events carry no play-generation token. Old final frames may arrive
            // after pause/seek reset or even playback_started; require fresh start progress
            // before letting those frames complete the new queue slot.
            if (awaitingReplayStart) {
                if (playRequestedGeneration !== state.generation || paused || positionMs > 2000) return;
                awaitingReplayStart = false;
            }
            const wasPlaying = state.paused === false;
            const previousNearEnd = lastDurationMs > 0
                && lastPlayingPositionMs >= Math.max(0, lastDurationMs - END_TOLERANCE_MS);
            const atEnd = effectiveDurationMs > 0
                && positionMs >= Math.max(0, effectiveDurationMs - END_TOLERANCE_MS);
            const resetAfterEnd = state.started && paused && wasPlaying
                && previousNearEnd && positionMs <= END_RESET_MAX_MS;
            const resetAfterNearEndSeek = state.started && paused
                && seekEndResetGeneration === state.generation && positionMs <= END_RESET_MAX_MS;

            clearTimeout(endStallTimer);
            endStallTimer = 0;
            // Completion is durable until playback_started, load, or restart starts playback
            // again. Spotify can send paused/zero resets before the client gets to poll us.
            if (state.ended) return;
            state.currentTime = positionMs / 1000;
            state.duration = effectiveDurationMs / 1000;
            state.paused = paused;
            if (durationMs > 0) lastDurationMs = durationMs;
            if (positionMs > 0) lastPlayingPositionMs = positionMs;

            if (!paused && effectiveDurationMs > 0 && positionMs >= effectiveDurationMs - END_REACHED_MS) {
                markEnded(effectiveDurationMs);
                return;
            }
            if (!paused) {
                if (seekEndResetGeneration === state.generation && effectiveDurationMs > 0
                    && positionMs < Math.max(0, effectiveDurationMs - SEEK_END_RESET_TOLERANCE_MS)) {
                    seekEndResetGeneration = 0;
                }
                if (atEnd) {
                    const generation = state.generation;
                    endStallTimer = setTimeout(() => {
                        endStallTimer = 0;
                        if (state.generation === generation && state.paused === false) markEnded(effectiveDurationMs);
                    }, END_STALL_MS);
                }
                state.started = true;
                state.ended = false;
                state.providerPaused = false;
                state.status = 'playing';
                state.error = '';
                bump();
                return;
            }
            if ((atEnd || resetAfterEnd || resetAfterNearEndSeek) && markEnded(effectiveDurationMs)) return;
            const pausedOutsideSeekTail = effectiveDurationMs > 0
                && positionMs < Math.max(0, effectiveDurationMs - SEEK_END_RESET_TOLERANCE_MS);
            if (seekEndResetGeneration === state.generation && positionMs > END_RESET_MAX_MS && pausedOutsideSeekTail) {
                seekEndResetGeneration = 0;
            }
            state.providerPaused = state.started && !state.ended;
            state.status = state.providerPaused ? 'provider-paused' : 'paused';
            bump();
        });
        target.addListener?.('playback_error', (event) => {
            const message = text(event?.data?.message || event?.message || 'Spotify playback failed.');
            seekEndResetGeneration = 0;
            state.error = message;
            state.paused = true;
            state.status = 'blocked';
            bump();
        });
    }
    async function ensureController(id) {
        if (controller) return controller;
        const api = await loadApi();
        controllerReady = new Promise((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error('Spotify controller did not become ready.'));
            }, READY_TIMEOUT_MS);
            api.createController(mount, { uri: `spotify:track:${id}`, width: '100%', height: 152 }, (created) => {
                controller = created;
                attachListeners(controller);
                const readyListener = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeout);
                    resolve(controller);
                };
                controller.addListener?.('ready', readyListener);
                setTimeout(readyListener, 1200);
            });
        });
        return controllerReady;
    }
    async function load(payload = {}) {
        trace('load');
        const id = trackId(payload.spotifyId || payload.url || payload.uri);
        if (!id) throw new Error('A valid Spotify track ID is required.');
        const hadController = Boolean(controller);
        const sameUri = hadController && state.spotifyId === id;
        const nextGeneration = Math.max(1, Number(payload.generation || state.generation + 1));
        resetting = true;
        awaitingReplayStart = sameUri;
        replayRequested = sameUri;
        playRequestedGeneration = 0;
        clearTimeout(endStallTimer);
        endStallTimer = 0;
        state.spotifyId = id;
        state.title = text(payload.title);
        state.generation = nextGeneration;
        state.currentTime = 0;
        state.duration = Math.max(0, Number(payload.duration || 0));
        state.paused = true;
        state.started = false;
        state.ended = false;
        state.providerPaused = false;
        state.completionId = '';
        state.error = '';
        lastPlayingPositionMs = 0;
        lastDurationMs = state.duration * 1000;
        seekEndResetGeneration = 0;
        setStatus('loading');
        try {
            const player = await ensureController(id);
            if (sameUri) {
                // Repeated slots reset the provider without another iframe navigation.
                await Promise.resolve(player.pause?.());
            } else if (hadController && player && typeof player.loadUri === 'function') {
                await Promise.resolve(player.loadUri(`spotify:track:${id}`));
            } else if (hadController && player && typeof player.loadEntity === 'function') {
                await Promise.resolve(player.loadEntity(`spotify:track:${id}`));
            }
        } finally { resetting = false; }
        return setStatus('loaded', { paused: true });
    }
    async function play() {
        trace('play');
        if (!controller) throw new Error('No Spotify track is loaded.');
        playRequestedGeneration = state.generation;
        seekEndResetGeneration = 0;
        state.providerPaused = false;
        setStatus('starting');
        const replay = replayRequested;
        replayRequested = false;
        const pending = replay && typeof controller.restart === 'function' ? controller.restart()
            : typeof controller.resume === 'function' && state.started ? controller.resume() : controller.play?.();
        await Promise.resolve(pending);
        return snapshot();
    }
    async function pause() {
        if (!controller) return snapshot();
        playRequestedGeneration = 0;
        seekEndResetGeneration = 0;
        await Promise.resolve(controller.pause?.());
        state.paused = true;
        state.providerPaused = false;
        return setStatus('paused');
    }
    // Generation-safe silence for an abandoned helper start: the check and the intent clear run
    // synchronously, so a newer load can never be paused by an older request. Not a transport action.
    async function quiesce(payload = {}) {
        if (!controller || Number(payload.generation) !== state.generation) return { ...snapshot(), quiesced: false };
        return { ...(await pause()), quiesced: true };
    }
    async function seek(payload = {}) {
        if (!controller) throw new Error('No Spotify track is loaded.');
        const seconds = Math.max(0, Number(payload.seconds || 0));
        const targetMs = seconds * 1000;
        const durationMs = Math.max(lastDurationMs, Number(state.duration || 0) * 1000);
        const wasPlaying = state.started && state.paused === false && !state.ended;
        const previousCompletionId = state.completionId;
        await Promise.resolve(controller.seek?.(seconds));
        // A seek-to-end can complete before its acknowledgement; do not overwrite that result.
        if (state.ended && state.completionId !== previousCompletionId) return snapshot();
        state.currentTime = seconds;
        if (wasPlaying && targetMs > 0) lastPlayingPositionMs = targetMs;
        seekEndResetGeneration = wasPlaying && durationMs > 0
            && targetMs >= Math.max(0, durationMs - SEEK_END_RESET_TOLERANCE_MS)
            ? state.generation : 0;
        return setStatus(state.paused ? 'paused' : 'playing');
    }
    async function stop() {
        seekEndResetGeneration = 0;
        await pause();
        if (controller?.seek) await Promise.resolve(controller.seek(0)).catch(() => {});
        state.currentTime = 0;
        state.started = false;
        state.ended = false;
        return setStatus('stopped', { paused: true, providerPaused: false });
    }
    function acknowledgeMediaSeek(payload = {}) {
        if (Number(payload.generation) !== state.generation || payload.spotifyId !== state.spotifyId) {
            throw new Error('Spotify playback changed before seek acknowledgement.');
        }
        if (awaitingReplayStart) throw new Error('Spotify replay start is not confirmed yet.');
        if (state.ended) return snapshot();
        const seconds = Math.max(0, Number(payload.currentTime || 0));
        const durationMs = Math.max(0, Number(payload.duration || 0) * 1000);
        const wasPlaying = state.started && !state.paused;
        trace('media-seek', { position: seconds * 1000, duration: durationMs });
        state.currentTime = seconds;
        if (durationMs > 0) { state.duration = durationMs / 1000; lastDurationMs = durationMs; }
        if (wasPlaying && seconds > 0) lastPlayingPositionMs = seconds * 1000;
        seekEndResetGeneration = wasPlaying && durationMs > 0
            && seconds * 1000 >= Math.max(0, durationMs - SEEK_END_RESET_TOLERANCE_MS) ? state.generation : 0;
        return setStatus(state.paused ? 'paused' : 'playing');
    }
    async function restart(payload = {}) {
        if (!controller) throw new Error('No Spotify track is loaded.');
        seekEndResetGeneration = 0;
        // A restart has the same untagged late-frame race as a same-URI load. Reuse
        // its fresh-progress fence before seeking so the old tail cannot end this run.
        awaitingReplayStart = true;
        playRequestedGeneration = 0;
        clearTimeout(endStallTimer);
        endStallTimer = 0;
        lastPlayingPositionMs = 0;
        state.generation = Math.max(1, Number(payload.generation || state.generation + 1));
        state.completionId = '';
        await Promise.resolve(controller.seek?.(0));
        state.currentTime = 0;
        state.started = false;
        state.ended = false;
        state.providerPaused = false;
        return play();
    }
    async function command(action, payload = {}) {
        const name = text(action).toLowerCase();
        if (name === 'status') return snapshot();
        if (name === 'load') return load(payload);
        if (name === 'play' || name === 'resume') return play();
        if (name === 'pause') return pause();
        if (name === 'seek') return seek(payload);
        if (name === 'stop') return stop();
        if (name === 'restart') return restart(payload);
        throw new Error(`Unsupported Spotify engine action: ${name || '(empty)'}`);
    }

    Object.assign(ns, { ready: true, snapshot, command, trackId, acknowledgeMediaSeek, quiesce });
    document.documentElement.dataset.spotifyEngineReady = 'true';
})();
