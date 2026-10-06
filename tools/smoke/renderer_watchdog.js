'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const REPORT_DIR = path.join(ROOT, 'data', 'runtime', 'smoke-results');
const watchedPages = new WeakMap();
const patchedContexts = new WeakSet();
const patchedBrowsers = new WeakSet();

function flag(name) {
    return /^(1|true|yes|on)$/i.test(String(process.env[name] || '').trim());
}

function numberEnv(name, fallback, min, max) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function timeout(promise, ms, label) {
    let timer;
    return Promise.race([
        Promise.resolve(promise).finally(() => clearTimeout(timer)),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        })
    ]);
}

function options(overrides = {}) {
    return {
        enabled: overrides.enabled ?? flag('EVE_SMOKE_RENDERER_WATCHDOG'),
        strict: overrides.strict ?? flag('EVE_SMOKE_RENDERER_WATCHDOG_STRICT'),
        reportAll: overrides.reportAll ?? flag('EVE_SMOKE_RENDERER_WATCHDOG_REPORT_ALL'),
        intervalMs: overrides.intervalMs || numberEnv('EVE_SMOKE_RENDERER_WATCHDOG_INTERVAL_MS', 700, 200, 10000),
        probeTimeoutMs: overrides.probeTimeoutMs || numberEnv('EVE_SMOKE_RENDERER_WATCHDOG_PROBE_TIMEOUT_MS', 1500, 300, 15000),
        stallMs: overrides.stallMs || numberEnv('EVE_SMOKE_RENDERER_WATCHDOG_STALL_MS', 4000, 1200, 60000),
        misses: overrides.misses || numberEnv('EVE_SMOKE_RENDERER_WATCHDOG_MISSES', 2, 1, 10),
        label: overrides.label || process.env.EVE_SMOKE_RENDERER_WATCHDOG_LABEL || 'smoke'
    };
}

function transient(error) {
    return /execution context was destroyed|cannot find context|target closed|session closed|page closed|navigation/i
        .test(String(error?.message || error || ''));
}

function safeLabel(value) {
    return String(value || 'smoke').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'smoke';
}

async function cpuDelta(browserCdp) {
    if (!browserCdp) return [];
    try {
        const before = await timeout(browserCdp.send('SystemInfo.getProcessInfo'), 2000, 'process info');
        await new Promise((resolve) => setTimeout(resolve, 500));
        const after = await timeout(browserCdp.send('SystemInfo.getProcessInfo'), 2000, 'process info');
        const previous = new Map((before.processInfo || []).map((item) => [item.id, Number(item.cpuTime || 0)]));
        return (after.processInfo || []).map((item) => ({
            id: item.id,
            type: item.type,
            cpuDeltaSec: Number((Number(item.cpuTime || 0) - Number(previous.get(item.id) || 0)).toFixed(4))
        })).sort((a, b) => b.cpuDeltaSec - a.cpuDeltaSec).slice(0, 12);
    } catch (error) {
        return [{ type: 'diagnostic-error', message: error?.message || String(error) }];
    }
}

async function pausedStack(cdp) {
    const paused = await new Promise(async (resolve) => {
        let timer;
        const handler = (payload) => {
            clearTimeout(timer);
            cdp.off('Debugger.paused', handler);
            resolve(payload);
        };
        cdp.on('Debugger.paused', handler);
        timer = setTimeout(() => {
            cdp.off('Debugger.paused', handler);
            resolve(null);
        }, 2500);
        try { await timeout(cdp.send('Debugger.pause'), 1500, 'Debugger.pause'); } catch (_) {}
    });
    if (!paused) return [];
    const stack = (paused.callFrames || []).slice(0, 12).map((frame) => ({
        functionName: frame.functionName || '(anonymous)',
        url: frame.url || '',
        line: Number(frame.location?.lineNumber || 0) + 1,
        column: Number(frame.location?.columnNumber || 0) + 1
    }));
    try { await timeout(cdp.send('Debugger.resume'), 1500, 'Debugger.resume'); } catch (_) {}
    return stack;
}

