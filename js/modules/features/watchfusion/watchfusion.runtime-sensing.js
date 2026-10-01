(function () {
    'use strict';

    if (window.EveWatchFusionRuntimeSensor) return;

    const HEARTBEAT_TTL_MS = 4500;
    let detachedSeenAt = 0;
    let detachedUrl = '';
    let detachedStorageAccess = null;
    let embeddedSeenAt = 0;
    let embeddedUrl = '';
    let embeddedStorageAccess = null;
    let exposureOrigin = '';
    let hostExposureOrigin = '';

    function port() {
        return Number(window.EveOSPortRegistry?.get?.('WATCHFUSION_PORT')) || 0;
    }

    function matchesControlStatus(payload) {
        const expected = port();
        const actual = Number(payload?.port || 0);
        return !actual || !expected || actual === expected;
    }

    function unique(values) {
        return [...new Set(values.filter(Boolean))];
    }

    function candidateOrigins() {
        const targetPort = port();
        const values = [];
        if (hostExposureOrigin) values.push(hostExposureOrigin);
        if (!targetPort) {
            if (exposureOrigin) values.push(exposureOrigin);
            return unique(values);
        }
        const pageIsLoopback = /^(127\.0\.0\.1|localhost)$/i.test(location.hostname || '');
        if (/^https?:$/.test(location.protocol) && location.hostname && !pageIsLoopback) {
            values.push(`http://${location.hostname}:${targetPort}`);
        }
        // Host-side WatchFusion prefers the controller-selected sslip surface, then
        // literal loopback fallbacks. Public Cloudflare is only a last-resort probe;
        // it must never outrank local host surfaces inside EveOS.
        values.push(
            `http://127.0.0.1:${targetPort}`,
            `http://localhost:${targetPort}`
        );
        if (exposureOrigin) values.push(exposureOrigin);
        return unique(values);
    }

    function isCandidateOrigin(origin) {
        try {
            const parsed = new URL(origin);
            if ((hostExposureOrigin && parsed.origin === hostExposureOrigin) || (exposureOrigin && parsed.origin === exposureOrigin)) return true;
            return parsed.protocol === 'http:'
                && Number(parsed.port) === port()
                && candidateOrigins().some((value) => new URL(value).origin === parsed.origin);
        } catch {
            return false;
        }
    }

    function configureExposure(snapshot) {
        const mode = String(snapshot?.exposureMode || 'local').toLowerCase();
        const raw = mode === 'lan' || mode === 'cloudflare' ? String(snapshot?.publicUrl || '') : '';
        try {
            const parsed = new URL(raw);
            exposureOrigin = /^https?:$/.test(parsed.protocol) ? parsed.origin : '';
        } catch {
            exposureOrigin = '';
        }
        try {
            const parsed = new URL(mode === 'cloudflare' ? String(snapshot?.hostUrl || '') : '');
            hostExposureOrigin = /^https?:$/.test(parsed.protocol) ? parsed.origin : '';
        } catch {
            hostExposureOrigin = '';
        }
        return hostExposureOrigin || exposureOrigin;
    }

    async function probeOrigin(origin, timeoutMs = 900) {
        if (!origin) return null;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(`${origin.replace(/\/$/, '')}/api/health`, { cache: 'no-store', signal: controller.signal });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload?.ok !== true || payload?.app !== 'WatchFusion') return null;
            if (Number(payload?.port || 0) && Number(payload.port) !== port()) return null;
            return { ok: true, port: port(), origin: origin.replace(/\/$/, ''), url: `${origin.replace(/\/$/, '')}/`, payload };
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    async function probe(preferredUrl) {
        let preferredOrigin = '';
        if (preferredUrl) {
            try {
                const parsed = new URL(preferredUrl);
                if (isCandidateOrigin(parsed.origin)) {
                    preferredOrigin = parsed.origin;
                }
            } catch {}
        }

        if (preferredOrigin) {
            const preferred = await probeOrigin(preferredOrigin, 1100);
            if (preferred) return preferred;
        }

        const candidates = candidateOrigins().filter((origin) => origin !== preferredOrigin);
        for (const origin of candidates) {
            const result = await probeOrigin(origin);
            if (result) return result;
        }
        return null;
    }

    function heartbeatState() {
        const now = Date.now();
        return {
            detached: now - detachedSeenAt <= HEARTBEAT_TTL_MS,
            detachedUrl,
            detachedStorageAccess,
            embedded: now - embeddedSeenAt <= HEARTBEAT_TTL_MS,
            embeddedUrl,
            embeddedStorageAccess
        };
    }

    function emitPresence() {
        window.dispatchEvent(new CustomEvent('eve:watchfusion-presence', { detail: heartbeatState() }));
    }

    function acceptHeartbeat(event) {
        const data = event?.data;
        if (!data || data.source !== 'WatchFusion' || data.version !== 1) return;
        if (!isCandidateOrigin(event.origin)) return;
        if (data.type === 'watchfusion:detached-presence') {
            detachedSeenAt = Date.now();
            detachedUrl = String(data.url || '');
            detachedStorageAccess = typeof data.storageAccess === 'boolean' ? data.storageAccess : null;
        } else if (data.type === 'watchfusion:embedded-presence') {
            embeddedSeenAt = Date.now();
            embeddedUrl = String(data.url || '');
            embeddedStorageAccess = typeof data.storageAccess === 'boolean' ? data.storageAccess : null;
        } else {
            return;
        }
        emitPresence();
    }

    window.addEventListener('message', acceptHeartbeat);
    window.setInterval(emitPresence, 2000);

    window.EveWatchFusionRuntimeSensor = Object.freeze({
        port,
        matchesControlStatus,
        configureExposure,
        candidateOrigins,
        probe,
        probeOrigin,
        heartbeatState,
        isCandidateOrigin
    });
})();
