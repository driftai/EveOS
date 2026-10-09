'use strict';

const STARTUP = require('./audioflix_spotify_browser_startup.json');
const EDGE_LAUNCH_TIMEOUT_MS = Number(STARTUP.edgeLaunchTimeoutMs || 45000);
const CHROMIUM_LAUNCH_TIMEOUT_MS = Number(STARTUP.chromiumLaunchTimeoutMs || 45000);
const NAVIGATION_TIMEOUT_MS = Number(STARTUP.navigationTimeoutMs || 30000);

function setPhase(runtime, note, phase) {
    runtime.phase = phase;
    note('startup-phase', phase);
}

async function launchManagedContext(chromium, profileDir, launchOptions, headlessRequested, runtime, note) {
    let context;
    if (process.platform === 'win32') {
        try {
            setPhase(runtime, note, 'launch-edge');
            context = await chromium.launchPersistentContext(profileDir, {
                ...launchOptions, channel: 'msedge', timeout: EDGE_LAUNCH_TIMEOUT_MS
            });
            runtime.browserChannel = headlessRequested ? 'msedge-headless' : 'msedge';
            return context;
        } catch (edgeError) {
            note('launch-error', `Edge unavailable: ${edgeError.message}`);
        }
    }
    setPhase(runtime, note, 'launch-chromium');
    context = await chromium.launchPersistentContext(profileDir, {
        ...launchOptions, timeout: CHROMIUM_LAUNCH_TIMEOUT_MS
    });
    runtime.browserChannel = headlessRequested ? 'playwright-chromium-headless' : 'playwright-chromium';
    return context;
}

async function prepareManagedPage(context, pageUrl, runtime, note = () => {}) {
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
    launchManagedContext,
    prepareManagedPage
};
