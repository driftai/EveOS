#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { launchChromiumOrConnect } = require('./playwright-browser');

const ROOT = path.resolve(__dirname, '..', '..');
const PORTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'eveos-ports.json'), 'utf8')).ports;
const WEB_PORT = Number(PORTS.EVEOS_WEB_PORT.port);
const LOCALHOST_URL = `http://127.0.0.1:${WEB_PORT}/EveOS.html?debugGeminiBoot=1`;
const REPORT_DIR = path.join(ROOT, 'data', 'runtime', 'smoke-results');
const STALL_MS = 1400;
const OBSERVE_AFTER_READY_MS = 8000;

function argValue(name) {
    const prefix = `${name}=`;
    const direct = process.argv.find((arg) => arg.startsWith(prefix));
    if (direct) return direct.slice(prefix.length);
    const index = process.argv.indexOf(name);
    if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
    return '';
}

const HEADLESS = process.argv.includes('--headless');
const HIDE_RUNTIME = process.argv.includes('--hidden-runtime');
const BLOCK_SCRIPT = argValue('--block-script').trim();

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
    let timer = null;
    return Promise.race([
        Promise.resolve(promise).finally(() => {
            if (timer) clearTimeout(timer);
        }),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        })
    ]);
}

function sourceExcerpt(source, oneBasedLine, radius = 10) {
    const lines = String(source || '').split(/\r?\n/);
    const center = Math.max(1, Number(oneBasedLine || 1));
    const start = Math.max(1, center - radius);
    const end = Math.min(lines.length, center + radius);
    return {
        startLine: start,
        endLine: end,
        text: lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n')
    };
}

function compactFrame(frame, scriptMeta, contextMeta, frameMeta) {
    const scriptId = String(frame?.location?.scriptId || '');
    const script = scriptMeta.get(scriptId) || {};
    const executionContextId = Number(script.executionContextId || 0) || null;
    const context = executionContextId ? (contextMeta.get(executionContextId) || {}) : {};
    const frameId = context?.auxData?.frameId || '';
    const pageFrame = frameId ? (frameMeta.get(frameId) || {}) : {};
    return {
        functionName: frame?.functionName || '(anonymous)',
        scriptId,
        url: frame?.url || script?.url || '',
        line: Number(frame?.location?.lineNumber || 0) + 1,
        column: Number(frame?.location?.columnNumber || 0) + 1,
        executionContextId,
        contextOrigin: context?.origin || '',
        contextName: context?.name || '',
        frameId,
        frameUrl: pageFrame.url || ''
    };
}

