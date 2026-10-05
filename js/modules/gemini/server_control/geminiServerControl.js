(function () {
    'use strict';
    const runtime = window.GeminiServerControlRuntime = window.GeminiServerControlRuntime || {};
    const stateApi = runtime.stateApi;
    const connectionApi = runtime.connectionApi;
    if (!stateApi || !connectionApi) {
        console.warn('[GeminiServerControl] Runtime helpers missing; controller not initialized.');
        return;
    }
    const {
        POLL_MS,
        RECOVERY_MIN_INTERVAL_MS,
        STATUS_GRACE_MS,
        state,
        findController,
        checkDirectServerStatus,
        publish,
        readDesiredServerState,
        setDesiredServerState,
        setManualStop,
        isManualStopActive,
        setConnectionPreference,
        isConnectionPreferenceEnabled,
        shouldAutoRecoverDisabledConnection,
        syncCredentials
    } = stateApi;
    const {
        reconcileClientConnection,
        bootWorkspaceForConnection,
        connectWhenWorkspaceReady,
        disconnectClient
    } = connectionApi;
    const SERVER_TOGGLE_SELECTOR = '[data-gemini-server-toggle]';
    let recoveryPromise = null;
    let refreshPromise = null;
    let controlsBound = false;

    function isSessionAuthorized() {
        return window.__EVE_GEMINI_SESSION_AUTHORIZED === true;
    }

    function setSessionAuthorized(enabled) {
        window.__EVE_GEMINI_SESSION_AUTHORIZED = !!enabled;
        if (enabled) window.__EVE_GEMINI_PASSIVE_BOOT = false;
    }

    function shouldPollLifecycle() {
        if (!isSessionAuthorized()) return false;
        if (state.busy || state.running || state.desiredRunning || recoveryPromise) return true;
        const provider = document.querySelector('[data-ai-provider="gemini"]');
        return !!window.__GEMINI_BOOT_REQUESTED
            || provider?.open === true
            || ['requesting', 'requested', 'recovering', 'reconnecting'].includes(state.connectionPhase);
    }

    function disableForStoppedHost(message) {
        setSessionAuthorized(false);
        setDesiredServerState(false);
        setConnectionPreference(false);
        setManualStop(true);
        disconnectClient();
        state.hostRunning = false;
        state.running = false;
        state.serverState = 'manual-stop';
        state.connectionPhase = 'manual-stop';
        state.message = message || 'EveOS localhost was stopped; Gemini Live Link is disabled.';
    }

    async function recoverServerIfNeeded(reason) {
        if (!isSessionAuthorized()) return false;
        if (isManualStopActive()) return false;
        if (state.hostRequired && state.hostRunning !== true) return false;
        if (!state.desiredRunning || state.running || state.busy || recoveryPromise) return false;
        if (!state.controllerAvailable || !state.baseUrl) return false;
        const now = Date.now();
        if (now - (state.lastRecoveryAttemptAt || 0) < RECOVERY_MIN_INTERVAL_MS) return false;

        state.lastRecoveryAttemptAt = now;
        state.recoveryAttempts += 1;
        state.serverState = 'recovering';
        state.connectionPhase = 'recovering';
        state.message = `Gemini connection dropped; recovery attempt ${state.recoveryAttempts} is starting.`;
        setConnectionPreference(true);
        publish();

        recoveryPromise = (async function () {
            try {
                await syncCredentials({ force: true });
                const payload = await window.GeminiServerNetwork.fetchJson(`${state.baseUrl}/api/gemini-server/start`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reason: reason || 'auto-recovery' })
                }, 5000);

                state.running = !!payload.running;
                state.serverState = payload.state || (state.running ? 'running' : 'recovering');
                state.message = payload.message || state.message;

                if (!state.running && state.serverState !== 'error') {
                    await window.GeminiServerNetwork.waitForServerReady({
                        timeoutMs: 45000,
                        refreshStatus,
                        isRunning: function () { return state.running; },
                        isError: function () { return state.serverState === 'error'; },
                        onEarlyExit: function () {
                            state.serverState = 'recovering';
                            state.connectionPhase = 'recovering';
                            state.message = 'Gemini server exited during recovery. EveOS will retry.';
                            publish();
                        }
                    });
                }

                if (state.running) {
                    state.lastKnownRunningAt = Date.now();
                    state.statusFailureCount = 0;
                    state.recoveryAttempts = 0;
                    connectWhenWorkspaceReady(bootWorkspaceForConnection());
                    return true;
                }
            } catch (error) {
                state.serverState = 'recovering';
                state.connectionPhase = 'recovering';
                state.message = `Gemini recovery is still retrying: ${error?.message || 'status unavailable'}`;
                console.warn('[GeminiServerControl] Auto-recovery failed:', error);
            } finally {
                recoveryPromise = null;
                publish();
            }
            return false;
        })();

        return recoveryPromise;
    }

    async function performRefreshStatus() {
        state.desiredRunning = isSessionAuthorized() ? readDesiredServerState() : false;
        if (isSessionAuthorized() && isManualStopActive()) state.desiredRunning = false;
        const found = await findController();
        if (found) {
            state.controllerAvailable = true;
            state.hostFailureCount = 0;
            state.hostRunning = !state.hostRequired
                || found.baseUrl === window.location.origin
                || found.payload.hostRunning === true;
            if (state.hostRequired && !state.hostRunning) {
                disableForStoppedHost('EveOS localhost was closed; Gemini Live Link and auto-reconnect are disabled.');
                publish();
                if (isSessionAuthorized()) reconcileClientConnection();
                return { ...state };
            }
            state.running = !!found.payload.running;
            state.serverState = found.payload.state || (state.running ? 'running' : 'stopped');
            state.message = found.payload.message || `Gemini server is ${state.serverState}.`;
            state.statusFailureCount = 0;
            if (state.running) {
                state.lastKnownRunningAt = Date.now();
                state.recoveryAttempts = 0;
                if (isSessionAuthorized() && isConnectionPreferenceEnabled() && !isManualStopActive()) {
                    setDesiredServerState(true);
                }
            } else if (state.desiredRunning && state.serverState !== 'starting' && state.serverState !== 'recovering') {
                state.serverState = 'recovering';
                state.message = 'Gemini should be running; EveOS is restarting it.';
            }
        } else {
            state.controllerAvailable = false;
            if (state.hostRequired) {
                state.hostFailureCount += 1;
                if (state.hostFailureCount >= 2) {
                    disableForStoppedHost('EveOS localhost is offline; Gemini Live Link will stay disabled until you start it again.');
                    publish();
                    if (isSessionAuthorized()) reconcileClientConnection();
                    return { ...state };
                }
            }
            state.running = await checkDirectServerStatus();
            state.statusFailureCount += 1;
            if (state.running) {
                state.serverState = 'running';
                state.lastKnownRunningAt = Date.now();
                state.statusFailureCount = 0;
                if (isSessionAuthorized() && isConnectionPreferenceEnabled() && !isManualStopActive()) {
                    setDesiredServerState(true);
                }
                state.message = 'Gemini is online; lifecycle controller is unavailable.';
            } else if (state.desiredRunning && Date.now() - (state.lastKnownRunningAt || 0) < STATUS_GRACE_MS) {
                state.serverState = 'reconnecting';
                state.message = 'Gemini status check missed; keeping reconnect active.';
            } else {
                state.serverState = state.desiredRunning ? 'recovering' : 'stopped';
                state.message = state.desiredRunning
                    ? 'Gemini should be running, but the lifecycle controller is unavailable.'
                    : 'Gemini is offline. Start tools\\batch\\start-gemini-control.bat or an EveOS local preview port to enable in-page startup from file://.';
            }
        }
        if (isSessionAuthorized() && state.running && !isManualStopActive()
            && shouldAutoRecoverDisabledConnection() && !isConnectionPreferenceEnabled()) {
            setConnectionPreference(true);
            state.connectionPhase = 'requesting';
            state.message = 'Gemini server is online; reconnecting Live Workspace.';
            if (typeof window.updateConnectionStatus === 'function') {
                window.updateConnectionStatus('connecting', 'Gemini server online - reconnecting...');
            }
        }
        if (isSessionAuthorized() && isManualStopActive()) {
            state.desiredRunning = false;
            state.serverState = 'manual-stop';
            state.connectionPhase = 'manual-stop';
            if (state.running) {
                state.message = 'Assistant stopped by you. The Gemini backend process is still up; press Start to reconnect.';
            }
        } else if (!isSessionAuthorized()) {
            state.desiredRunning = false;
            state.connectionPhase = 'passive';
            state.message = state.running
                ? 'Gemini backend is online, but this EveOS page is passive. Use Start or Connect to opt in.'
                : 'Gemini Link is passive on this EveOS page until you explicitly Start or Connect.';
        }
        publish();
        if (isSessionAuthorized()) reconcileClientConnection();
        if (isSessionAuthorized() && state.desiredRunning && !state.running && state.controllerAvailable) {
            recoverServerIfNeeded('status-refresh');
        }
        return { ...state };
    }

    function refreshStatus() {
        if (refreshPromise) return refreshPromise;
        refreshPromise = performRefreshStatus().finally(function () {
            refreshPromise = null;
        });
        return refreshPromise;
    }

    async function toggleServer() {
        const shouldStart = !(state.running || state.desiredRunning || state.serverState === 'recovering');
        if (state.busy) return;
        if (shouldStart) {
            setSessionAuthorized(true);
            setManualStop(false);
        }
        if (!shouldStart && !state.controllerAvailable) {
            setSessionAuthorized(false);
            setManualStop(true);
            setDesiredServerState(false);
            setConnectionPreference(false);
            disconnectClient();
            state.running = false;
            state.serverState = 'stopped';
            state.message = 'Gemini auto-recovery stopped for this browser.';
            publish();
            return;
        }
        if (!state.controllerAvailable || !state.baseUrl) return;
        state.busy = true;
        state.serverState = shouldStart ? 'starting' : 'stopping';
        state.message = shouldStart ? 'Starting Gemini server...' : 'Stopping Gemini server...';
        if (!shouldStart) {
            setSessionAuthorized(false);
            setManualStop(true);
        }
        setDesiredServerState(shouldStart);
        publish();
        let workspacePromise = null;

        try {
            workspacePromise = shouldStart
                ? (setConnectionPreference(true), bootWorkspaceForConnection())
                : null;
            if (shouldStart) {
                await syncCredentials({ force: true });
            }
            const payload = await window.GeminiServerNetwork.fetchJson(`${state.baseUrl}/api/gemini-server/${shouldStart ? 'start' : 'stop'}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
            }, 5000);
            state.running = !!payload.running;
            state.serverState = payload.state || (state.running ? 'running' : 'stopped');
            state.message = payload.message || state.message;

            if (shouldStart && !state.running && state.serverState !== 'error') {
                await window.GeminiServerNetwork.waitForServerReady({
                    timeoutMs: 45000,
                    refreshStatus,
                    isRunning: function () { return state.running; },
                    isError: function () { return state.serverState === 'error'; },
                    onEarlyExit: function () {
                        state.serverState = 'error';
                        state.message = 'Gemini server exited before becoming ready.';
                        state.connectionPhase = 'error';
                        publish();
                    }
                });
            }
            if (shouldStart && state.running) {
                connectWhenWorkspaceReady(workspacePromise);
            } else if (!shouldStart) {
                setSessionAuthorized(false);
                setManualStop(true);
                setDesiredServerState(false);
                setConnectionPreference(false);
                disconnectClient();
            }
        } catch (error) {
            state.serverState = 'error';
            state.message = error.message || 'Gemini server control failed.';
            state.connectionPhase = 'error';
            if (!shouldStart) setDesiredServerState(false);
            console.warn('[GeminiServerControl] Lifecycle action failed:', error);
        } finally {
            state.busy = false;
            await refreshStatus();
            if (shouldStart && state.running
                && state.connectionPhase !== 'requested'
                && state.connectionPhase !== 'requesting') {
                connectWhenWorkspaceReady(workspacePromise);
            }
        }
    }

    function handleServerToggleClick(event) {
        const button = event?.target?.closest?.(SERVER_TOGGLE_SELECTOR);
        if (!button || !document.contains(button)) return;
        toggleServer();
    }

    function bindControls(root) {
        if (!controlsBound) {
            (root || document).addEventListener('click', handleServerToggleClick);
            controlsBound = true;
        }
        publish();
    }

    function initialize() {
        state.desiredRunning = isSessionAuthorized() ? readDesiredServerState() : false;
        bindControls(document);
        refreshStatus();
        window.setInterval(function () {
            if (document.visibilityState === 'visible' && shouldPollLifecycle()) {
                refreshStatus();
            }
        }, POLL_MS);
        window.addEventListener('eve:gemini-workspace-ready', function () {
            if (!isSessionAuthorized()) return;
            refreshStatus();
            reconcileClientConnection();
        });
        window.addEventListener('eve:gemini-socket-ready', function () {
            if (isSessionAuthorized()) reconcileClientConnection();
        });
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible' && shouldPollLifecycle()) refreshStatus();
        });
    }

    window.GeminiServerControl = {
        getState: function () { return { ...state }; },
        refreshStatus,
        syncCredentials,
        reconcileClientConnection,
        toggleServer,
        start: async function () {
            if (state.running && isSessionAuthorized()) return { ...state };
            if (state.running && !isSessionAuthorized()) {
                setSessionAuthorized(true);
                setManualStop(false);
                setDesiredServerState(true);
                setConnectionPreference(true);
                await refreshStatus();
                reconcileClientConnection();
                return { ...state };
            }
            await toggleServer();
            return { ...state };
        },
        stop: async function () {
            if (!state.running) return { ...state };
            await toggleServer();
            return { ...state };
        },
        setClientLink: function (connected) {
            if (connected) {
                setSessionAuthorized(true);
                if (window.SocketGlobalState) {
                    window.SocketGlobalState.sessionOwnershipTransferred = false;
                    window.SocketGlobalState.sessionOwnershipTransferReason = '';
                    window.SocketGlobalState.serverOfflinePauseActive = false;
                }
                setManualStop(false);
                if (state.hostRequired) {
                    state.hostRunning = true;
                    state.hostFailureCount = 0;
                }
                setDesiredServerState(true);
                setConnectionPreference(true);
                refreshStatus().then(reconcileClientConnection).catch(() => {});
            } else {
                setSessionAuthorized(false);
                setManualStop(true);
                setDesiredServerState(false);
                setConnectionPreference(false);
                disconnectClient();
            }
            publish();
            return { ...state };
        },
        isClientLinked: function () {
            return !!(window.webSocket && window.webSocket.readyState === WebSocket.OPEN);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
