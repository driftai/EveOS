window.EveAudioflixSpotifyRemote = window.EveAudioflixSpotifyRemote || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixSpotifyRemote;
    if (ns.ready) return;

    const PROTOCOL = 1;
    const state = {
        status: 'idle', connected: false, connecting: false, approvalRequired: false,
        code: '', approvalUrl: '', clientId: '', mode: '', base: '', lastError: '', lastState: null
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

    const uuid = () => crypto.randomUUID?.() || `af-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
    function snapshot() {
        return {
            status: state.status, connected: state.connected, connecting: state.connecting,
            approvalRequired: state.approvalRequired, code: state.code, approvalUrl: state.approvalUrl,
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
    function onPortMessage(event) {
        const message = event.data || {};
        if (message.type === 'ready') {
            state.connected = true;
            state.connecting = false;
            state.approvalRequired = false;
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
    async function connect() {
        if (state.connected || state.approvalRequired) return snapshot();
        if (connectPromise) return connectPromise;
        state.connecting = true;
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
            iframe.addEventListener('load', () => {
                const channel = new MessageChannel();
                port = channel.port1;
                port.onmessage = onPortMessage;
                port.start?.();
                const hello = {
                    type: 'eveos:spotify-relay-connect', protocolVersion: PROTOCOL,
                    documentId: uuid(), libraryScopeId: libraryScopeId()
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
            }, { once: true });
            iframe.addEventListener('error', () => {
                const error = new Error(`Could not load the EveOS Spotify relay at ${state.base}.`);
                state.connecting = false;
                state.status = 'unavailable';
                state.lastError = error.message;
                notify();
                settleReady(false, error);
            }, { once: true });
            document.documentElement.appendChild(iframe);
        }).finally(() => { connectPromise = null; });
        return connectPromise;
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
            try { await connect(); } catch (error) { return { ok: false, unavailable: true, reason: error.message }; }
        }
        if (!state.connected) {
            return {
                ok: false, approvalRequired: state.approvalRequired,
                code: state.code, approvalUrl: state.approvalUrl,
                reason: state.approvalRequired ? 'Approve this EveOS file tab to control Spotify.' : (state.lastError || 'Spotify relay unavailable.')
            };
        }
        if (!port) return { ok: false, unavailable: true, reason: 'Spotify relay channel is unavailable.' };
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
        state.status = 'idle';
        notify();
    }

    Object.assign(ns, {
        ready: true, connect, send, status, openApproval, waitUntilReady, disconnect, snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    });
    window.addEventListener('pagehide', disconnect, { once: true });
})();