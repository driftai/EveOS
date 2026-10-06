#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { launchChromiumOrConnect } = require('./playwright-browser');

const ROOT = path.resolve(__dirname, '..', '..');
const PORTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'eveos-ports.json'), 'utf8')).ports;
const WEB_PORT = Number(PORTS.EVEOS_WEB_PORT.port);
const LOCALHOST_URL = `http://127.0.0.1:${WEB_PORT}/EveOS.html?debugGeminiBoot=1`;
const HIDE_RUNTIME = process.argv.includes('--hidden-runtime');
const HEADLESS = process.argv.includes('--headless');
const STALL_MS = 1400;
const OBSERVE_AFTER_READY_MS = 8000;
const REPORT_DIR = path.join(ROOT, 'data', 'runtime', 'smoke-results');

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
    let timer = null;
    return Promise.race([
        promise.finally(() => {
            if (timer) clearTimeout(timer);
        }),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        })
    ]);
}

function summarizeStack(paused) {
    const frames = Array.isArray(paused?.callFrames) ? paused.callFrames : [];
    return frames.slice(0, 12).map((frame) => ({
        functionName: frame.functionName || '(anonymous)',
        url: frame.url || '',
        line: Number(frame.location?.lineNumber || 0) + 1,
        column: Number(frame.location?.columnNumber || 0) + 1
    }));
}

function processMap(snapshot) {
    const map = new Map();
    for (const item of snapshot?.processInfo || []) {
        map.set(item.id, {
            id: item.id,
            type: item.type,
            cpuTime: Number(item.cpuTime || 0)
        });
    }
    return map;
}

function processCpuDelta(before, after) {
    const a = processMap(before);
    const b = processMap(after);
    const rows = [];
    for (const [id, next] of b.entries()) {
        const prev = a.get(id);
        rows.push({
            id,
            type: next.type,
            cpuDeltaSec: Number((next.cpuTime - Number(prev?.cpuTime || 0)).toFixed(4)),
            cpuTimeSec: Number(next.cpuTime.toFixed(4))
        });
    }
    return rows.sort((x, y) => y.cpuDeltaSec - x.cpuDeltaSec);
}

async function pageEvaluateHealthy(cdp) {
    try {
        const result = await withTimeout(cdp.send('Runtime.evaluate', {
            expression: `({
                now: performance.now(),
                ready: !!window.__GEMINI_WORKSPACE_READY,
                settled: !!window.__GEMINI_WORKSPACE_SETTLED,
                settling: !!window.__GEMINI_WORKSPACE_SETTLING,
                nodes: document.body ? document.body.getElementsByTagName('*').length : 0
            })`,
            returnByValue: true,
            awaitPromise: false
        }), 2500, 'Runtime.evaluate');
        return { ok: true, value: result?.result?.value || null };
    } catch (error) {
        return { ok: false, error: error?.message || String(error) };
    }
}

