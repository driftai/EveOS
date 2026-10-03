window.EveAudioflixSpotifyPlayback = window.EveAudioflixSpotifyPlayback || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixSpotifyPlayback;
    if (ns.ready) return;

    const SDK_URL = 'https://open.spotify.com/embed/iframe-api/v1';
    const READY_TIMEOUT_MS = 12000;
    const START_TIMEOUT_MS = 10000;
    let apiPromise = null;

    function spotifyTrackId(value) {
        return String(value || '').match(/(?:spotify:track:|open\.spotify\.com\/track\/)([A-Za-z0-9]+)/i)?.[1] || '';
    }

    function startTimeoutMs() {
        const override = Number(window.__EveAudioflixSpotifyStartTimeoutMs);
        return Number.isFinite(override) && override >= 50 ? override : START_TIMEOUT_MS;
    }

    function loadApi() {
        if (apiPromise) return apiPromise;
        apiPromise = new Promise((resolve, reject) => {
            let settled = false;
            const previous = window.onSpotifyIframeApiReady;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                apiPromise = null;
                reject(new Error('Spotify player timed out while loading.'));
            }, READY_TIMEOUT_MS);
            window.onSpotifyIframeApiReady = (api) => {
                try { previous?.(api); } catch {}
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(api);
            };
            const existing = [...document.scripts].find((script) => script.src === SDK_URL);
            if (existing) return;
            const script = Object.assign(document.createElement('script'), { src: SDK_URL, async: true });
            script.addEventListener('error', () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                apiPromise = null;
                reject(new Error('Spotify player resources could not load.'));
            }, { once: true });
            document.head.appendChild(script);
        });
        return apiPromise;
    }

    ns.create = function create(ctx) {
        const { ensureStage, setStageStatus, emitPlayback, emitProgress } = ctx;
        const V = ctx.view;

        async function playSpotify(item) {
            const id = spotifyTrackId(item?.url);
            if (!id) throw new Error('This Spotify link does not contain a playable track ID.');
            const host = ensureStage(item, 'Spotify');
            const mount = document.createElement('div');
            mount.className = 'audioflix-spotify-player';
            host.appendChild(mount);
            const api = await loadApi();

            await new Promise((resolve, reject) => {
                let settled = false;
                let ended = false;
                let started = false;
                let startTimer = 0;
                let runtimeFailureReported = false;
                let selectedItem = item;
                const timer = setTimeout(() => finish(new Error('Spotify player did not become ready.')), READY_TIMEOUT_MS);
                const blockedMessage = 'Spotify playback needs a direct click in this browser. Use the visible Spotify play control, allow protected media, or localize this track for reliable one-click playback.';
                const clearStartTimer = () => {
                    if (startTimer) clearTimeout(startTimer);
                    startTimer = 0;
                };
                const finish = (error) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    error ? reject(error) : resolve();
                };
                const reportRuntimeFailure = (message = blockedMessage) => {
                    if (runtimeFailureReported) return;
                    runtimeFailureReported = true;
                    clearStartTimer();
                    V.playback.paused = true;
                    // Keep normal playback invisible. Reveal the official transport only when
                    // Spotify requires an additional direct click to satisfy browser policy.
                    V.revealTransportFallback?.();
                    setStageStatus(message);
                    emitPlayback(message, true);
                    emitProgress();
                    if (!settled) finish();
                };
                const markStarted = () => {
                    started = true;
                    runtimeFailureReported = false;
                    clearStartTimer();
                    setStageStatus('Playing with Spotify\'s official embedded player.');
                };
                api.createController(mount, {
                    uri: `spotify:track:${id}`,
                    width: '100%',
                    height: 152
                }, (controller) => {
                    const invokePlay = () => typeof controller.play === 'function'
                        ? controller.play()
                        : controller.resume?.();
                    const player = {
                        play: () => {
                            started = false;
                            runtimeFailureReported = false;
                            clearStartTimer();
                            setStageStatus('Spotify player ready. Starting playback...');
                            startTimer = setTimeout(() => reportRuntimeFailure(), startTimeoutMs());
                            try {
                                const pending = invokePlay();
                                Promise.resolve(pending).catch(() => reportRuntimeFailure());
                                return pending;
                            } catch {
                                reportRuntimeFailure();
                                return undefined;
                            }
                        },
                        pause: () => {
                            clearStartTimer();
                            return controller.pause?.();
                        },
                        setCurrentTime: (seconds) => controller.seek?.(Math.max(0, Number(seconds) || 0)),
                        setVolume: (volume) => controller.setVolume?.(Math.max(0, Math.min(1, Number(volume) || 0))),
                        destroy: () => {
                            clearStartTimer();
                            return controller.destroy?.();
                        },
                        loadItem: async (nextItem) => {
                            const nextId = spotifyTrackId(nextItem?.url);
                            if (!nextId) throw new Error('This Spotify link does not contain a playable track ID.');
                            selectedItem = nextItem;
                            ended = false;
                            started = false;
                            runtimeFailureReported = false;
                            clearStartTimer();
                            setStageStatus(`Loading ${nextItem.title || 'the next Spotify track'}...`);
                            const loaded = controller.loadEntity?.(`spotify:track:${nextId}`)
                                ?? controller.loadUri?.(`spotify:track:${nextId}`);
                            await Promise.resolve(loaded);
                            return player.play();
                        }
                    };
                    V.active = { kind: 'spotify', player };
                    controller.addListener?.('ready', () => {
                        player.setVolume(item.volume ?? 1);
                        player.play();
                        finish();
                    });
                    controller.addListener?.('playback_started', () => {
                        markStarted();
                        V.playback.paused = false;
                        emitPlayback(`Playing ${selectedItem.title || 'Spotify track'} with Spotify`);
                        emitProgress();
                    });
                    controller.addListener?.('playback_update', (event) => {
                        const data = event?.data || event || {};
                        const playingId = spotifyTrackId(data.playingURI);
                        if (playingId && playingId !== spotifyTrackId(selectedItem?.url)) return;
                        V.playback.currentTime = Math.max(0, Number(data.position || 0) / 1000);
                        V.playback.duration = Math.max(0, Number(data.duration || 0) / 1000);
                        V.playback.paused = data.isPaused !== false;
                        const atEnd = V.playback.duration > 0
                            && V.playback.currentTime >= Math.max(0, V.playback.duration - 0.35);
                        if (!V.playback.paused) {
                            if (!started) markStarted();
                            ended = false;
                            emitPlayback(`Playing ${selectedItem.title || 'Spotify track'} with Spotify`);
                        } else if (atEnd && !ended) {
                            clearStartTimer();
                            ended = true;
                            emitPlayback('Ended');
                        }
                        emitProgress();
                    });
                    controller.addListener?.('playback_error', (event) => {
                        const detail = String(event?.data?.message || event?.message || '').trim();
                        reportRuntimeFailure(detail ? `Spotify could not play this track: ${detail}` : blockedMessage);
                    });
                });
            });
        }

        return { playSpotify };
    };

    Object.assign(ns, { ready: true, spotifyTrackId, loadApi });
})();
