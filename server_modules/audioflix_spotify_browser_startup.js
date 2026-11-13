'use strict';

const STARTUP = require('./audioflix_spotify_browser_startup.json');
const fs = require('node:fs');
const path = require('node:path');
const EDGE_LAUNCH_TIMEOUT_MS = Number(STARTUP.edgeLaunchTimeoutMs || 45000);
const CHROMIUM_LAUNCH_TIMEOUT_MS = Number(STARTUP.chromiumLaunchTimeoutMs || 45000);
const NAVIGATION_TIMEOUT_MS = Number(STARTUP.navigationTimeoutMs || 30000);

function edgeBetaExecutable() {
    if (process.platform !== 'win32') throw new Error('Microsoft Edge Beta is Windows-only.');
    const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean);
    const candidate = roots.map(root => path.join(root, 'Microsoft', 'Edge Beta', 'Application', 'msedge.exe'))
        .find(exe => fs.existsSync(exe));
    if (!candidate) throw new Error('Microsoft Edge Beta is missing; refusing Stable/Chromium fallback.');
    return candidate;
}

function setPhase(runtime, note, phase) {
    runtime.phase = phase;
    note('startup-phase', phase);
}

async function launchManagedContext(chromium, profileDir, launchOptions, headlessRequested, runtime, note) {
    let context;
    if (process.platform === 'win32') {
        setPhase(runtime, note, 'launch-edge-beta');
        context = await chromium.launchPersistentContext(profileDir, {
            ...launchOptions, executablePath: edgeBetaExecutable(), timeout: EDGE_LAUNCH_TIMEOUT_MS
        });
        runtime.browserChannel = headlessRequested ? 'msedge-beta-headless' : 'msedge-beta';
        return context;
    }
    setPhase(runtime, note, 'launch-chromium');
    context = await chromium.launchPersistentContext(profileDir, {
        ...launchOptions, timeout: CHROMIUM_LAUNCH_TIMEOUT_MS
    });
    runtime.browserChannel = headlessRequested ? 'playwright-chromium-headless' : 'playwright-chromium';
    return context;
}

async function prepareManagedPage(context, pageUrl, runtimeOrNote = {}, noteArg) {
    let runtime = runtimeOrNote;
    let note = noteArg;
    // Preserve the original prepareManagedPage(context, url, note) contract used by offline smokes.
    if (typeof runtimeOrNote === 'function') {
        note = runtimeOrNote;
        runtime = {};
    }
    if (!runtime || typeof runtime !== 'object') runtime = {};
    if (typeof note !== 'function') note = () => {};
    setPhase(runtime, note, 'navigate');
    const existing = context.pages();
    const page = existing[0] || await context.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    // Persistent Edge can restore tabs from an unclean prior helper shutdown. Give restoration a
    // brief chance to settle, then enforce the one-engine-page invariant before accepting commands.
    await new Promise((resolve) => setTimeout(resolve, 50));
    let closed = 0;
    for (const extra of context.pages()) {
        if (extra === page) continue;
        try { await extra.close(); closed += 1; } catch {}
    }
    if (closed) note('page-prune', `closed ${closed} restored/blank managed tabs`);
    return page;
}

module.exports = {
    EDGE_LAUNCH_TIMEOUT_MS,
    CHROMIUM_LAUNCH_TIMEOUT_MS,
    NAVIGATION_TIMEOUT_MS,
    edgeBetaExecutable,
    launchManagedContext,
    prepareManagedPage
};
