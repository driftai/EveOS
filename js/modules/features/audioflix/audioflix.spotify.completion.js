window.EveAudioflixSpotifyCompletion = window.EveAudioflixSpotifyCompletion || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixSpotifyCompletion;
    if (ns.ready) return;
    const END_WATCHDOG_GRACE_MS = 1250;

    function endWatchdogGraceMs() {
        const override = Number(window.__EveAudioflixSpotifyEndWatchdogGraceMs);
        return Number.isFinite(override) && override >= 0 ? override : END_WATCHDOG_GRACE_MS;
    }

    function itemDurationMs(item) {
        // Audioflix stores library durations in seconds; Spotify reports milliseconds.
        const seconds = Math.max(0, Number(item?.resolvedDuration || item?.duration || 0));
        return seconds > 0 ? seconds * 1000 : 0;
    }

    function createScheduler(onDeadline) {
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

            // Blob workers keep the completion deadline alive for standalone file:// pages.
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

    Object.assign(ns, { ready: true, endWatchdogGraceMs, itemDurationMs, createScheduler });
})();
