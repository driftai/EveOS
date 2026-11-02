// Short-lived provider-capture transport over the existing authenticated local PCM bridge.
window.EveAudioflixNativeProviderCapture = window.EveAudioflixNativeProviderCapture || {};
(function (ns) {
    'use strict';
    if (ns.ready) return;

    const PCM_TIMEOUT_MS = 900;
    const isFile = () => window.location?.protocol === 'file:';
    const FILE_CREDENTIAL = 'data/runtime/audioflix-provider-file-auth.js?v=e47c5f84f2fe';
    let credentialTask = null;
    function localBase() {
        const state = window.EveAudioflixState?.ensure?.() || {};
        const configured = String(state.nativeBridgeBase || '').replace(/\/$/, '');
        // Native endpoint is verified by EveOS /api/status before any PCM submission.
        if (/^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}$/.test(configured)) return configured;
        return 'http://127.0.0.1:8765';
    }
    async function fileCredential() {
        if (!isFile()) return '';
        if (!credentialTask) credentialTask = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            const timer = setTimeout(() => finish(new Error('EveOS file authorization script was unavailable. Start the EveOS server and reload.')), 1800);
            let settled = false;
            function finish(error) {
                if (settled) return;
                settled = true; clearTimeout(timer); script.remove();
                const secret = window.__EveOSProviderFileAuth;
                delete window.__EveOSProviderFileAuth;
                if (error || typeof secret !== 'string' || secret.length < 40) reject(error || new Error('File authorization credential is invalid.'));
                else resolve(secret);
            }
            script.onload = () => finish();
            script.onerror = () => finish(new Error('File authorization is unavailable; start the localhost EveOS server.'));
            script.src = new URL(FILE_CREDENTIAL, window.location.href).href + '?v=' + Date.now();
            document.head.appendChild(script);
        }).catch(error => { credentialTask = null; throw error; });
        return credentialTask;
    }
    // Backward-compatible method name used by the capture controller. No popup required.
    function requireFileCompanion() { return true; }
    const state = () => window.EveAudioflixState?.ensure?.() || {};

    function selectedEndpoint(detail = {}) {
        if (detail.endpoint && typeof detail.endpoint === 'object') {
            const deviceId = String(detail.endpoint.deviceId || '').trim();
            const label = String(detail.endpoint.label || deviceId).trim();
            if (!deviceId.startsWith('sd:')) {
                throw new Error('Provider capture requires an exact native output endpoint.');
            }
            return { deviceId, label };
        }
        const current = state();
        if (current.nativeBridgeEnabled !== true) {
            throw new Error('Enable Native Route before capturing provider audio.');
        }
        if (!String(current.nativeOutputId || '').startsWith('sd:')) {
            throw new Error('Choose an exact native output endpoint before capture.');
        }
        return { deviceId: current.nativeOutputId, label: current.nativeOutputLabel || current.nativeOutputId };
    }

    function captureOrigin() {
        const { protocol, hostname, origin } = window.location || {};
        if (isFile()) return localBase();
        if (protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(hostname)) {
            throw new Error('Provider capture requires file:// EveOS or the localhost-served EveOS page.');
        }
        return origin;
    }

    async function protectedPost(base, path, payload, timeout = 1600) {
        if (base !== captureOrigin()) throw new Error('Provider capture origin changed; re-arm required.');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const headers = { 'Content-Type': 'application/json', 'X-EveOS-Provider-Capture': 'v1' };
            if (isFile() && path.endsWith('/start')) headers['X-EveOS-Provider-File-Auth'] = await fileCredential();
            const response = await fetch(base + path, {
                method: 'POST', mode: isFile() ? 'cors' : 'same-origin', cache: 'no-store', credentials: 'omit',
                headers, body: JSON.stringify(payload), signal: controller.signal
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data?.ok === false) {
                throw new Error(data?.message || `Provider capture request failed (${response.status}).`);
            }
            return data;
        } finally { clearTimeout(timer); }
    }

    async function start(detail = {}) {
        const base = captureOrigin();
        const identity = window.EveAudioflixNativeIdentity;
        if (!identity?.isEveOsBridge || !(await identity.isEveOsBridge(base))) {
            throw new Error('The selected localhost server is not a verified EveOS bridge.');
        }
        const endpoint = selectedEndpoint(detail);
        const payload = await protectedPost(base, '/api/audioflix/provider-capture/start', {
            deviceId: endpoint.deviceId,
            sampleRate: detail.sampleRate || 48000,
            channels: detail.channels || 1,
            source: detail.source || 'provider-tab'
        }, 3000);
        if (payload?.ok !== true || !payload.sessionId || !payload.captureToken) {
            throw new Error(payload?.message || 'Native provider capture session was refused.');
        }
        if (payload.deviceId !== endpoint.deviceId) {
            throw new Error('Native provider capture did not retain the exact selected endpoint.');
        }
        return { ...payload, endpointLabel: endpoint.label, bridgeBase: base };
    }

    async function send(session, audio, detail = {}) {
        if (!session?.sessionId || !session?.captureToken || !audio) return { ok: false };
        return await protectedPost(session.bridgeBase, '/api/audioflix/provider-capture/chunk', {
            sessionId: session.sessionId, captureToken: session.captureToken, audio,
            sampleRate: detail.sampleRate || session.sampleRate || 48000,
            channels: detail.channels || session.channels || 1,
            gain: detail.gain, sentAtMs: Date.now(), maxAgeMs: 1200
        }, PCM_TIMEOUT_MS);
    }
    async function status(session) {
        if (!session?.sessionId || !session?.captureToken) return { ok: false };
        return protectedPost(session.bridgeBase, '/api/audioflix/provider-capture/status',
            { sessionId: session.sessionId, captureToken: session.captureToken });
    }
    async function stop(session) {
        if (!session?.sessionId || !session?.captureToken) return { ok: true, stopped: false };
        return protectedPost(session.bridgeBase, '/api/audioflix/provider-capture/stop',
            { sessionId: session.sessionId, captureToken: session.captureToken });
    }

    Object.assign(ns, { ready: true, start, send, status, stop, selectedEndpoint, captureOrigin, requireFileCompanion });
})(window.EveAudioflixNativeProviderCapture);
