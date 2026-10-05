(function () {
    'use strict';
    const runtime = window.GeminiServerControlRuntime = window.GeminiServerControlRuntime || {};
    if (runtime.connectionApi) return;
    const stateApi = runtime.stateApi;
    if (!stateApi) throw new Error('[GeminiServerControl] State runtime missing.');
    const {
        state,
        publish,
        isManualStopActive,
        setConnectionPreference,
        isConnectionPreferenceEnabled,
        clearMissingCredentialGateIfVaultReady,
        shouldAutoRecoverDisabledConnection
    } = stateApi;
    let reconcilePromise = null;

    function sessionAuthorized() {
        return window.__EVE_GEMINI_SESSION_AUTHORIZED === true;
    }

    function connectClient() {
        if (!sessionAuthorized()) return;
        if (window.SocketGlobalState?.credentialRequired && !clearMissingCredentialGateIfVaultReady()) {
            state.connectionPhase = 'credentials-required';
            publish();
            return;
        }
        if (window.webSocket?.readyState === WebSocket.OPEN) {
            state.connectionPhase = 'connected';
            publish();
            return;
        }
        if (window.webSocket?.readyState === WebSocket.CONNECTING || window.SocketGlobalState?.isConnecting) {
            state.connectionPhase = 'requesting';
            publish();
            return;
        }
        state.connectionPhase = 'requesting';
        publish();
        if (typeof window.updateConnectionStatus === 'function') {
            window.updateConnectionStatus('connecting', 'Connecting to Gemini...');
        }
        let attempts = 0;
        const requestConnection = function () {
            if (!sessionAuthorized()) return;
            attempts += 1;
            if (window.webSocket?.readyState === WebSocket.OPEN
                || window.webSocket?.readyState === WebSocket.CONNECTING
                || window.SocketGlobalState?.isConnecting) {
                state.connectionPhase = window.webSocket?.readyState === WebSocket.OPEN
                    ? 'connected'
                    : 'requesting';
                publish();
                return;
            }
            const core = window.SocketConnectionCore;
            if (typeof core?.connect === 'function') {
                state.connectionPhase = 'requested';
                publish();
                core.connect();
                window.dispatchEvent(new CustomEvent('eve:gemini-connect-requested'));
                return;
            }
            if (typeof window.connect === 'function') {
                state.connectionPhase = 'requested';
                publish();
                window.connect();
                window.dispatchEvent(new CustomEvent('eve:gemini-connect-requested'));
                return;
            }
            if (attempts < 40) {
                window.setTimeout(requestConnection, 150);
            } else {
                state.connectionPhase = 'unavailable';
                publish();
            }
        };
        window.setTimeout(requestConnection, 100);
    }

    async function reconcileClientConnection() {
        if (!sessionAuthorized()) {
            state.desiredRunning = false;
            state.connectionPhase = 'passive';
            publish();
            return false;
        }
        if (isManualStopActive()) {
            state.desiredRunning = false;
            state.connectionPhase = 'manual-stop';
            if (window.webSocket && window.webSocket.readyState < WebSocket.CLOSING) {
                disconnectClient();
            }
            publish();
            return false;
        }
        if (window.SocketGlobalState?.sessionOwnershipTransferred) {
            state.connectionPhase = 'ownership-transferred';
            state.message = 'Gemini is active in another EveOS window. Click the connection status here to reclaim it.';
            if (typeof window.updateConnectionStatus === 'function') {
                window.updateConnectionStatus('disconnected', 'Active in Another EveOS Window');
            }
            publish();
            return false;
        }
        if (!state.running) {
            if (!window.webSocket || window.webSocket.readyState >= WebSocket.CLOSING) {
                state.connectionPhase = state.desiredRunning ? 'recovering' : 'offline';
                if (typeof window.updateConnectionStatus === 'function') {
                    window.updateConnectionStatus(
                        state.desiredRunning ? 'waiting' : 'disconnected',
                        state.desiredRunning ? 'Gemini Recovering...' : 'Gemini Server Offline'
                    );
                }
                publish();
            }
            return false;
        }
        if (!isConnectionPreferenceEnabled()) {
            if (!shouldAutoRecoverDisabledConnection()) return false;
            setConnectionPreference(true);
        }
        if (window.SocketGlobalState?.credentialRequired && !clearMissingCredentialGateIfVaultReady()) {
            state.connectionPhase = 'credentials-required';
            publish();
            return false;
        }
        if (window.webSocket?.readyState === WebSocket.OPEN) {
            state.connectionPhase = window.SocketGlobalState?.geminiApiReady ? 'connected' : 'initializing';
            publish();
            return true;
        }
        if (window.webSocket?.readyState === WebSocket.CONNECTING || window.SocketGlobalState?.isConnecting) {
            return false;
        }

        const root = document.getElementById('gemini-ui-root');
        const shouldBoot = !!window.__GEMINI_BOOT_REQUESTED
            || root?.dataset.geminiMonitorView === 'full'
            || state.connectionPhase === 'requesting'
            || state.connectionPhase === 'requested';
        if (!shouldBoot) return false;
        if (reconcilePromise) return reconcilePromise;

        reconcilePromise = (async function () {
            const ready = await ensureWorkspaceReady();
            if (ready && sessionAuthorized() && state.running && isConnectionPreferenceEnabled()) {
                connectClient();
                return true;
            }
            return false;
        })().finally(function () {
            reconcilePromise = null;
        });
        return reconcilePromise;
    }

    function waitForWindowEvent(eventName, readyCheck, timeoutMs) {
        if (readyCheck()) return Promise.resolve(true);
        return new Promise(function (resolve) {
            let settled = false;
            const finish = function (ready) {
                if (settled) return;
                settled = true;
                window.removeEventListener(eventName, onReady);
                window.clearInterval(pollTimer);
                window.clearTimeout(timeoutTimer);
                resolve(ready);
            };
            const onReady = function () {
                finish(readyCheck());
            };
            const pollTimer = window.setInterval(function () {
                if (readyCheck()) finish(true);
            }, 150);
            const timeoutTimer = window.setTimeout(function () {
                finish(readyCheck());
            }, timeoutMs || 45000);
            window.addEventListener(eventName, onReady);
        });
    }

    function bootWorkspaceForConnection() {
        if (!sessionAuthorized()) return Promise.resolve(false);
        return ensureWorkspaceReady().catch(function (error) {
            state.connectionPhase = 'workspace-error';
            state.message = error?.message || 'Gemini workspace boot failed.';
            publish();
            console.warn('[GeminiServerControl] Workspace boot failed:', error);
            return false;
        });
    }

    function connectWhenWorkspaceReady(workspacePromise) {
        if (!sessionAuthorized()) return;
        Promise.resolve(workspacePromise).then(function (ready) {
            if (ready && sessionAuthorized() && state.running && isConnectionPreferenceEnabled()) {
                connectClient();
            }
        }).catch(function (error) {
            state.connectionPhase = 'workspace-error';
            state.message = error?.message || 'Gemini workspace boot failed.';
            publish();
            console.warn('[GeminiServerControl] Deferred workspace connect failed:', error);
        });
    }

    async function ensureWorkspaceReady() {
        if (!sessionAuthorized()) return false;
        state.connectionPhase = 'booting';
        publish();
        window.__GEMINI_BOOT_REQUESTED = true;

        let trigger = window.__loadGeminiScriptsNow;
        if (typeof trigger !== 'function') {
            await waitForWindowEvent('eve:gemini-loader-ready', function () {
                return typeof window.__loadGeminiScriptsNow === 'function';
            }, 8000);
            trigger = window.__loadGeminiScriptsNow;
        }

        if (typeof trigger !== 'function') {
            state.connectionPhase = 'loader-unavailable';
            state.message = 'Gemini server is online, but the workspace loader is not ready yet.';
            publish();
            return false;
        }

        if (typeof trigger === 'function') {
            await trigger();
        }

        const workspaceReady = await waitForWindowEvent('eve:gemini-workspace-ready', function () {
            return !!window.__GEMINI_WORKSPACE_READY
                && !!document.getElementById('textInput')
                && !!document.getElementById('sendButton')
                && typeof window.sendTextMessage === 'function';
        }, 45000);

        if (!workspaceReady) {
            state.connectionPhase = 'workspace-timeout';
            state.message = 'Gemini server is online, but the workspace did not finish loading yet.';
            publish();
            return false;
        }

        const socketReady = await waitForWindowEvent('eve:gemini-socket-ready', function () {
            return !!window.__GEMINI_SOCKET_READY
                && typeof window.SocketConnectionCore?.connect === 'function'
                && !!window.SocketConnectionCore?.EventHandlers;
        }, 15000);

        if (!socketReady) {
            state.connectionPhase = 'socket-timeout';
            state.message = 'Gemini server is online, but the socket client did not finish loading yet.';
            publish();
            return false;
        }

        state.connectionPhase = 'ready';
        publish();
        return !!window.__GEMINI_WORKSPACE_READY && !!window.__GEMINI_SOCKET_READY;
    }

    function disconnectClient() {
        if (window.webSocket && window.webSocket.readyState < WebSocket.CLOSING) {
            try {
                window.webSocket.close(1000, 'Gemini server stopped from EveOS');
            } catch (error) {
                // The server process shutdown will close any remaining connection.
            }
        }
        if (typeof window.updateConnectionStatus === 'function') {
            window.updateConnectionStatus('disconnected', 'Gemini Server Offline');
        }
    }
    runtime.connectionApi = Object.freeze({
        connectClient,
        reconcileClientConnection,
        waitForWindowEvent,
        bootWorkspaceForConnection,
        connectWhenWorkspaceReady,
        ensureWorkspaceReady,
        disconnectClient
    });
})();
