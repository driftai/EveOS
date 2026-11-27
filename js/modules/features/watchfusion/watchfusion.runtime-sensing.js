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
    let hostExposureOrigin = '', fallbackEmbedOrigin = '';
    let lastCanonical = '';

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
        if (fallbackEmbedOrigin) values.push(fallbackEmbedOrigin);
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

    function canonicalOrigin(value) {
        try { const u = new URL(value); return u.protocol === 'http:' && Number(u.port) === port() && /^(?:\d{1,3}-){3}\d{1,3}\.sslip\.io$/i.test(u.hostname) && !u.username && !u.password ? u.origin : ''; } catch { return ''; }
    }
    function configureExposure(snapshot) {
        // A failed status poll is not proof that the previously advertised host changed.
        if (snapshot?.controllerAvailable === false && snapshot?.directRuntime === true && matchesControlStatus(snapshot) && (canonicalOrigin(hostExposureOrigin) || canonicalOrigin(fallbackEmbedOrigin))) return hostExposureOrigin || fallbackEmbedOrigin;
        if (!matchesControlStatus(snapshot)) { hostExposureOrigin = fallbackEmbedOrigin = exposureOrigin = lastCanonical = ''; return ''; }
        const mode = String(snapshot?.exposureMode || 'local').toLowerCase();
        const raw = mode === 'lan' || mode === 'cloudflare' ? String(snapshot?.publicUrl || '') : '';
        try {
            const parsed = new URL(raw);
            exposureOrigin = /^https?:$/.test(parsed.protocol) && (mode==='cloudflare'||Number(parsed.port)===port()) && !parsed.username && !parsed.password ? parsed.origin : '';
        } catch {
            exposureOrigin = '';
        }
        try {
            const lanHost = [snapshot?.publicUrl,snapshot?.hostUrl,snapshot?.url].map(canonicalOrigin).find(Boolean);
            const parsed = new URL(mode === 'lan' ? String(lanHost || '') : String(snapshot?.hostUrl || ''));
            hostExposureOrigin = /^https?:$/.test(parsed.protocol) && Number(parsed.port)===port() && !parsed.username && !parsed.password ? parsed.origin : '';
        } catch {
            hostExposureOrigin = '';
        }
        fallbackEmbedOrigin = canonicalOrigin(snapshot?.hostFallbackUrl) || (snapshot?.running === true ? canonicalOrigin(fallbackEmbedOrigin) : '');
        if (![canonicalOrigin(hostExposureOrigin), fallbackEmbedOrigin].includes(lastCanonical)) lastCanonical = '';
        return hostExposureOrigin || exposureOrigin;
    }

    function runtimeUrl(snapshot = {}) {
        const mode = String(snapshot?.exposureMode || 'local').toLowerCase();
        const { directHostUrl, hostUrl, localUrl, publicUrl, url } = snapshot;
        const surfaces = mode === 'cloudflare' ? [hostUrl, localUrl, publicUrl, url]
            : mode === 'lan' ? [publicUrl, url, localUrl]
                : [hostUrl, url, localUrl];
        for (const value of [directHostUrl, ...surfaces]) {
            if (!value) continue;
            try {
                const parsed = new URL(value);
                if (/^https?:$/.test(parsed.protocol)) return parsed;
            } catch {}
        }
        return null;
    }

    function workspaceUrl(snapshot = {}, { detached = false } = {}) {
        const runtime = runtimeUrl(snapshot);
        if (!runtime) return null;
        let url = runtime;
        if (detached) {
            const heartbeat = heartbeatState();
            try {
                const embedded = new URL(heartbeat.embedded ? heartbeat.embeddedUrl : '');
                if ((embedded.origin === runtime.origin || (canonicalOrigin(runtime.origin) && !canonicalOrigin(embedded.origin))) && isCandidateOrigin(embedded.origin)) url = embedded;
            } catch {}
            url.searchParams.delete('eveos');
            url.searchParams.delete('_wfReload');
            url.searchParams.set('eveosDetached', '1');
        } else {
            url.searchParams.set('eveos', '1');
            url.searchParams.delete('eveosDetached');
        }
        const mode = String(snapshot?.exposureMode || 'local').toLowerCase();
        const shareUrl = String(snapshot?.publicUrl || '').trim();
        url.searchParams.set('eveosShareMode', ['lan', 'cloudflare'].includes(mode) ? mode : 'local');
        if (shareUrl) url.searchParams.set('eveosShareUrl', shareUrl);
        else url.searchParams.delete('eveosShareUrl');
        return url;
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

    async function probe(preferredUrl, { retryCanonical = false } = {}) {
        let preferredOrigin = '';
        if (preferredUrl) {
            try {
                const parsed = new URL(preferredUrl);
                if (isCandidateOrigin(parsed.origin)) {
                    preferredOrigin = parsed.origin;
                }
            } catch {}
        }

        const canonicals = unique([canonicalOrigin(hostExposureOrigin), fallbackEmbedOrigin]);
        const preferredCanonical = canonicals.includes(preferredOrigin) ? preferredOrigin : '';
        // Prefer the active verified SSLIP surface to avoid switching between two healthy aliases.
        const ordered = unique([preferredCanonical, lastCanonical, ...canonicals]).filter(origin => canonicals.includes(origin));
        for (const origin of ordered) {
            const selected = await probeOrigin(origin, 1100);
            if (selected) { lastCanonical = origin; return selected; }
        }
        if (retryCanonical && ordered.length) {
            const selected = await probeOrigin(ordered[0], 1800);
            if (selected) { lastCanonical = selected.origin; return selected; }
        }
        if (preferredOrigin && !ordered.includes(preferredOrigin)) {
            const preferred = await probeOrigin(preferredOrigin, 1100);
            if (preferred) return recoverHostAlias(preferred, ordered);
        }

        const candidates = candidateOrigins().filter(origin => origin !== preferredOrigin && !ordered.includes(origin));
        for (const origin of candidates) {
            const result = await probeOrigin(origin);
            if (result) return recoverHostAlias(result, ordered);
        }
        return null;
    }

    async function recoverHostAlias(result, tried) {
        const origin=canonicalOrigin(result.payload?.hostFallbackUrl);
        if (!origin || new URL(origin).hostname.split('.')[0] !== '127-0-0-1' || tried.includes(origin)) return result;
        fallbackEmbedOrigin=origin; const selected=await probeOrigin(origin,1800);
        if(selected){lastCanonical=origin;return selected;} return result;
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
        runtimeUrl,
        workspaceUrl,
        candidateOrigins,
        probe,
        probeOrigin,
        heartbeatState,
        isCandidateOrigin,
        isCanonical: value => Boolean(canonicalOrigin(value) && [canonicalOrigin(hostExposureOrigin), fallbackEmbedOrigin].includes(canonicalOrigin(value))),
        hasCanonical: () => Boolean(canonicalOrigin(hostExposureOrigin) || fallbackEmbedOrigin)
    });
})();