async function main() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const launched = await launchChromiumOrConnect({ headless: HEADLESS });
    const browser = launched.browser;
    const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const browserCdp = typeof browser.newBrowserCDPSession === 'function'
        ? await browser.newBrowserCDPSession()
        : null;

    const report = {
        startedAt: new Date().toISOString(),
        url: LOCALHOST_URL,
        browserMode: launched.mode,
        headless: HEADLESS,
        hiddenRuntime: HIDE_RUNTIME,
        blockScript: BLOCK_SCRIPT || null,
        blockedScripts: [],
        freeze: null,
        final: null
    };

    const scriptMeta = new Map();
    const contextMeta = new Map();
    const frameMeta = new Map();
    let lastHeartbeatWall = Date.now();
    let readyObserved = false;
    let readyWall = 0;
    let diagnosticStarted = false;

    await cdp.send('Runtime.enable');
    await cdp.send('Debugger.enable');
    await cdp.send('Page.enable');

    cdp.on('Runtime.executionContextCreated', ({ context: created }) => {
        if (!created?.id) return;
        contextMeta.set(Number(created.id), created);
    });
    cdp.on('Debugger.scriptParsed', (payload) => {
        if (!payload?.scriptId) return;
        scriptMeta.set(String(payload.scriptId), {
            scriptId: String(payload.scriptId),
            url: payload.url || '',
            executionContextId: payload.executionContextId || null,
            startLine: payload.startLine || 0,
            endLine: payload.endLine || 0,
            hash: payload.hash || ''
        });
    });
    cdp.on('Page.frameNavigated', ({ frame }) => {
        if (!frame?.id) return;
        frameMeta.set(frame.id, { id: frame.id, url: frame.url || '', parentId: frame.parentId || '' });
    });

    if (BLOCK_SCRIPT) {
        const needle = BLOCK_SCRIPT.toLowerCase();
        await page.route('**/*', async (route) => {
            const request = route.request();
            const url = request.url();
            if (request.resourceType() === 'script' && url.toLowerCase().includes(needle)) {
                report.blockedScripts.push(url);
                console.log(`[DIAG_BLOCKED_SCRIPT] ${url}`);
                await route.abort('blockedbyclient');
                return;
            }
            await route.continue();
        });
    }

    await page.addInitScript(() => {
        // Playwright init scripts run in every frame. Only the top document should drive the
        // watchdog; otherwise five healthy iframe heartbeats can hide a frozen EveOS renderer.
        if (window.top !== window) return;
        window.__EVE_GEMINI_HOTLOOP_PROBE = {
            heartbeatCount: 0,
            lastHeartbeat: performance.now()
        };
        window.setInterval(() => {
            const state = window.__EVE_GEMINI_HOTLOOP_PROBE;
            state.heartbeatCount += 1;
            state.lastHeartbeat = performance.now();
            console.log('[GEMINI_HOTLOOP_HEARTBEAT]', JSON.stringify({
                count: state.heartbeatCount,
                perfMs: Math.round(state.lastHeartbeat),
                ready: !!window.__GEMINI_WORKSPACE_READY,
                settled: !!window.__GEMINI_WORKSPACE_SETTLED,
                settling: !!window.__GEMINI_WORKSPACE_SETTLING
            }));
        }, 400);
        window.addEventListener('eve:gemini-workspace-ready', () => {
            console.log('[GEMINI_HOTLOOP_READY]', JSON.stringify({
                perfMs: Math.round(performance.now()),
                ready: window.__GEMINI_WORKSPACE_READY || null
            }));
        }, true);
    });

    page.on('console', (message) => {
        const text = message.text();
        if (text.includes('[GEMINI_HOTLOOP_HEARTBEAT]')) lastHeartbeatWall = Date.now();
        if (text.includes('[GEMINI_HOTLOOP_READY]')) {
            readyObserved = true;
            readyWall = Date.now();
            lastHeartbeatWall = readyWall;
        }
        if (/GEMINI_HOTLOOP|Gemini Init:|Initialization Coordinator:|initializeAllHtmlComponents finished/i.test(text)) {
            console.log(`[PAGE:${message.type()}] ${text}`);
        }
    });
    page.on('pageerror', (error) => console.log(`[PAGEERROR] ${error?.stack || error}`));
    page.on('crash', () => console.log('[PAGE_CRASH] renderer process crashed'));

    async function captureFreeze(reason) {
        if (diagnosticStarted) return;
        diagnosticStarted = true;
        console.log(`\n=== HOT LOOP DETECTED: ${reason} ===`);
        const freeze = {
            reason,
            detectedAt: new Date().toISOString(),
            heartbeatGapMs: Date.now() - lastHeartbeatWall,
            processCpu: [],
            stack: [],
            sources: []
        };
        report.freeze = freeze;

        if (browserCdp) {
            try {
                const before = await withTimeout(browserCdp.send('SystemInfo.getProcessInfo'), 2500, 'process info before');
                await delay(1000);
                const after = await withTimeout(browserCdp.send('SystemInfo.getProcessInfo'), 2500, 'process info after');
                const previous = new Map((before.processInfo || []).map((item) => [item.id, Number(item.cpuTime || 0)]));
                freeze.processCpu = (after.processInfo || []).map((item) => ({
                    id: item.id,
                    type: item.type,
                    cpuDeltaSec: Number((Number(item.cpuTime || 0) - Number(previous.get(item.id) || 0)).toFixed(4))
                })).sort((a, b) => b.cpuDeltaSec - a.cpuDeltaSec).slice(0, 12);
                console.log('[PROCESS_CPU_DELTA_1S] ' + JSON.stringify(freeze.processCpu));
            } catch (error) {
                console.log('[PROCESS_CPU_ERROR] ' + (error?.message || String(error)));
            }
        }

        const paused = await new Promise(async (resolve) => {
            let timer = null;
            const handler = (payload) => {
                if (timer) clearTimeout(timer);
                cdp.off('Debugger.paused', handler);
                resolve(payload);
            };
            cdp.on('Debugger.paused', handler);
            timer = setTimeout(() => {
                cdp.off('Debugger.paused', handler);
                resolve(null);
            }, 3500);
            try {
                await cdp.send('Debugger.pause');
            } catch (error) {
                console.log('[DEBUGGER_PAUSE_ERROR] ' + (error?.message || String(error)));
            }
        });

        if (!paused) {
            console.log('[DEBUGGER_PAUSED_STACK] no paused event');
            try { await cdp.send('Runtime.terminateExecution'); } catch (_) {}
            return;
        }

        freeze.stack = (paused.callFrames || []).slice(0, 12).map((frame) => (
            compactFrame(frame, scriptMeta, contextMeta, frameMeta)
        ));
        console.log('[DEBUGGER_PAUSED_STACK] ' + JSON.stringify(freeze.stack, null, 2));

        const seenScripts = new Set();
        for (const callFrame of (paused.callFrames || []).slice(0, 8)) {
            const scriptId = String(callFrame?.location?.scriptId || '');
            if (!scriptId || seenScripts.has(scriptId)) continue;
            seenScripts.add(scriptId);
            try {
                const payload = await withTimeout(cdp.send('Debugger.getScriptSource', { scriptId }), 2500, `getScriptSource ${scriptId}`);
                const source = payload?.scriptSource || '';
                const frame = compactFrame(callFrame, scriptMeta, contextMeta, frameMeta);
                const excerpt = sourceExcerpt(source, frame.line, 12);
                const item = {
                    ...frame,
                    sourceLength: source.length,
                    sourceStartLine: excerpt.startLine,
                    sourceEndLine: excerpt.endLine,
                    sourceExcerpt: excerpt.text
                };
                freeze.sources.push(item);
                console.log('[DEBUGGER_SOURCE_EXCERPT] ' + JSON.stringify(item, null, 2));
            } catch (error) {
                console.log(`[DEBUGGER_SOURCE_ERROR] scriptId=${scriptId} ${error?.message || error}`);
            }
        }

        try {
            await withTimeout(cdp.send('Debugger.resume', { terminateOnResume: true }), 2500, 'Debugger.resume terminateOnResume');
        } catch (error) {
            console.log('[DEBUGGER_TERMINATE_ERROR] ' + (error?.message || String(error)));
        }
    }

    try {
        console.log('=== GEMINI RENDERER HOT LOOP SOURCE PROBE ===');
        console.log(`mode=${HIDE_RUNTIME ? 'hidden-runtime' : 'normal'} browser=${HEADLESS ? 'headless' : 'headed'} blockScript=${BLOCK_SCRIPT || '(none)'}`);
        await page.goto(LOCALHOST_URL, { waitUntil: 'domcontentloaded', timeout: 240000 });
        await page.waitForFunction(() => (
            !!window.SearchMonitorBoot
            && !!window.EveOSSearchMonitorAiHome
            && !!document.querySelector('[data-gemini-monitor-view-btn="full"]')
            && !!document.querySelector('[data-ai-provider="gemini"]')
        ), undefined, { timeout: 120000 });

        await page.evaluate(() => window.SearchMonitorBoot?.expand?.());
        await page.locator('[data-gemini-monitor-view-btn="full"]').click();
        const provider = page.locator('[data-ai-provider="gemini"]');
        if (!(await provider.getAttribute('open'))) await provider.locator(':scope > summary').click();
        await page.waitForFunction(() => document.querySelector('[data-ai-provider="gemini"]')?.open === true,
            undefined, { timeout: 10000 });

        if (HIDE_RUNTIME) {
            await page.evaluate(() => {
                const host = document.getElementById('gemini-provider-runtime-host');
                if (host) host.style.setProperty('display', 'none', 'important');
            });
            console.log('[DIAG] Gemini runtime host hidden before workspace load.');
        }

        console.log('[DIAG] Clicking Load Gemini Workspace...');
        await page.locator('[data-gemini-provider-load]').click();
        const clickedAt = Date.now();

        while (!diagnosticStarted && Date.now() - clickedAt < 90000) {
            const gap = Date.now() - lastHeartbeatWall;
            if (gap >= STALL_MS) {
                await captureFreeze(readyObserved
                    ? `top-frame heartbeat stalled ${gap}ms after workspace-ready`
                    : `top-frame heartbeat stalled ${gap}ms during workspace boot`);
                break;
            }
            if (readyObserved && Date.now() - readyWall >= OBSERVE_AFTER_READY_MS) break;
            await delay(200);
        }

        if (!diagnosticStarted) {
            report.final = {
                status: readyObserved ? 'responsive-after-ready' : 'no-ready-event',
                readyObserved,
                heartbeatGapMs: Date.now() - lastHeartbeatWall
            };
            console.log('[FINAL_RESPONSIVE_STATE] ' + JSON.stringify(report.final));
        } else {
            report.final = {
                status: 'freeze-diagnosed',
                readyObserved,
                heartbeatGapMs: Date.now() - lastHeartbeatWall
            };
        }
    } finally {
        const name = `gemini-renderer-hotloop-${Date.now()}.json`;
        const reportPath = path.join(REPORT_DIR, name);
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
        console.log(`[DIAGNOSTIC_REPORT] ${path.relative(ROOT, reportPath).replace(/\\/g, '/')}`);
        try { await context.close(); } catch (_) {}
        try { await browser.close(); } catch (_) {}
    }
}

main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
});
