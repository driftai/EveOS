window.EveAudioflixSpotifyStatusWatch = window.EveAudioflixSpotifyStatusWatch || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixSpotifyStatusWatch;
    if (ns.ready) return;

    const STATUS_WATCH_MS = 12000;
    const STATUS_WATCH_TIMEOUT_MS = STATUS_WATCH_MS + 4000;
    const PROGRESS_POLL_MS = 1000;
    const DEGRADED_RECOVERY_PROBE_MS = 2500;

    function watchCursor(result) {
        const marker = result?.watchCursor || {};
        const engine = result?.engine || {};
        return {
            afterCursor: Math.max(0, Number(marker.eventCursor ?? engine.eventCursor ?? 0) || 0),
            afterOwnerEpoch: Math.max(0, Number(marker.ownerEpoch ?? result?.ownerEpoch ?? 0) || 0),
            afterEngineEpoch: Math.max(0, Number(marker.engineEpoch ?? result?.engineEpoch ?? 0) || 0),
            afterTrackGeneration: Math.max(0, Number(marker.trackGeneration ?? result?.trackGeneration ?? engine.generation ?? 0) || 0)
        };
    }

    function isCurrentState(result, ...previousStates) {
        const marker = watchCursor(result);
        for (const previous of previousStates) {
            if (!previous) continue;
            // Broker counters are scoped to its client grant, not a permanent server identity.
            if (result?.clientId && previous.clientId && result.clientId !== previous.clientId) continue;
            const before = watchCursor(previous);
            for (const key of ['afterEngineEpoch', 'afterOwnerEpoch', 'afterTrackGeneration', 'afterCursor']) {
                if (marker[key] < before[key]) return false;
                if (marker[key] > before[key]) break;
            }
        }
        return true;
    }

    function create({ remote, applyState, isActive, currentRun, isEnded, onRecovery = () => {} }) {
        let pollTimer = 0;
        let pollFlight = null;
        let watchToken = 0;
        let watchFlight = null;
        let retryTimer = 0;
        let retryResolve = null;
        let recoveryTimer = 0;
        let recoveryFlight = null;
        let failures = 0;
        let recovery = 'stopped';
        let latest = null;
        let runner = null;
        let request = null;
        let suspendedRun = null;

        function launchWatch() {
            if (runner || !request) return;
            const next = request;
            runner = watchLoop(next.run, next.seed, next.token).finally(() => {
                runner = null;
                if (request && request !== next) launchWatch();
            });
        }

        function report(value, detail = {}) {
            if (recovery === value && !detail.result) return;
            recovery = value;
            onRecovery({ state: value, failures, ...detail });
        }

        function cancelDelay() {
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = 0;
            const resolve = retryResolve;
            retryResolve = null;
            resolve?.();
        }

        function cancelRecoveryProbe() {
            if (recoveryTimer) clearTimeout(recoveryTimer);
            recoveryTimer = 0;
        }

        function isAuthoritativeIdleRestart(result) {
            if (!latest || !result?.ok || result?.managed?.helperReachable !== true
                || result.isOwner === true || String(result.ownerClientId || '')) return false;
            const before = watchCursor(latest);
            const marker = watchCursor(result);
            const engine = result.engine || {};
            const status = String(engine.status || '').toLowerCase();
            const generation = Number(engine.generation ?? -1);
            return marker.afterEngineEpoch > before.afterEngineEpoch
                && generation === 0
                && (status === 'stopped' || status === 'idle');
        }

        function scheduleRecoveryProbe(run, token) {
            if (recoveryTimer || recoveryFlight || recovery !== 'degraded'
                || run !== currentRun() || token !== watchToken || !isActive()) return;
            recoveryTimer = setTimeout(async () => {
                recoveryTimer = 0;
                if (recovery !== 'degraded' || run !== currentRun() || token !== watchToken || !isActive()) return;
                let result = null;
                try {
                    recoveryFlight = remote().status();
                    result = await recoveryFlight;
                } catch {}
                finally { recoveryFlight = null; }
                if (recovery !== 'degraded' || run !== currentRun() || token !== watchToken || !isActive()) return;
                if (!result?.ok || result?.managed?.helperReachable === false || !isCurrentState(result, latest)) {
                    scheduleRecoveryProbe(run, token);
                    return;
                }
                if (isAuthoritativeIdleRestart(result)) {
                    latest = result;
                    report('reset', { result });
                    return;
                }
                // The same helper recovered without proving playback loss. Re-observe it; never
                // create a Play/Resume intent from recovery.
                start(result);
            }, DEGRADED_RECOVERY_PROBE_MS);
        }

        function accept(result, run, token) {
            if (run !== currentRun() || token !== watchToken || !isActive() || !result?.ok
                || recovery === 'degraded' || result?.managed?.helperReachable === false) return false;
            if (!isCurrentState(result, latest)) return false;
            latest = result;
            applyState(result);
            return true;
        }

        function stop() {
            watchToken += 1;
            request = null;
            suspendedRun = null;
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = 0;
            cancelDelay();
            cancelRecoveryProbe();
            report('stopped');
        }

        async function progressOnce(run = currentRun()) {
            if (!isActive() || pollFlight || !remote()?.snapshot?.().connected) return;
            const token = watchToken;
            const finish = window.EveAudioflixDiagnostics?.span?.('spotify:progress-status');
            pollFlight = remote().status();
            try {
                const result = await pollFlight;
                accept(result, run, token);
                finish?.(!result?.ok);
            } catch (error) {
                finish?.(true);
                throw error;
            } finally {
                pollFlight = null;
            }
        }

        async function watchLoop(run, seed, token) {
            let cursor = watchCursor(seed);
            while (isActive() && run === currentRun() && token === watchToken) {
                // A restarted observer waits out the previous bounded request; it never overlaps it.
                if (watchFlight) {
                    await watchFlight.catch(() => {});
                    continue;
                }
                const finish = window.EveAudioflixDiagnostics?.span?.('spotify:status-watch');
                let result;
                try {
                    watchFlight = remote().send('status-watch', { ...cursor, waitMs: STATUS_WATCH_MS },
                        { timeout: STATUS_WATCH_TIMEOUT_MS });
                    result = await watchFlight;
                    finish?.(!result?.ok && !result?.watchTimedOut);
                } catch (error) {
                    finish?.(true);
                    result = { ok: false };
                } finally {
                    watchFlight = null;
                }
                if (run !== currentRun() || token !== watchToken || !isActive()) return;
                if (!result?.ok || result?.managed?.helperReachable === false) {
                    failures += 1;
                    report(failures >= 5 ? 'degraded' : 'reconnecting');
                    if (failures >= 5 || result?.approvalRequired || result?.disconnected) {
                        if (pollTimer) clearInterval(pollTimer);
                        pollTimer = 0;
                        report('degraded');
                        if (!result?.approvalRequired && !result?.disconnected) scheduleRecoveryProbe(run, token);
                        return;
                    }
                    await new Promise((resolve) => {
                        retryResolve = resolve;
                        retryTimer = setTimeout(() => {
                            retryTimer = 0;
                            retryResolve = null;
                            resolve();
                        }, Math.min(4000, 250 * 2 ** (failures - 1)));
                    });
                    continue;
                }
                failures = 0;
                report('watching');
                if (!accept(result, run, token)) continue;
                // Ended is a durable observation, not the observer's lifetime boundary. Repeat
                // can restart this same item/run without calling start(); keep the bounded watch
                // alive so Playing and its next Ended reach the queue even while the page is hidden.
                if (!isActive() || result.watchSupported !== true) return;
                cursor = watchCursor(result);
            }
        }

        function start(seed) {
            stop();
            const run = currentRun();
            const token = ++watchToken;
            failures = 0;
            latest = seed;
            report('watching');
            request = { run, seed, token };
            launchWatch();
            // This timer is presentation-only. The watch delivers completion to the canonical
            // frontend queue owner; a frozen page must resume before its callbacks can run.
            pollTimer = setInterval(() => {
                if (document.visibilityState === 'hidden') return;
                progressOnce(run).catch(() => {});
            }, PROGRESS_POLL_MS);
            if (document.visibilityState !== 'hidden') progressOnce(run).catch(() => {});
        }

        function suspend() {
            if (!request || !isActive() || recovery === 'degraded') return;
            const run = currentRun();
            stop();
            suspendedRun = run;
            report('suspended');
        }

        function resume() {
            const run = suspendedRun;
            suspendedRun = null;
            if (run !== null && run === currentRun() && isActive()) start(latest);
        }

        function visible() {
            if (document.visibilityState === 'visible' && request && recovery !== 'degraded') {
                progressOnce().catch(() => {});
            }
        }

        document.addEventListener?.('freeze', suspend);
        document.addEventListener?.('resume', resume);
        document.addEventListener?.('visibilitychange', visible);
        function dispose() {
            stop();
            document.removeEventListener?.('freeze', suspend);
            document.removeEventListener?.('resume', resume);
            document.removeEventListener?.('visibilitychange', visible);
        }

        return { start, stop, suspend, resume, dispose, progressOnce, diagnostics: () => ({
            state: recovery, failures, watchRequests: Number(Boolean(watchFlight)),
            watchJobs: Number(Boolean(runner)), progressRequests: Number(Boolean(pollFlight)),
            retryTimers: Number(Boolean(retryTimer)), progressTimers: Number(Boolean(pollTimer)),
            recoveryRequests: Number(Boolean(recoveryFlight)), recoveryTimers: Number(Boolean(recoveryTimer))
        }) };
    }

    Object.assign(ns, { ready: true, create, watchCursor, isCurrentState });
})();
