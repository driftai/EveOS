window.EveAudioflixDiagnostics = window.EveAudioflixDiagnostics || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixDiagnostics;
    if (ns.ready) return;
    const LIMIT = 128, samples = [], totals = new Map();
    const now = () => window.performance?.now?.() ?? Date.now();
    function record(name, ms, details = {}) {
        const duration = Math.max(0, Number(ms) || 0);
        const key = String(name).slice(0, 80);
        let bucket = totals.get(key);
        if (!bucket) { bucket = { count: 0, errors: 0, maxMs: 0, values: [] }; totals.set(key, bucket); }
        bucket.count += 1; bucket.errors += details.error ? 1 : 0;
        bucket.maxMs = Math.max(bucket.maxMs, duration);
        bucket.values.push(duration); if (bucket.values.length > LIMIT) bucket.values.shift();
        samples.push({ name: key, ms: duration, at: now(), error: details.error === true });
        if (samples.length > LIMIT) samples.shift();
    }
    function span(name) {
        const started = now();
        let finished = false;
        return error => { if (!finished) { finished = true; record(name, now() - started, { error: !!error }); } };
    }
    function snapshot() {
        const summary = {};
        for (const [name, bucket] of totals) {
            const values = [...bucket.values].sort((a, b) => a - b);
            const percentile = p => values[Math.min(values.length - 1, Math.floor(values.length * p))] || 0;
            summary[name] = { count: bucket.count, errors: bucket.errors, maxMs: bucket.maxMs,
                p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
        }
        return { summary, recent: samples.map(value => ({ ...value })) };
    }
    let endedAt = null;
    window.addEventListener('eve:audioflix-playback', event => {
        const status = String(event.detail?.status || '');
        if (status === 'Ended') endedAt ??= now();
        else if (/^Playing\b/.test(status) && endedAt !== null) {
            record('queue:between-songs', now() - endedAt); endedAt = null;
        } else if (status === 'Stopped') endedAt = null;
    });
    try {
        if (typeof PerformanceObserver === 'function') {
            const observer = new PerformanceObserver(list => {
                for (const entry of list.getEntries()) record('ui:long-task', entry.duration);
            });
            observer.observe({ type: 'longtask', buffered: true });
        }
    } catch { /* optional browser capability */ }
    Object.assign(ns, { ready: true, record, span, snapshot });
    record('boot:audioflix-module', now());
})();
