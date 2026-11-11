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

    function transportError(message, category, retryable, status = 0, cause = null) {
        const error = new Error(message);
        error.eveCategory = category;
        error.eveRetryable = retryable === true;
        error.eveHttpStatus = Number(status) || 0;
        if (cause) error.cause = cause;
        return error;
    }

    function responseError(data, status) {
        const message = String(data?.message || `Provider capture request failed (${status}).`);
        if (/renderer became unavailable|renderer stalled/i.test(message)) {
            return transportError(message, 'renderer-unavailable', true, status);
        }
        if (/invalid or expired|session expired|already stopped/i.test(message)) {
            return transportError(message, 'session-expired', true, status);
        }
        if (/endpoint|device|renderer did not start|native output/i.test(message)) {
            return transportError(message, 'endpoint-unavailable', false, status);
        }
        if (status === 401 || status === 403 || /auth|credential|ownership|generation is stale/i.test(message)) {
            return transportError(message, 'authorization', false, status);
        }
        return transportError(message, status >= 500 ? 'bridge-refused' : 'request-refused', status >= 500, status);
    }

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
        if (base !== captureOrigin()) throw transportError('Provider capture origin changed; re-arm required.', 'origin-changed', false);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const headers = { 'Content-Type': 'application/json', 'X-EveOS-Provider-Capture': 'v1' };
            if (isFile() && path.endsWith('/start')) headers['X-EveOS-Provider-File-Auth'] = await fileCredential();
            let response;
            try {
                response = await fetch(base + path, {
                    method: 'POST', mode: isFile() ? 'cors' : 'same-origin', cache: 'no-store', credentials: 'omit',
                    headers, body: JSON.stringify(payload), signal: controller.signal
                });
            } catch (error) {
                if (error?.name === 'AbortError') throw transportError('Provider capture request timed out.', 'timeout', true, 0, error);
                throw transportError(error?.message || 'Provider capture bridge is unreachable.', 'bridge-unreachable', true, 0, error);
            }
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data?.ok === false) {
                throw responseError(data, response.status);
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
        const lane = detail.lane === 'piano-pcm' ? 'piano-pcm' : 'provider-capture';
        const payload = await protectedPost(base, '/api/audioflix/provider-capture/start', {
            deviceId: endpoint.deviceId,
            sampleRate: detail.sampleRate || 48000,
            channels: detail.channels || 1,
            source: detail.source || 'provider-tab', lane,
            ownerId: lane === 'piano-pcm' ? String(detail.ownerId || '') : '',
            generation: lane === 'piano-pcm' ? Number(detail.generation || 0) : 0
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
            gain: detail.gain, sentAtMs: Date.now(), maxAgeMs: detail.maxAgeMs || 1200,
            lane: session.lane, ownerId: session.ownerId, generation: session.generation
        }, Math.max(120, Math.min(PCM_TIMEOUT_MS, Number(detail.timeoutMs || PCM_TIMEOUT_MS))));
    }
    async function status(session) {
        if (!session?.sessionId || !session?.captureToken) return { ok: false };
        return protectedPost(session.bridgeBase, '/api/audioflix/provider-capture/status',
            { sessionId: session.sessionId, captureToken: session.captureToken,
                lane: session.lane, ownerId: session.ownerId, generation: session.generation });
    }
    async function stop(session) {
        if (!session?.sessionId || !session?.captureToken) return { ok: true, stopped: false };
        return protectedPost(session.bridgeBase, '/api/audioflix/provider-capture/stop',
            { sessionId: session.sessionId, captureToken: session.captureToken,
                lane: session.lane, ownerId: session.ownerId, generation: session.generation });
    }

    async function pianoNative(action, payload = {}, timeoutMs = 3000) {
        const name = String(action || 'status');
        if (!['start', 'status', 'pause', 'seek', 'volume', 'stop'].includes(name))
            throw new Error('Unknown server-owned Piano action.');
        const base = captureOrigin();
        const identity = window.EveAudioflixNativeIdentity;
        if (!identity?.isEveOsBridge || !(await identity.isEveOsBridge(base)))
            throw new Error('The selected localhost server is not a verified EveOS bridge.');
        const body = { ...payload };
        if (name === 'start') {
            const endpoint = selectedEndpoint(payload);
            body.deviceId = endpoint.deviceId;
        }
        return protectedPost(base, `/api/audioflix/piano-native/${name}`, body,
            Math.max(1200, Number(timeoutMs) || 3000));
    }

    Object.assign(ns, { ready: true, start, send, status, stop, selectedEndpoint, captureOrigin,
        pianoNative, requireFileCompanion, transportError, responseError });
})(window.EveAudioflixNativeProviderCapture);
