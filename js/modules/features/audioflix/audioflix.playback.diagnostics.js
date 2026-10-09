window.EveAudioflixDiagnostics = window.EveAudioflixDiagnostics || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixDiagnostics;
    if (ns.ready) return;

    const LIMIT = 128, samples = [], totals = new Map(), bootRecorded = new Set();
    const now = () => window.performance?.now?.() ?? Date.now();
    const safeDetail = (details = {}) => ({
        action: details.action ? String(details.action).slice(0, 80) : '',
        interactionId: Math.max(0, Number(details.interactionId || 0) || 0),
        error: details.error === true
    });

    function record(name, ms, details = {}) {
        const duration = Math.max(0, Number(ms) || 0);
        const key = String(name).slice(0, 120);
        let bucket = totals.get(key);
        if (!bucket) { bucket = { count: 0, errors: 0, maxMs: 0, values: [] }; totals.set(key, bucket); }
        bucket.count += 1; bucket.errors += details.error ? 1 : 0;
        bucket.maxMs = Math.max(bucket.maxMs, duration);
        bucket.values.push(duration); if (bucket.values.length > LIMIT) bucket.values.shift();
        samples.push({ name: key, ms: duration, at: now(), ...safeDetail(details) });
        if (samples.length > LIMIT) samples.shift();
    }

    function span(name, details = {}) {
        const started = now();
        let finished = false;
        return error => {
            if (finished) return;
            finished = true;
            record(name, now() - started, { ...details, error: !!error });
        };
    }

    function snapshot() {
        const summary = {};
        for (const [name, bucket] of totals) {
            const values = [...bucket.values].sort((a, b) => a - b);
            const percentile = p => values[Math.min(values.length - 1, Math.floor(values.length * p))] || 0;
            summary[name] = {
                count: bucket.count, errors: bucket.errors, maxMs: bucket.maxMs,
                p50Ms: percentile(0.5), p95Ms: percentile(0.95)
            };
        }
        return { summary, recent: samples.map(value => ({ ...value })) };
    }

    function actionForTarget(target) {
        try {
            const actionNode = target?.closest?.('[data-af-action]');
            if (actionNode?.dataset?.afAction) return String(actionNode.dataset.afAction);
            if (target?.closest?.('.topbar-audioflix-btn')) return 'open-audioflix';
        } catch {}
        return '';
    }

    const PLAY_ACTION = /(?:^|[-:])(play|internal-view|open-queue-view|restart)(?:$|[-:])/i;
    let pendingPlayInput = null, loadingAt = null, endedAt = null;
    function noteInput(event) {
        if (event?.type === 'keydown' && !['Enter', ' ', 'Spacebar'].includes(String(event.key || ''))) return;
        const action = actionForTarget(event?.target);
        if (!action || !PLAY_ACTION.test(action)) return;
        pendingPlayInput = { action, at: now() };
    }
    try {
        document.addEventListener('pointerdown', noteInput, true);
        document.addEventListener('keydown', noteInput, true);
    } catch {}

    window.addEventListener('eve:audioflix-playback', event => {
        const status = String(event.detail?.status || '');
        const timestamp = now();
        if (/^(Loading|Starting|Resolving|Buffering)\b/i.test(status)) loadingAt ??= timestamp;
        if (status === 'Ended') endedAt ??= timestamp;
        else if (/^Playing\b/.test(status)) {
            if (pendingPlayInput && timestamp - pendingPlayInput.at <= 60000) {
                const elapsed = timestamp - pendingPlayInput.at;
                record('ui:input-to-playing', elapsed, { action: pendingPlayInput.action });
                record(`ui:input-to-playing:${pendingPlayInput.action}`, elapsed, { action: pendingPlayInput.action });
                pendingPlayInput = null;
            }
            if (loadingAt !== null) { record('playback:load-to-playing', timestamp - loadingAt); loadingAt = null; }
            if (endedAt !== null) { record('queue:between-songs', timestamp - endedAt); endedAt = null; }
        } else if (status === 'Stopped') {
            endedAt = null; loadingAt = null; pendingPlayInput = null;
        }
    });

    function observeEventTiming() {
        if (typeof PerformanceObserver !== 'function') return;
        const observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
                const action = actionForTarget(entry.target);
                if (!action) continue;
                const details = { action, interactionId: entry.interactionId };
                record(`ui:input-delay:${action}`, Number(entry.processingStart || 0) - Number(entry.startTime || 0), details);
                record(`ui:handler:${action}`, Number(entry.processingEnd || 0) - Number(entry.processingStart || 0), details);
                record(`ui:interaction-total:${action}`, entry.duration, details);
            }
        });
        observer.observe({ type: 'event', buffered: true, durationThreshold: 16 });
    }

    function observeLongTasks() {
        if (typeof PerformanceObserver !== 'function') return;
        const observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) record('ui:long-task', entry.duration);
        });
        observer.observe({ type: 'longtask', buffered: true });
    }

    function recordBootMilestones() {
        const nav = window.performance?.getEntriesByType?.('navigation')?.[0];
        if (!nav) return;
        const start = Number(nav.startTime || 0);
        const milestones = [
            ['boot:dom-interactive', nav.domInteractive],
            ['boot:dom-content-loaded', nav.domContentLoadedEventEnd],
            ['boot:window-load', nav.loadEventEnd]
        ];
        for (const [name, value] of milestones) {
            const numeric = Number(value || 0);
            if (numeric > start && !bootRecorded.has(name)) {
                bootRecorded.add(name);
                record(name, numeric - start);
            }
        }
    }

    try { observeLongTasks(); } catch { /* optional browser capability */ }
    try { observeEventTiming(); } catch { /* optional browser capability */ }
    recordBootMilestones();
    try { document.addEventListener('DOMContentLoaded', recordBootMilestones, { once: true }); } catch {}
    try { window.addEventListener('load', recordBootMilestones, { once: true }); } catch {}

    Object.assign(ns, { ready: true, record, span, snapshot, actionForTarget });
    record('boot:audioflix-module', now());
})();