async function attachRendererWatchdog(page, overrides = {}) {
    const config = options(overrides);
    if (!config.enabled || !page) return null;
    if (watchedPages.has(page)) return watchedPages.get(page);

    let cdp;
    try { cdp = await page.context().newCDPSession(page); } catch (_) { return null; }
    const browser = page.context().browser();
    let browserCdp = null;
    try { browserCdp = await browser?.newBrowserCDPSession?.(); } catch (_) {}

    const report = {
        startedAt: new Date().toISOString(),
        label: safeLabel(config.label),
        strict: config.strict,
        url: page.url(),
        violations: [],
        events: [],
        stall: null,
        final: null
    };
    let stopped = false;
    let busy = false;
    let misses = 0;
    let lastHealthy = Date.now();
    let interval = null;
    let reportPath = '';

    function event(type, message) {
        report.events.push({ at: Date.now(), type, message: String(message || '').slice(0, 4000) });
        if (report.events.length > 100) report.events.shift();
    }

    function save(reason) {
        fs.mkdirSync(REPORT_DIR, { recursive: true });
        if (!reportPath) {
            reportPath = path.join(REPORT_DIR, `renderer-watchdog-${report.label}-${Date.now()}.json`);
        }
        report.final = {
            status: report.stall ? 'STALL' : 'PASS',
            reason,
            stoppedAt: new Date().toISOString(),
            lastHealthyGapMs: Date.now() - lastHealthy
        };
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
        console.log(`[RENDERER_WATCHDOG_REPORT] ${path.relative(ROOT, reportPath).replace(/\\/g, '/')}`);
    }

    async function diagnose(error) {
        if (report.stall || stopped) return;
        const gapMs = Date.now() - lastHealthy;
        report.stall = {
            detectedAt: new Date().toISOString(),
            gapMs,
            misses,
            error: error?.message || String(error || ''),
            url: page.url(),
            processCpu: await cpuDelta(browserCdp),
            stack: await pausedStack(cdp)
        };
        const renderer = report.stall.processCpu.find((row) => row.type === 'renderer');
        report.stall.classification = report.stall.stack.length
            ? 'JavaScript was interruptible; inspect paused stack.'
            : renderer?.cpuDeltaSec >= 0.25
                ? 'Renderer stayed CPU-hot; suspect style/layout/paint/compositor work.'
                : 'Renderer was unresponsive without a clear JS/CPU-hot signature.';
        console.error(`[RENDERER_WATCHDOG_STALL] ${report.label}: ${gapMs}ms`);
        console.error(`[RENDERER_WATCHDOG_CLASSIFICATION] ${report.stall.classification}`);
        save('stall');
        if (config.strict) process.exitCode = 1;
    }

    async function probe() {
        if (stopped || busy || page.isClosed()) return;
        busy = true;
        try {
            const result = await timeout(cdp.send('Runtime.evaluate', {
                expression: `({ now: performance.now(), href: location.href, state: document.readyState, nodes: document.body ? document.body.getElementsByTagName('*').length : 0 })`,
                returnByValue: true,
                awaitPromise: false
            }), config.probeTimeoutMs, 'renderer heartbeat');
            misses = 0;
            lastHealthy = Date.now();
            report.url = result?.result?.value?.href || page.url();
        } catch (error) {
            if (transient(error)) {
                misses = 0;
                lastHealthy = Date.now();
                event('navigation', error?.message || error);
            } else {
                misses += 1;
                const gap = Date.now() - lastHealthy;
                event('miss', `${gap}ms ${error?.message || error}`);
                if (misses >= config.misses && gap >= config.stallMs) await diagnose(error);
            }
        } finally {
            busy = false;
        }
    }

    async function stop(reason = 'page-close') {
        if (stopped) return;
        stopped = true;
        clearInterval(interval);
        try { await cdp.send('Log.stopViolationsReport'); } catch (_) {}
        try { await cdp.detach(); } catch (_) {}
        if (report.stall || config.reportAll) save(reason);
    }

    const controller = { probe, stop, get stalled() { return !!report.stall; }, get reportPath() { return reportPath; } };
    watchedPages.set(page, controller);

    try {
        await cdp.send('Runtime.enable');
        await cdp.send('Debugger.enable');
        await cdp.send('Log.enable');
        await cdp.send('Log.startViolationsReport', { config: [
            { name: 'longTask', threshold: 120 },
            { name: 'longLayout', threshold: 120 },
            { name: 'blockedEvent', threshold: 120 },
            { name: 'recurringHandler', threshold: 120 }
        ] });
        cdp.on('Log.entryAdded', ({ entry }) => {
            if (entry?.source !== 'violation') return;
            report.violations.push({ at: Date.now(), text: entry.text || '', url: entry.url || '' });
            if (report.violations.length > 100) report.violations.shift();
        });
    } catch (error) {
        event('cdp-setup', error?.message || error);
    }

    page.on('pageerror', (error) => event('pageerror', error?.stack || error));
    page.on('crash', () => {
        event('crash', 'renderer process crashed');
        if (!report.stall) report.stall = { detectedAt: new Date().toISOString(), classification: 'Renderer process crashed.' };
        save('crash');
        if (config.strict) process.exitCode = 1;
    });
    page.once('close', () => { stop('page-close').catch(() => {}); });

    await probe();
    interval = setInterval(() => { probe().catch(() => {}); }, config.intervalMs);
    return controller;
}

function instrumentContext(context, config) {
    if (!context || patchedContexts.has(context)) return context;
    patchedContexts.add(context);
    const originalNewPage = context.newPage.bind(context);
    context.newPage = async (...args) => {
        const page = await originalNewPage(...args);
        await attachRendererWatchdog(page, config);
        return page;
    };
    context.on('page', (page) => { attachRendererWatchdog(page, config).catch(() => {}); });
    for (const page of context.pages()) attachRendererWatchdog(page, config).catch(() => {});
    return context;
}

function instrumentBrowser(browser, overrides = {}) {
    const config = options(overrides);
    if (!config.enabled || !browser || patchedBrowsers.has(browser)) return browser;
    patchedBrowsers.add(browser);
    const originalNewContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
        const context = await originalNewContext(...args);
        return instrumentContext(context, config);
    };
    for (const context of browser.contexts?.() || []) instrumentContext(context, config);
    return browser;
}

module.exports = { attachRendererWatchdog, instrumentBrowser, instrumentContext, options };