async function main() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const startedAt = Date.now();
    const launched = await launchChromiumOrConnect({ headless: HEADLESS });
    const browser = launched.browser;
    const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
    const page = await context.newPage();
    const pageCdp = await context.newCDPSession(page);
    const browserCdp = typeof browser.newBrowserCDPSession === 'function'
        ? await browser.newBrowserCDPSession()
        : null;

    const report = {
        startedAt: new Date(startedAt).toISOString(),
        url: LOCALHOST_URL,
        browserMode: launched.mode,
        headless: HEADLESS,
        hiddenRuntime: HIDE_RUNTIME,
        events: [],
        violations: [],
        freeze: null,
        final: null
    };

    let lastHeartbeatWall = Date.now();
    let readyObserved = false;
    let settledObserved = false;
    let readyWall = 0;
    let diagnosticStarted = false;

    await page.addInitScript(() => {
        window.__EVE_GEMINI_FREEZE_DIAG = {
            startedAt: Date.now(),
            heartbeatCount: 0,
            lastHeartbeat: performance.now()
        };

        window.setInterval(() => {
            const state = window.__EVE_GEMINI_FREEZE_DIAG;
            state.heartbeatCount += 1;
            state.lastHeartbeat = performance.now();
            console.log('[GEMINI_FREEZE_DIAG_HEARTBEAT]', JSON.stringify({
                count: state.heartbeatCount,
                perfMs: Math.round(state.lastHeartbeat),
                ready: !!window.__GEMINI_WORKSPACE_READY,
                settled: !!window.__GEMINI_WORKSPACE_SETTLED,
                settling: !!window.__GEMINI_WORKSPACE_SETTLING
            }));
        }, 400);

        window.addEventListener('eve:gemini-workspace-ready', () => {
            console.log('[GEMINI_FREEZE_DIAG_READY]', JSON.stringify({
                perfMs: Math.round(performance.now()),
                ready: window.__GEMINI_WORKSPACE_READY || null
            }));
        }, true);

        window.addEventListener('eve:gemini-workspace-settled', () => {
            console.log('[GEMINI_FREEZE_DIAG_SETTLED]', JSON.stringify({
                perfMs: Math.round(performance.now()),
                settled: window.__GEMINI_WORKSPACE_SETTLED || null
            }));
        }, true);
    });

    page.on('console', (message) => {
        const text = message.text();
        if (text.includes('[GEMINI_FREEZE_DIAG_HEARTBEAT]')) {
            lastHeartbeatWall = Date.now();
        }
        if (text.includes('[GEMINI_FREEZE_DIAG_READY]')) {
            readyObserved = true;
            readyWall = Date.now();
            lastHeartbeatWall = readyWall;
        }
        if (text.includes('[GEMINI_FREEZE_DIAG_SETTLED]')) {
            settledObserved = true;
            lastHeartbeatWall = Date.now();
        }
        if (/GEMINI_FREEZE_DIAG|Gemini Init:|Initialization Coordinator:|initializeAllHtmlComponents finished/i.test(text)) {
            console.log(`[PAGE:${message.type()}] ${text}`);
        }
        report.events.push({ at: Date.now(), type: `console:${message.type()}`, text: text.slice(0, 4000) });
    });
    page.on('pageerror', (error) => {
        const text = error?.stack || String(error);
        console.log(`[PAGEERROR] ${text}`);
        report.events.push({ at: Date.now(), type: 'pageerror', text: text.slice(0, 12000) });
    });
    page.on('crash', () => {
        console.log('[PAGE_CRASH] renderer process crashed');
        report.events.push({ at: Date.now(), type: 'page-crash', text: 'renderer process crashed' });
    });

    await pageCdp.send('Runtime.enable');
    await pageCdp.send('Debugger.enable');
    await pageCdp.send('Log.enable');
    await pageCdp.send('Log.startViolationsReport', {
        config: [
            { name: 'longTask', threshold: 100 },
            { name: 'longLayout', threshold: 100 },
            { name: 'blockedEvent', threshold: 100 },
            { name: 'recurringHandler', threshold: 100 }
        ]
    });
    pageCdp.on('Log.entryAdded', ({ entry }) => {
        if (entry?.source !== 'violation') return;
        const item = {
            at: Date.now(),
            text: entry.text || '',
            url: entry.url || '',
            lineNumber: entry.lineNumber || 0,
            stackTrace: entry.stackTrace || null
        };
        report.violations.push(item);
        console.log(`[VIOLATION] ${item.text}${item.url ? ` @ ${item.url}:${item.lineNumber}` : ''}`);
    });

    async function diagnoseFreeze(reason) {
        if (diagnosticStarted) return;
        diagnosticStarted = true;
        console.log(`\n=== FREEZE DETECTED: ${reason} ===`);

        const freeze = {
            reason,
            detectedAt: new Date().toISOString(),
            heartbeatGapMs: Date.now() - lastHeartbeatWall,
            readyObserved,
            settledObserved,
            processCpu: [],
            debuggerPause: null,
            terminateAttempted: false,
            recoveredAfterTerminate: null
        };
        report.freeze = freeze;

        if (browserCdp) {
            try {
                const before = await withTimeout(browserCdp.send('SystemInfo.getProcessInfo'), 2500, 'SystemInfo.getProcessInfo before');
                await delay(1000);
                const after = await withTimeout(browserCdp.send('SystemInfo.getProcessInfo'), 2500, 'SystemInfo.getProcessInfo after');
                freeze.processCpu = processCpuDelta(before, after).slice(0, 12);
                console.log('[PROCESS_CPU_DELTA_1S] ' + JSON.stringify(freeze.processCpu));
            } catch (error) {
                freeze.processCpuError = error?.message || String(error);
                console.log('[PROCESS_CPU_ERROR] ' + freeze.processCpuError);
            }
        }

        let pausedPayload = null;
        const pausedPromise = new Promise((resolve) => {
            const handler = (payload) => {
                pageCdp.off('Debugger.paused', handler);
                resolve(payload);
            };
            pageCdp.on('Debugger.paused', handler);
            setTimeout(() => {
                pageCdp.off('Debugger.paused', handler);
                resolve(null);
            }, 3000);
        });

        try {
            await withTimeout(pageCdp.send('Debugger.pause'), 2500, 'Debugger.pause');
        } catch (error) {
            freeze.debuggerPauseCommandError = error?.message || String(error);
            console.log('[DEBUGGER_PAUSE_COMMAND_ERROR] ' + freeze.debuggerPauseCommandError);
        }
        pausedPayload = await pausedPromise;
        if (pausedPayload) {
            freeze.debuggerPause = {
                reason: pausedPayload.reason || '',
                stack: summarizeStack(pausedPayload)
            };
            console.log('[DEBUGGER_PAUSED_STACK] ' + JSON.stringify(freeze.debuggerPause.stack, null, 2));
            try {
                await withTimeout(pageCdp.send('Debugger.resume', { terminateOnResume: true }), 2500, 'Debugger.resume terminateOnResume');
                freeze.terminateAttempted = true;
            } catch (error) {
                freeze.terminateError = error?.message || String(error);
                console.log('[DEBUGGER_TERMINATE_ERROR] ' + freeze.terminateError);
            }
        } else {
            console.log('[DEBUGGER_PAUSED_STACK] no paused event; attempting Runtime.terminateExecution');
            try {
                await withTimeout(pageCdp.send('Runtime.terminateExecution'), 2500, 'Runtime.terminateExecution');
                freeze.terminateAttempted = true;
            } catch (error) {
                freeze.terminateError = error?.message || String(error);
                console.log('[RUNTIME_TERMINATE_ERROR] ' + freeze.terminateError);
            }
        }

        await delay(700);
        freeze.recoveredAfterTerminate = await pageEvaluateHealthy(pageCdp);
        console.log('[POST_TERMINATE_EVALUATE] ' + JSON.stringify(freeze.recoveredAfterTerminate));

        const topRenderer = freeze.processCpu.find((row) => row.type === 'renderer');
        if (freeze.debuggerPause?.stack?.length) {
            freeze.classification = 'JavaScript execution was interruptible; inspect DEBUGGER_PAUSED_STACK for the blocking call path.';
        } else if (freeze.recoveredAfterTerminate?.ok) {
            freeze.classification = 'Renderer recovered after terminating execution; a runaway or very long JavaScript task is likely.';
        } else if (topRenderer && topRenderer.cpuDeltaSec >= 0.5) {
            freeze.classification = 'Renderer stayed CPU-hot but V8 did not pause/recover; suspect native style/layout/paint/compositor work rather than a JavaScript loop.';
        } else {
            freeze.classification = 'Renderer was unresponsive without a clear CPU-hot JavaScript signature; suspect compositor/GPU/renderer IPC stall or a native blocking path.';
        }
        console.log('[CLASSIFICATION] ' + freeze.classification);
    }

    try {
        console.log(`=== GEMINI RENDERER FREEZE DIAGNOSTIC ===`);
        console.log(`mode=${HIDE_RUNTIME ? 'hidden-runtime' : 'normal'} browser=${HEADLESS ? 'headless' : 'headed'} url=${LOCALHOST_URL}`);
        await page.goto(LOCALHOST_URL, { waitUntil: 'domcontentloaded', timeout: 240000 });
        await page.waitForFunction(() => (
            !!window.SearchMonitorBoot
            && !!window.EveOSSearchMonitorAiHome
            && !!document.querySelector('[data-gemini-monitor-view-btn="full"]')
            && !!document.querySelector('[data-ai-provider="gemini"]')
        ), undefined, { timeout: 120000 });

        await page.evaluate(() => window.SearchMonitorBoot?.expand?.());
        await page.locator('[data-gemini-monitor-view-btn="full"]').click();
        const geminiProvider = page.locator('[data-ai-provider="gemini"]');
        if (!(await geminiProvider.getAttribute('open'))) {
            await geminiProvider.locator(':scope > summary').click();
        }
        await page.waitForFunction(() => document.querySelector('[data-ai-provider="gemini"]')?.open === true,
            undefined, { timeout: 10000 });

        if (HIDE_RUNTIME) {
            await page.evaluate(() => {
                const host = document.getElementById('gemini-provider-runtime-host');
                if (host) {
                    host.style.setProperty('display', 'none', 'important');
                    host.dataset.freezeDiagHidden = '1';
                }
            });
            console.log('[DIAG] Gemini runtime host hidden before workspace load.');
        }

        console.log('[DIAG] Clicking Load Gemini Workspace...');
        await page.locator('[data-gemini-provider-load]').click();
        const clickedAt = Date.now();

        while (!diagnosticStarted && Date.now() - clickedAt < 90000) {
            const gap = Date.now() - lastHeartbeatWall;
            if (gap >= STALL_MS) {
                await diagnoseFreeze(readyObserved
                    ? `heartbeat stalled ${gap}ms after workspace-ready`
                    : `heartbeat stalled ${gap}ms during workspace boot`);
                break;
            }
            if (readyObserved && Date.now() - readyWall >= OBSERVE_AFTER_READY_MS) {
                break;
            }
            await delay(200);
        }

        if (!diagnosticStarted) {
            const healthy = await pageEvaluateHealthy(pageCdp);
            report.final = {
                status: readyObserved ? 'responsive-after-ready' : 'no-ready-event',
                readyObserved,
                settledObserved,
                heartbeatGapMs: Date.now() - lastHeartbeatWall,
                evaluate: healthy
            };
            console.log('[FINAL_RESPONSIVE_STATE] ' + JSON.stringify(report.final));
            if (HIDE_RUNTIME && readyObserved && healthy.ok) {
                console.log('[CLASSIFICATION] Hiding the Gemini runtime host avoided the freeze; style/layout/paint/compositor pressure is strongly implicated.');
            }
        } else {
            report.final = {
                status: 'freeze-diagnosed',
                readyObserved,
                settledObserved,
                heartbeatGapMs: Date.now() - lastHeartbeatWall
            };
        }
    } finally {
        const fileName = `gemini-renderer-freeze-${HIDE_RUNTIME ? 'hidden-runtime' : 'normal'}-${Date.now()}.json`;
        const reportPath = path.join(REPORT_DIR, fileName);
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
        console.log(`[DIAGNOSTIC_REPORT] ${path.relative(ROOT, reportPath).replace(/\\/g, '/')}`);
        try { await pageCdp.send('Log.stopViolationsReport'); } catch (_) {}
        try { await context.close(); } catch (_) {}
        try { await browser.close(); } catch (_) {}
    }
}

main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
});
