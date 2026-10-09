window.EveAudioflixSpotifyRemote = window.EveAudioflixSpotifyRemote || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixSpotifyRemote;
    if (ns.ready) return;

    const PROTOCOL = 1;
    const RELAY_READY_TIMEOUT_MS = 2500;
    const RELAY_UNAVAILABLE_COOLDOWN_MS = 30000;
    const DOCUMENT_HEARTBEAT_MS = 2000;
    const DOCUMENT_STALE_MS = 6500;
    const state = {
        status: 'idle', connected: false, connecting: false, approvalRequired: false,
        relayReady: false, relayEverReached: false, unavailableUntil: 0,
        code: '', approvalUrl: '', clientId: '', mode: '', base: '',
        lastError: '', lastState: null
    };
    const listeners = new Set();
    const pending = new Map();
    let iframe = null;
    let port = null;
    let connectPromise = null;
    let readyResolve = null;
    let readyReject = null;
    let requestSeq = 0;
    let commandSeq = 0;
    let documentIdentityPromise = null;
    let identityClaim = null;

    const uuid = () => crypto.randomUUID?.() || `af-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const relayReadyTimeoutMs = () => Math.max(250,
        Number(window.__EveAudioflixSpotifyRelayReadyTimeoutMs || RELAY_READY_TIMEOUT_MS));
    const unavailableCooldownMs = () => Math.max(1000,
        Number(window.__EveAudioflixSpotifyUnavailableCooldownMs || RELAY_UNAVAILABLE_COOLDOWN_MS));
    const loopbackBase = (value) => {
        try {
            const url = new URL(String(value || ''));
            if (!/^https?:$/.test(url.protocol)) return '';
            if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return '';
            return url.origin;
        } catch { return ''; }
    };
    function candidateBase() {
        if (/^https?:$/.test(location.protocol)) {
            const own = loopbackBase(location.origin);
            if (own) return own;
        }
        const saved = loopbackBase(window.EveAudioflixState?.ensure?.()?.nativeBridgeBase);
        if (saved) return saved;
        return 'http://127.0.0.1:8765';
    }
    function libraryScopeId() {
        const saved = String(window.EveAudioflixState?.ensure?.()?.libraryScopeId || '').trim();
        if (saved) return saved.slice(0, 160);
        if (location.protocol === 'file:') return `file:${String(location.pathname || '').toLowerCase()}`.slice(0, 160);
        return `origin:${location.origin}`.slice(0, 160);
    }
    function documentStorageKey(scope) {
        return `eveos:audioflix:spotify-document:${scope}`;
    }
    function storedDocumentId(scope) {
        const key = documentStorageKey(scope);
        try {
            const existing = String(sessionStorage.getItem(key) || '').trim();
            if (existing) return existing.slice(0, 120);
            const created = uuid().slice(0, 120);
            sessionStorage.setItem(key, created);
            return created;
        } catch { return uuid().slice(0, 120); }
    }
    function saveDocumentId(scope, value) {
        try { sessionStorage.setItem(documentStorageKey(scope), String(value).slice(0, 120)); } catch {}
    }
    function readHeartbeat(key) {
        try {
            const value = JSON.parse(localStorage.getItem(key) || 'null');
            return value && typeof value === 'object' ? value : null;
        } catch { return null; }
    }
    function writeHeartbeat(key, nonce) {
        try { localStorage.setItem(key, JSON.stringify({ nonce, at: Date.now() })); } catch {}
    }
    function releaseDocumentIdentity() {
        const claim = identityClaim;
        identityClaim = null;
        if (!claim) return;
        if (claim.timer) clearInterval(claim.timer);
        try { claim.channel?.close?.(); } catch {}
        try {
            const current = readHeartbeat(claim.heartbeatKey);
            if (current?.nonce === claim.nonce) localStorage.removeItem(claim.heartbeatKey);
        } catch {}
    }
    function claimedDocumentId() {
        if (documentIdentityPromise) return documentIdentityPromise;
        documentIdentityPromise = (async () => {
            const scope = libraryScopeId();
            let current = storedDocumentId(scope);
            if (location.protocol !== 'file:') return current;
            const nonce = uuid();
            const heartbeatKeyFor = (id) => `eveos:audioflix:spotify-claim:${scope}:${id}`;
            const isRecentOther = (claim) => claim?.nonce && claim.nonce !== nonce
                && Date.now() - Number(claim.at || 0) < DOCUMENT_STALE_MS;
            if (isRecentOther(readHeartbeat(heartbeatKeyFor(current)))) {
                current = uuid().slice(0, 120);
                saveDocumentId(scope, current);
            }
            let collision = false;
            let channel = null;
            if (typeof BroadcastChannel === 'function') {
                try {
                    channel = new BroadcastChannel(`eveos:audioflix:spotify-document:${scope}`);
                    channel.onmessage = (event) => {
                        const message = event.data || {};
                        if (message.nonce === nonce || message.documentId !== current) return;
                        if (message.type === 'probe') {
                            collision = true;
                            channel.postMessage({ type: 'claimed', documentId: current, nonce });
                        } else if (message.type === 'claimed') collision = true;
                    };
                    channel.postMessage({ type: 'probe', documentId: current, nonce });
                } catch { channel = null; }
            }
            await new Promise((resolve) => setTimeout(resolve, 90));
            if (collision) {
                current = uuid().slice(0, 120);
                saveDocumentId(scope, current);
            }
            const heartbeatKey = heartbeatKeyFor(current);
            writeHeartbeat(heartbeatKey, nonce);
            if (channel) {
                channel.onmessage = (event) => {
                    const message = event.data || {};
                    if (message.type === 'probe' && message.documentId === current && message.nonce !== nonce) {
                        channel.postMessage({ type: 'claimed', documentId: current, nonce });
                    }
                };
            }
            const timer = setInterval(() => writeHeartbeat(heartbeatKey, nonce), DOCUMENT_HEARTBEAT_MS);
            identityClaim = { id: current, nonce, heartbeatKey, channel, timer };
            return current;
        })();
        return documentIdentityPromise;
    }
    function snapshot() {
        return {
            status: state.status, connected: state.connected, connecting: state.connecting,
            approvalRequired: state.approvalRequired, relayReady: state.relayReady,
            relayEverReached: state.relayEverReached,
            unavailableForMs: Math.max(0, state.unavailableUntil - Date.now()),
            code: state.code, approvalUrl: state.approvalUrl,
            clientId: state.clientId, mode: state.mode, base: state.base,
            lastError: state.lastError, lastState: state.lastState
        };
    }
    function notify() {
        const value = snapshot();
        listeners.forEach((listener) => { try { listener(value); } catch {} });
    }
    function settleReady(ok, value) {
        const resolve = readyResolve, reject = readyReject;
        readyResolve = null; readyReject = null;
        if (ok) resolve?.(value); else reject?.(value instanceof Error ? value : new Error(String(value || 'Spotify relay failed.')));
    }
    function cacheUnavailable() {
        state.unavailableUntil = Date.now() + unavailableCooldownMs();
    }
    function clearUnavailableCache() {
        state.unavailableUntil = 0;
        if (!state.connected && !state.approvalRequired && state.status === 'unavailable') state.status = 'idle';
    }
    function unavailableCached() {
        return state.status === 'unavailable' && state.unavailableUntil > Date.now();
    }
    function onPortMessage(event) {
        const message = event.data || {};
        if (message.type === 'ready') {
            state.connected = true;
            state.connecting = false;
            state.approvalRequired = false;
            state.relayReady = true;
            state.relayEverReached = true;
            state.unavailableUntil = 0;
            state.code = '';
            state.approvalUrl = '';
            state.clientId = String(message.clientId || '');
            state.mode = String(message.mode || '');
            state.status = 'ready';
            state.lastError = '';
            notify();
            settleReady(true, snapshot());
            return;
        }
        if (message.type === 'pairing-required') {
            state.connected = false;
            state.connecting = true;
            state.approvalRequired = true;
            state.relayReady = true;
            state.relayEverReached = true;
            state.unavailableUntil = 0;
            state.code = String(message.code || '');
            state.approvalUrl = String(message.approvalUrl || '');
            state.status = 'approval-needed';
            notify();
            settleReady(true, snapshot());
            return;
        }
        if (message.type === 'connection-error') {
            state.connected = false;
            state.connecting = false;
            state.status = 'unavailable';
            state.lastError = String(message.message || 'Spotify relay connection failed.').slice(0, 240);
            notify();
            settleReady(false, new Error(state.lastError));
            return;
        }
        if (message.type === 'result') {
            const entry = pending.get(String(message.requestId || ''));
            if (!entry) return;
            pending.delete(String(message.requestId || ''));
            clearTimeout(entry.timer);
            const result = message.result || {};
            if (result?.engine || result?.managed) state.lastState = result;
            entry.resolve(result);
            notify();
        }
    }
    async function connect(options = {}) {
        if (options?.force) clearUnavailableCache();
        if (state.connected || state.approvalRequired) return snapshot();
        if (!options?.force && unavailableCached()) return snapshot();
        if (connectPromise) return connectPromise;
        state.connecting = true;
        state.relayReady = false;
        state.status = 'connecting';
        state.lastError = '';
        state.base = candidateBase();
        notify();
        connectPromise = new Promise((resolve, reject) => {
            readyResolve = resolve;
            readyReject = reject;
            const relayOrigin = new URL(state.base).origin;
            iframe = document.createElement('iframe');
            iframe.hidden = true;
            iframe.tabIndex = -1;
            iframe.setAttribute('aria-hidden', 'true');
            iframe.src = `${state.base}/api/audioflix/spotify-relay`;

            let handshakeDone = false;
            let handshakeTimer = 0;
            const cleanupHandshake = () => {
                if (handshakeTimer) clearTimeout(handshakeTimer);
                handshakeTimer = 0;
                window.removeEventListener('message', onRelayReady);
            };
            const failBeforeRelay = (error) => {
                if (handshakeDone) return;
                handshakeDone = true;
                cleanupHandshake();
                state.connected = false;
                state.connecting = false;
                state.relayReady = false;
                state.status = 'unavailable';
                state.lastError = String(error?.message || error || 'Spotify relay unavailable.').slice(0, 240);
                cacheUnavailable();
                try { iframe?.remove?.(); } catch {}
                iframe = null;
                notify();
                settleReady(false, error instanceof Error ? error : new Error(state.lastError));
            };
            const startChannel = async () => {
                const channel = new MessageChannel();
                port = channel.port1;
                port.onmessage = onPortMessage;
                port.start?.();
                const hello = {
                    type: 'eveos:spotify-relay-connect', protocolVersion: PROTOCOL,
                    documentId: await claimedDocumentId(), libraryScopeId: libraryScopeId()
                };
                try {
                    iframe.contentWindow.postMessage(hello, relayOrigin, [channel.port2]);
                } catch (error) {
                    state.connecting = false;
                    state.status = 'unavailable';
                    state.lastError = String(error?.message || error).slice(0, 240);
                    notify();
                    settleReady(false, error);
                }
            };
            const onRelayReady = (event) => {
                if (handshakeDone || event.source !== iframe?.contentWindow || event.origin !== relayOrigin) return;
                const message = event.data || {};
                if (message.type !== 'eveos:spotify-relay-ready' || Number(message.protocolVersion) !== PROTOCOL) return;
                handshakeDone = true;
                cleanupHandshake();
                state.relayReady = true;
                state.relayEverReached = true;
                state.unavailableUntil = 0;
                state.lastError = '';
                notify();
                startChannel().catch((error) => settleReady(false, error));
            };
            window.addEventListener('message', onRelayReady);
            iframe.addEventListener('error', () => {
                failBeforeRelay(new Error(`Could not load the EveOS Spotify relay at ${state.base}.`));
            }, { once: true });
            handshakeTimer = setTimeout(() => {
                failBeforeRelay(new Error(`No EveOS Spotify relay answered at ${state.base}.`));
            }, relayReadyTimeoutMs());
            document.documentElement.appendChild(iframe);
        }).finally(() => { connectPromise = null; });
        return connectPromise;
    }
    async function retry() {
        clearUnavailableCache();
        notify();
        return connect({ force: true });
    }
    function openApproval() {
        if (!state.approvalRequired || !state.approvalUrl) return false;
        const opened = window.open(state.approvalUrl, 'eveos-spotify-approval', 'popup,width=640,height=620');
        return Boolean(opened);
    }
    function waitUntilReady(timeoutMs = 300000) {
        if (state.connected) return Promise.resolve(snapshot());
        return new Promise((resolve, reject) => {
            const bounded = Math.max(1000, Number(timeoutMs || 300000));
            let settled = false;
            let unsubscribe = () => {};
            const finish = (ok, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                unsubscribe();
                if (ok) resolve(value); else reject(value instanceof Error ? value : new Error(String(value || 'Spotify relay unavailable.')));
            };
            const timer = setTimeout(() => finish(false, new Error('Spotify relay approval timed out.')), bounded);
            unsubscribe = ns.subscribe((value) => {
                if (value.connected) finish(true, value);
                else if (value.status === 'unavailable') finish(false, new Error(value.lastError || 'Spotify relay unavailable.'));
            });
        });
    }
    async function send(action, payload = {}, options = {}) {
        if (!state.connected) {
            try { await connect(); } catch (error) {
                return {
                    ok: false, unavailable: true,
                    relayReady: state.relayReady, relayEverReached: state.relayEverReached,
                    reason: error.message
                };
            }
        }
        if (!state.connected) {
            return {
                ok: false, approvalRequired: state.approvalRequired,
                relayReady: state.relayReady, relayEverReached: state.relayEverReached,
                code: state.code, approvalUrl: state.approvalUrl,
                reason: state.approvalRequired ? 'Approve this EveOS file tab to control Spotify.' : (state.lastError || 'Spotify relay unavailable.')
            };
        }
        if (!port) {
            return {
                ok: false, unavailable: true,
                relayReady: state.relayReady, relayEverReached: state.relayEverReached,
                reason: 'Spotify relay channel is unavailable.'
            };
        }
        requestSeq += 1;
        commandSeq += 1;
        const requestId = `r${requestSeq}-${uuid()}`;
        const command = {
            action: String(action || ''), commandId: options.commandId || uuid(),
            clientCommandSeq: commandSeq, payload: payload || {}
        };
        return new Promise((resolve) => {
            const timeoutMs = Math.max(500, Number(options.timeout || 15000));
            const timer = setTimeout(() => {
                pending.delete(requestId);
                resolve({ ok: false, timeout: true, reason: `Spotify ${action} timed out.` });
            }, timeoutMs);
            pending.set(requestId, { resolve, timer });
            port.postMessage({ type: 'command', requestId, command });
        });
    }
    async function status() {
        const result = await send('status', {}, { timeout: 5000 });
        if (result?.engine || result?.managed) state.lastState = result;
        return result;
    }
    function disconnect() {
        try {
            if (port) {
                commandSeq += 1;
                port.postMessage({ type: 'disconnect', commandId: uuid(), clientCommandSeq: commandSeq });
            }
        } catch {}
        for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            entry.resolve({ ok: false, disconnected: true, reason: 'Spotify relay disconnected.' });
        }
        pending.clear();
        try { port?.close?.(); } catch {}
        port = null;
        try { iframe?.remove?.(); } catch {}
        iframe = null;
        state.connected = false;
        state.connecting = false;
        state.approvalRequired = false;
        state.relayReady = false;
        state.unavailableUntil = 0;
        state.status = 'idle';
        notify();
    }

    Object.assign(ns, {
        ready: true, connect, retry, send, status, openApproval, waitUntilReady, disconnect, snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    });
    document.addEventListener?.('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || !state.unavailableUntil) return;
        clearUnavailableCache();
        notify();
    });
    window.addEventListener('pagehide', () => { releaseDocumentIdentity(); disconnect(); }, { once: true });
})();
