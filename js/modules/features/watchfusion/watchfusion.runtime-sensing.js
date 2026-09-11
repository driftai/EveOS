(function () {
    'use strict';

    if (window.EveWatchFusionRuntimeSensor) return;

    const HEARTBEAT_TTL_MS = 4500;
    let detachedSeenAt = 0;
    let detachedUrl = '';
    let embeddedSeenAt = 0;
    let embeddedUrl = '';

    function port() {
        return Number(window.EveOSPortRegistry?.get?.('WATCHFUSION_PORT')) || 0;
    }

    function unique(values) {
        return [...new Set(values.filter(Boolean))];
    }

    function candidateOrigins() {
        const targetPort = port();
        if (!targetPort) return [];
        const values = [];
        if (/^https?:$/.test(location.protocol) && location.hostname) {
            // Reuse the EveOS page hostname first. The WatchFusion server preserves
            // this host for ?eveos=1 / ?eveosDetached=1 so embedded and detached
            // views can share one WatchFusion origin where possible.
            values.push(`http://${location.hostname}:${targetPort}`);
        }
        values.push(
            `http://localhost:${targetPort}`,
            `http://127.0.0.1:${targetPort}`,
            `http://127-0-0-1.sslip.io:${targetPort}`
        );
        return unique(values);
    }

    function isCandidateOrigin(origin) {
        try {
            const parsed = new URL(origin);
            return parsed.protocol === 'http:'
                && Number(parsed.port) === port()
                && candidateOrigins().some((value) => new URL(value).hostname === parsed.hostname);
        } catch {
            return false;
        }
    }

    async function probeOrigin(origin, timeoutMs = 900) {
        if (!origin) return null;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(`${origin.replace(/\/$/, '')}/api/health`, {
                cache: 'no-store',
                signal: controller.signal
            });
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
        const origins = [...candidateOrigins()];
        if (preferredUrl) {
            try {
                const parsed = new URL(preferredUrl);
                if (Number(parsed.port) === port()) origins.push(parsed.origin);
            } catch {}
        }
        for (const origin of unique(origins)) {
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
            embedded: now - embeddedSeenAt <= HEARTBEAT_TTL_MS,
            embeddedUrl
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
        } else if (data.type === 'watchfusion:embedded-presence') {
            embeddedSeenAt = Date.now();
            embeddedUrl = String(data.url || '');
        } else {
            return;
        }
        emitPresence();
    }

    window.addEventListener('message', acceptHeartbeat);
    window.setInterval(emitPresence, 2000);

    window.EveWatchFusionRuntimeSensor = Object.freeze({
        port,
        candidateOrigins,
        probe,
        probeOrigin,
        heartbeatState,
        isCandidateOrigin
    });
})();
