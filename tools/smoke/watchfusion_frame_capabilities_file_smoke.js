#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { launchChromiumOrConnect } = require('./playwright-browser');

const ROOT = path.resolve(__dirname, '..', '..');
const fileUrl = pathToFileURL(path.join(ROOT, 'EveOS.html'));
fileUrl.searchParams.set('watchfusionFrameCapabilitiesSmoke', '1');

async function main() {
    const launched = await launchChromiumOrConnect({ headless: !process.argv.includes('--headed') });
    const browser = launched.browser;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    page.on('pageerror', (error) => {
        console.error('[PAGEERROR]', error?.stack || error?.message || String(error));
    });

    try {
        await page.goto(fileUrl.href, { waitUntil: 'domcontentloaded', timeout: 180000 });
        await page.waitForFunction(() => window.__eveWatchFusionFrameCapabilitiesReady === true, undefined, {
            timeout: 120000
        });

        const result = await page.evaluate(() => {
            const existing = document.getElementById('watchfusion-overlay');
            if (existing) existing.remove();

            const overlay = document.createElement('section');
            overlay.id = 'watchfusion-overlay';
            overlay.innerHTML = '<div class="watchfusion-frame-wrap" data-frame-state="idle">'
                + '<iframe class="watchfusion-frame" hidden allow="autoplay; encrypted-media; fullscreen; picture-in-picture; web-share"></iframe>'
                + '<div class="watchfusion-frame-loading"><span data-wf-frame-detail></span><button data-wf-frame-retry hidden>Retry</button></div>'
                + '</div>';
            document.body.appendChild(overlay);

            window.dispatchEvent(new CustomEvent('eve:watchfusion-status', {
                detail: { running: false, state: 'stopped' }
            }));

            const frame = overlay.querySelector('.watchfusion-frame');
            const refreshed = window.EveWatchFusionFrameCapabilities?.refresh?.() === true;
            const allow = String(frame?.getAttribute('allow') || '');
            const protocol = location.protocol;

            overlay.remove();
            return {
                protocol,
                refreshed,
                allow,
                ready: window.__eveWatchFusionFrameCapabilitiesReady === true
            };
        });

        assert.equal(result.protocol, 'file:', 'Smoke must exercise the file:// EveOS surface');
        assert.equal(result.ready, true, 'Frame capability companion must load from file://');
        assert.equal(result.refreshed, true, 'Lifecycle binding must find and patch the WatchFusion frame');
        assert.match(result.allow, /(?:^|;\s*)webgpu(?:;|$)/i, 'Patched frame must include webgpu capability');

        console.log('WATCHFUSION_FRAME_CAPABILITIES_FILE_SMOKE_OK');
        console.log(JSON.stringify(result));
    } finally {
        try { await context.close(); } catch (_) {}
        try { await browser.close(); } catch (_) {}
    }
}

main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
});
