window.EveAudioflixSpotifyPlayback = window.EveAudioflixSpotifyPlayback || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixSpotifyPlayback;
    if (ns.ready) return;

    const SDK_URL = 'https://open.spotify.com/embed/iframe-api/v1';
    const READY_TIMEOUT_MS = 12000;
    const START_TIMEOUT_MS = 10000;
    const END_TOLERANCE_MS = 1500;
    const END_RESET_MAX_MS = 500;
    const END_WATCHDOG_GRACE_MS = 1250;
    let apiPromise = null;

    function spotifyTrackId(value) {
        return String(value || '').match(/(?:spotify:track:|open\.spotify\.com\/track\/)([A-Za-z0-9]+)/i)?.[1] || '';
    }

    function startTimeoutMs() {
        const override = Number(window.__EveAudioflixSpotifyStartTimeoutMs);
        return Number.isFinite(override) && override >= 50 ? override : START_TIMEOUT_MS;
    }

    function endWatchdogGraceMs() {
        const override = Number(window.__EveAudioflixSpotifyEndWatchdogGraceMs);
        return Number.isFinite(override) && override >= 0 ? override : END_WATCHDOG_GRACE_MS;
    }

    function createCompletionScheduler(onDeadline) {
        const injectedFactory = window.__EveAudioflixSpotifyCompletionSchedulerFactory;
        if (typeof injectedFactory === 'function') {
            try {
                const injected = injectedFactory(onDeadline);
                if (injected?.arm && injected?.cancel) return injected;
            } catch {}
        }

        const WorkerCtor = window.Worker;
        const workerSource = `
            self.postMessage({ type: 'ready' });
            let timer = 0;
            self.onmessage = (event) => {
                const message = event && event.data || {};
                if (message.type === 'cancel') {
                    if (timer) clearTimeout(timer);
                    timer = 0;
                    return;
                }
                if (message.type !== 'arm') return;
                if (timer) clearTimeout(timer);
                const delay = Math.max(0, Number(message.delay) || 0);
                const token = Number(message.token) || 0;
                timer = setTimeout(() => {
                    timer = 0;
                    self.postMessage({ type: 'deadline', token });
                }, delay);
            };
        `;

        if (typeof WorkerCtor === 'function') {
            const factories = [];
            const BlobCtor = window.Blob;
            const urlApi = window.URL;

            // Blob workers inherit the owning page's origin and are the most compatible
            // standalone option for Chromium file:// documents. They stay fully inline:
            // no localhost server, fetch(), or external worker file is required.
            if (typeof BlobCtor === 'function' && typeof urlApi?.createObjectURL === 'function') {
                factories.push(() => {
                    let objectUrl = '';
                    try {
                        objectUrl = urlApi.createObjectURL(new BlobCtor([workerSource], { type: 'text/javascript' }));
                        const worker = new WorkerCtor(objectUrl);
                        return {
                            worker,
                            cleanup() {
                                if (!objectUrl) return;
                                try { urlApi.revokeObjectURL?.(objectUrl); } catch {}
                                objectUrl = '';
                            }
                        };
                    } catch {
                        if (objectUrl) {
                            try { urlApi.revokeObjectURL?.(objectUrl); } catch {}
                        }
                        return null;
                    }
                });
            }

            // Keep an inline data: worker as a second local-only path. Some browser/file
            // policies reject one inline worker scheme but accept the other.
            factories.push(() => ({
                worker: new WorkerCtor(`data:text/javascript;charset=utf-8,${encodeURIComponent(workerSource)}`),
                cleanup() {}
            }));

            let factoryIndex = 0;
            let activeWorker = null;
            let armed = null;
            let backupTimer = 0;
            let destroyed = false;

            const clearBackup = () => {
                if (backupTimer) clearTimeout(backupTimer);
                backupTimer = 0;
            };
            const disposeWorker = () => {
                const entry = activeWorker;
                activeWorker = null;
                if (!entry) return;
                try { entry.worker.onmessage = null; } catch {}
                try { entry.worker.onerror = null; } catch {}
                try { entry.worker.terminate?.(); } catch {}
                try { entry.cleanup?.(); } catch {}
            };
            const remainingDelay = () => Math.max(0, Number(armed?.dueAt || 0) - Date.now());
            const activateNextWorker = () => {
                disposeWorker();
                while (!destroyed && factoryIndex < factories.length) {
                    let entry = null;
                    try { entry = factories[factoryIndex++](); } catch {}
                    if (!entry?.worker) continue;
                    const worker = entry.worker;
                    activeWorker = entry;
                    worker.onmessage = (event) => {
                        if (activeWorker?.worker !== worker) return;
                        const message = event?.data || {};
                        if (message.type === 'ready') return;
                        if (message.type !== 'deadline') return;
                        const token = Number(message.token) || 0;
                        if (armed?.token === token) {
                            armed = null;
                            clearBackup();
                        }
                        onDeadline(token);
                    };
                    worker.onerror = () => {
                        if (destroyed || activeWorker?.worker !== worker) return;
                        // Worker construction can succeed and still fail asynchronously under
                        // file:// policy. Move to the next inline candidate and preserve the
                        // original absolute deadline rather than waiting for foreground recovery.
                        activateNextWorker();
                    };
                    if (armed) {
                        try {
                            worker.postMessage({ type: 'arm', delay: remainingDelay(), token: armed.token });
                        } catch {
                            disposeWorker();
                            continue;
                        }
                    }
                    return true;
                }
                return false;
            };

            activateNextWorker();
            if (activeWorker) {
                return {
                    mode: 'worker',
                    arm(delay, token) {
                        const safeDelay = Math.max(0, Number(delay) || 0);
                        armed = { token: Number(token) || 0, dueAt: Date.now() + safeDelay };
                        clearBackup();
                        // A page timer is only a safety net for environments where every inline
                        // worker fails silently. The worker remains authoritative in background.
                        backupTimer = setTimeout(() => {
                            backupTimer = 0;
                            if (!armed || armed.token !== (Number(token) || 0)) return;
                            armed = null;
                            onDeadline(Number(token) || 0);
                        }, safeDelay + 2000);

                        while (!destroyed) {
                            if (!activeWorker && !activateNextWorker()) break;
                            try {
                                activeWorker.worker.postMessage({ type: 'arm', delay: remainingDelay(), token: armed.token });
                                return;
                            } catch {
                                activateNextWorker();
                            }
                        }
                    },
                    cancel(token) {
                        const numericToken = Number(token) || 0;
                        if (armed && (!numericToken || armed.token === numericToken)) armed = null;
                        clearBackup();
                        try { activeWorker?.worker?.postMessage({ type: 'cancel', token: numericToken }); } catch {}
                    },
                    destroy() {
                        destroyed = true;
                        armed = null;
                        clearBackup();
                        disposeWorker();
                    }
                };
            }
        }

        let timer = 0;
        return {
            mode: 'page-timer',
            arm(delay, token) {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => {
                    timer = 0;
                    onDeadline(token);
                }, delay);
            },
            cancel() {
                if (timer) clearTimeout(timer);
                timer = 0;
            },
            destroy() {
                if (timer) clearTimeout(timer);
                timer = 0;
            }
        };
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
                let completionTimer = 0;
                let completionEpoch = 0;
                let completionDeadline = null;
                let completionScheduler = null;
                let lastPlayingObservedAt = 0;
                let runtimeFailureReported = false;
                let selectedItem = item;
                let lastPlayingPositionMs = 0;
                let lastDurationMs = 0;
                let lastPaused = true;
                const timer = setTimeout(() => finish(new Error('Spotify player did not become ready.')), READY_TIMEOUT_MS);
                const blockedMessage = 'Spotify playback needs a direct click in this browser. Use the visible Spotify play control, allow protected media, or localize this track for reliable one-click playback.';
                const clearStartTimer = () => {
                    if (startTimer) clearTimeout(startTimer);
                    startTimer = 0;
                };
                const clearCompletionTimer = () => {
                    if (completionTimer) completionScheduler?.cancel?.(completionTimer);
                    completionTimer = 0;
                    completionDeadline = null;
                    completionEpoch += 1;
                };
                const destroyCompletionScheduler = () => {
                    clearCompletionTimer();
                    completionScheduler?.destroy?.();
                    completionScheduler = null;
                };
                const resetCompletionEvidence = () => {
                    clearCompletionTimer();
                    lastPlayingPositionMs = 0;
                    lastDurationMs = 0;
                    lastPlayingObservedAt = 0;
                    lastPaused = true;
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
                    clearCompletionTimer();
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
                const markEnded = (durationMs = 0) => {
                    if (ended) return false;
                    clearStartTimer();
                    clearCompletionTimer();
                    ended = true;
                    started = false;
                    V.playback.paused = true;
                    const effectiveDurationMs = Math.max(0, Number(durationMs || lastDurationMs || 0));
                    if (effectiveDurationMs > 0) {
                        V.playback.duration = effectiveDurationMs / 1000;
                        V.playback.currentTime = V.playback.duration;
                    }
                    emitPlayback('Ended');
                    return true;
                };
                const handleCompletionDeadline = (token) => {
                    const deadline = completionDeadline;
                    if (!deadline || token !== deadline.epoch || token !== completionEpoch
                        || !started || ended || lastPaused) return;
                    completionTimer = 0;
                    completionDeadline = null;
                    const elapsedMs = Math.max(0, Date.now() - deadline.observedAt);
                    const projectedPositionMs = deadline.positionMs + elapsedMs;
                    const stillRemainingMs = deadline.durationMs - projectedPositionMs;
                    // Dedicated-worker deadlines remain available when normal page timers are
                    // heavily throttled by a minimized/backgrounded renderer. If the deadline
                    // arrives early, project from the last authoritative Spotify sample and re-arm.
                    if (stillRemainingMs > END_TOLERANCE_MS) {
                        scheduleCompletionWatchdog(projectedPositionMs, deadline.durationMs);
                        return;
                    }
                    if (markEnded(deadline.durationMs)) emitProgress();
                };
                const ensureCompletionScheduler = () => {
                    if (!completionScheduler) completionScheduler = createCompletionScheduler(handleCompletionDeadline);
                    return completionScheduler;
                };
                const scheduleCompletionWatchdog = (positionMs, durationMs) => {
                    clearCompletionTimer();
                    const effectivePositionMs = Math.max(0, Number(positionMs) || 0);
                    const effectiveDurationMs = Math.max(0, Number(durationMs) || 0);
                    if (!started || ended || lastPaused || effectiveDurationMs <= 0) return;
                    const epoch = completionEpoch;
                    const observedAt = Date.now();
                    lastPlayingObservedAt = observedAt;
                    const remainingMs = Math.max(0, effectiveDurationMs - effectivePositionMs);
                    completionDeadline = {
                        epoch,
                        observedAt,
                        positionMs: effectivePositionMs,
                        durationMs: effectiveDurationMs
                    };
                    completionTimer = epoch;
                    ensureCompletionScheduler().arm(Math.max(50, remainingMs + endWatchdogGraceMs()), epoch);
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
                            clearCompletionTimer();
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
                            clearCompletionTimer();
                            lastPaused = true;
                            return controller.pause?.();
                        },
                        setCurrentTime: (seconds) => {
                            clearCompletionTimer();
                            return controller.seek?.(Math.max(0, Number(seconds) || 0));
                        },
                        setVolume: (volume) => controller.setVolume?.(Math.max(0, Math.min(1, Number(volume) || 0))),
                        destroy: () => {
                            clearStartTimer();
                            destroyCompletionScheduler();
                            return controller.destroy?.();
                        },
                        loadItem: async (nextItem) => {
                            const nextId = spotifyTrackId(nextItem?.url);
                            if (!nextId) throw new Error('This Spotify link does not contain a playable track ID.');
                            const load = typeof controller.loadUri === 'function'
                                ? controller.loadUri.bind(controller)
                                : typeof controller.loadEntity === 'function'
                                    ? controller.loadEntity.bind(controller)
                                    : null;
                            if (!load) throw new Error('The Spotify player cannot switch tracks in this browser.');
                            selectedItem = nextItem;
                            ended = false;
                            started = false;
                            runtimeFailureReported = false;
                            resetCompletionEvidence();
                            clearStartTimer();
                            setStageStatus(`Loading ${nextItem.title || 'the next Spotify track'}...`);
                            await Promise.resolve(load(`spotify:track:${nextId}`));
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
                        ended = false;
                        V.playback.paused = false;
                        emitPlayback(`Playing ${selectedItem.title || 'Spotify track'} with Spotify`);
                        emitProgress();
                    });
                    controller.addListener?.('playback_update', (event) => {
                        const data = event?.data || event || {};
                        const playingId = spotifyTrackId(data.playingURI);
                        if (playingId && playingId !== spotifyTrackId(selectedItem?.url)) return;
                        const positionMs = Math.max(0, Number(data.position || 0));
                        const durationMs = Math.max(0, Number(data.duration || 0));
                        const paused = data.isPaused !== false;
                        const effectiveDurationMs = durationMs || lastDurationMs;
                        const previousNearEnd = lastDurationMs > 0
                            && lastPlayingPositionMs >= Math.max(0, lastDurationMs - END_TOLERANCE_MS);
                        const atEnd = effectiveDurationMs > 0
                            && positionMs >= Math.max(0, effectiveDurationMs - END_TOLERANCE_MS);
                        // Spotify has no dedicated ended event. In real embeds the terminal update can
                        // arrive slightly before duration, or rewind position to zero as it becomes
                        // paused. Preserve the prior playing edge so both forms produce one Ended.
                        const resetAfterEnd = started && paused && lastPaused === false
                            && previousNearEnd && positionMs <= END_RESET_MAX_MS;

                        V.playback.currentTime = positionMs / 1000;
                        V.playback.duration = effectiveDurationMs / 1000;
                        V.playback.paused = paused;

                        if (!paused) {
                            if (!started) markStarted();
                            ended = false;
                            lastPlayingPositionMs = positionMs;
                            if (durationMs > 0) lastDurationMs = durationMs;
                            lastPaused = false;
                            scheduleCompletionWatchdog(positionMs, effectiveDurationMs);
                            emitPlayback(`Playing ${selectedItem.title || 'Spotify track'} with Spotify`);
                        } else {
                            clearCompletionTimer();
                            if ((atEnd || resetAfterEnd) && !ended) markEnded(effectiveDurationMs);
                            if (positionMs > 0) lastPlayingPositionMs = positionMs;
                            if (durationMs > 0) lastDurationMs = durationMs;
                            lastPaused = true;
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