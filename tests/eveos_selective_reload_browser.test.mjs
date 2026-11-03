#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sharedClient = fs.readFileSync(path.join(ROOT, 'js/modules/core/eveos-service-reload.js'), 'utf8');
const sharedUi = fs.readFileSync(path.join(ROOT, 'js/modules/core/eveos-service-reload-ui.js'), 'utf8');
const updateUi = fs.readFileSync(path.join(ROOT, 'js/modules/gemini/search_monitor/searchMonitorUpdates.js'), 'utf8');
const spotifySurface = fs.readFileSync(path.join(ROOT, 'js/modules/features/audioflix/audioflix.spotify.engine-surface.js'), 'utf8');
const watchFusionReload = fs.readFileSync(path.join(ROOT, 'js/modules/features/watchfusion/watchfusion.reload.js'), 'utf8');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const manifest = { window: {} };
vm.runInNewContext(read('js/config/manifest/styles.js'), manifest);
const entry = read('EveOS.html');
const monitor = entry.slice(entry.indexOf('    <div id="loadingIndicator"'), entry.indexOf('    <!-- SCRIPTS -->'));
const styles = ['css/main.css', 'css/modules/gemini/gemini_link_surfaces.eveos-fixes.css', ...manifest.window.EveModuleManifestParts.styles];
const artifacts = path.join(ROOT, 'data/runtime/smoke-results/eveos-selective-reload-browser');
fs.mkdirSync(artifacts, { recursive: true });
const diagnostics = { layouts: [], console: [], pageErrors: [], requestFailures: [] };

async function assertToolbarLayout(page, scenario) {
    const metrics = await page.evaluate(() => {
        const rect = element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }; };
        const toolbar = document.querySelector('.gemini-monitor-toolbar-actions');
        const buttons = [...toolbar.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width > 0);
        const check = toolbar.querySelector('[data-search-monitor-check-updates]');
        const label = check.querySelector('[data-update-button-label]');
        return {
            toolbar: rect(toolbar), check: rect(check), label: rect(label),
            buttons: buttons.map(button => {
                const box = rect(button);
                const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                return { name: button.getAttribute('aria-label') || button.textContent.trim(), box, reachable: button === hit || button.contains(hit), overflow: button.scrollWidth > button.clientWidth + 1 };
            }),
            workspace: rect(document.querySelector('.gemini-monitor-workspace-shell')),
            workspaceHead: rect(document.querySelector('.gemini-monitor-workspace-head')),
            workspacePill: rect(document.querySelector('.gemini-monitor-workspace-pill'))
        };
    });
    diagnostics.layouts.push({ scenario, ...metrics });
    assert.ok(metrics.label.x >= metrics.check.x && metrics.label.right <= metrics.check.right + 1,
        `${scenario}: update label must fit its button`);
    for (const button of metrics.buttons) {
        const box = button.box;
        assert.ok(box.width > 0 && box.height > 0 && button.reachable, `${scenario}: ${button.name} must be pointer reachable`);
        assert.ok(box.x >= metrics.toolbar.x - 1 && box.right <= metrics.toolbar.right + 1 && !button.overflow,
            `${scenario}: ${button.name} must fit the toolbar without overflowing its button`);
        for (const other of metrics.buttons) {
            if (button === other) continue;
            const intersectionWidth = Math.min(box.right, other.box.right) - Math.max(box.x, other.box.x);
            const intersectionHeight = Math.min(box.bottom, other.box.bottom) - Math.max(box.y, other.box.y);
            assert.ok(intersectionWidth <= 1 || intersectionHeight <= 1, `${scenario}: ${button.name} overlaps ${other.name}`);
        }
    }
    assert.ok(metrics.workspacePill.right <= metrics.workspaceHead.right + 1,
        `${scenario}: workspace header pill must remain inside its header`);
}

const browser = await chromium.launch({ headless: true });
let page;
try {
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.context().tracing.start({ screenshots: true, snapshots: true });
    page.on('console', message => { if (['warning', 'error'].includes(message.type())) diagnostics.console.push(message.text()); });
    page.on('pageerror', error => diagnostics.pageErrors.push(String(error)));
    page.on('requestfailed', request => diagnostics.requestFailures.push({ url: request.url(), error: request.failure()?.errorText }));
    // Keep production markup, every manifest stylesheet, and their import order. Only
    // transport is isolated: no EveOS server or actual lifecycle process is launched.
    await page.route('https://eveos-fixture.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><head>${styles.map(file => `<link rel="stylesheet" href="/${file}">`).join('')}<link rel="stylesheet" href="https://fonts.googleapis.com/icon?family=Material+Icons"></head><body>${monitor}</body>` });
        return route.fulfill({ path: path.join(ROOT, pathname.slice(1)) });
    });
    await page.addInitScript(() => {
        if (location.origin === 'https://eveos-fixture.test') sessionStorage.clear();
    });
    await page.goto('https://eveos-fixture.test/fixture', { waitUntil: 'networkidle' });
    await page.addScriptTag({ content: read('js/modules/gemini/search_monitor/searchMonitorAiHome.markup.js') });
    await page.evaluate(() => {
        document.querySelector('#loadingIndicator').classList.remove('compact');
        document.querySelector('#loadingIndicator').classList.add('gemini-monitor-workspace-active');
        document.querySelector('#gemini-placeholder').innerHTML = `<div id="gemini-ui-root" class="gemini-monitor-shell" data-gemini-monitor-view="full">${window.EveOSSearchMonitorAiHomeMarkup.markup()}</div>`;
    });
    await page.evaluate(() => {
        window.__reloadFixture = { restartCalls: [], applied: new Set(), updateChecks: 0 };
        const makePlan = () => {
            const actions = [
                { component: 'web', action: 'restartService', label: 'Restart EveOS web' },
                { component: 'browser', action: 'reloadPage', label: 'Reload EveOS page' },
                { component: 'review', action: 'reviewRequired', label: 'Review required' }
            ].filter(item => !window.__reloadFixture.applied.has(item.component));
            return { ok: true, changed: actions.length > 0, actions, reviewRequired: actions.some(item => item.component === 'review') };
        };
        window.EveOSLocalControl = {
            health: async () => true,
            baseUrl: () => 'http://127.0.0.1:9082',
            fetchJson: async (url, options = {}) => {
                const parsed = new URL(url);
                if (parsed.pathname === '/api/services/updates/check') {
                    window.__reloadFixture.updateChecks += 1;
                    return makePlan();
                }
                if (parsed.pathname === '/api/eveos-server/status') return { ok: true, running: true, state: 'running', port: 8765 };
                if (parsed.pathname === '/api/services/restart') {
                    const body = JSON.parse(options.body || '{}');
                    window.__reloadFixture.restartCalls.push({ service: body.service, port: parsed.searchParams.get('port') || '' });
                    await new Promise(resolve => setTimeout(resolve, 80));
                    return { ok: true, serviceKey: body.service, serviceRestarted: true, state: 'running', running: true };
                }
                if (parsed.pathname === '/api/services/updates/applied') {
                    const body = JSON.parse(options.body || '{}');
                    (body.components || []).forEach(component => window.__reloadFixture.applied.add(component));
                    return makePlan();
                }
                if (parsed.pathname === '/api/control-plane/health') {
                    return { ok: true, running: true, instanceId: 'fixture-control', sourceFingerprint: 'fixture-source', scopedStartup: true };
                }
                throw new Error(`Unexpected fixture request: ${parsed.pathname}`);
            }
        };
    });
    await page.addScriptTag({ content: sharedClient });
    await page.addScriptTag({ content: sharedUi });
    await page.addScriptTag({ content: updateUi });

    const updatePanel = page.locator('[data-search-monitor-update-panel]');
    assert.equal(await updatePanel.isHidden(), true, 'update card must stay hidden before Check updates');

    assert.ok((await page.evaluate(() => document.fonts.load('16px "Material Icons"'))).length,
        'production icon font must load before measuring toolbar geometry');
    for (const width of [320, 340, 498]) {
        await page.evaluate(width => { document.querySelector('#loadingIndicator').style.width = `${width}px`; }, width);
        for (const state of [{ status: 'Setup', action: 'Enable', icon: 'power_settings_new', open: false }, { status: 'Localhost Off', action: 'Start', icon: 'play_arrow', open: false }, { status: 'Online', action: 'Stop', icon: 'stop', open: true }]) {
            await page.evaluate(state => {
                document.querySelector('[data-eveos-control-status]').textContent = state.status;
                document.querySelector('[data-eveos-control-action-label]').textContent = state.action;
                document.querySelector('[data-eveos-control-toggle] .material-icons').textContent = state.icon;
                document.querySelector('[data-eveos-control-toggle]').disabled = false;
                document.querySelector('[data-eveos-control-open]').hidden = !state.open;
            }, state);
            await page.waitForTimeout(450); // The production panel's width transition lasts 400ms.
            await assertToolbarLayout(page, `${width}px ${state.status}`);
            if (state.action === 'Enable') await page.locator('#loadingIndicator').screenshot({ path: path.join(artifacts, `toolbar-${width}.png`) });
        }
    }

    const check = page.getByRole('button', { name: 'Check updates' });
    await check.waitFor();
    await check.click();
    await page.waitForFunction(() => document.querySelector('[data-update-stage]')?.textContent === 'Review');
    assert.equal(await updatePanel.isVisible(), true, 'a valid update plan must reveal the update card');
    assert.match(await page.locator('[data-update-summary]').textContent(), /3 affected components/);
    assert.match(await page.locator('[data-update-warning]').textContent(), /unknown runtime mapping/i);
    assert.equal(await page.locator('[data-search-monitor-reload-ui]').getAttribute('aria-label'), 'Reload EveOS page');

    const restartSelected = page.getByRole('button', { name: 'Restart selected running services' });
    await restartSelected.click();
    assert.equal(await page.evaluate(() => window.__reloadFixture.restartCalls.length), 0,
        'first pointer click must only arm the interruption confirmation');
    assert.match(await page.locator('[data-update-warning]').textContent(), /interrupt only: Restart EveOS web/i);
    await page.getByRole('button', { name: 'Confirm selected restarts' }).click();
    await page.waitForFunction(() => window.__reloadFixture.restartCalls.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__reloadFixture.restartCalls), [{ service: 'web', port: '' }]);
    await page.waitForFunction(() => document.querySelector('[data-update-stage]')?.textContent === 'Review');
    assert.equal(await page.evaluate(() => window.__reloadFixture.applied.has('web')), true,
        'verified web replacement must advance only the web fingerprint baseline');

    // Prove the shared client itself collapses concurrent duplicate requests into one operation.
    const beforeDuplicate = await page.evaluate(() => window.__reloadFixture.restartCalls.length);
    await page.evaluate(async () => {
        await Promise.all([
            window.EveOSServiceReload.restart('web', { port: 8765 }),
            window.EveOSServiceReload.restart('web', { port: 8765 })
        ]);
    });
    const duplicateCalls = await page.evaluate(() => window.__reloadFixture.restartCalls.slice());
    assert.equal(duplicateCalls.length, beforeDuplicate + 1, 'concurrent duplicate restarts must share one operation');
    assert.deepEqual(duplicateCalls.at(-1), { service: 'web', port: '8765' });

    // Dismiss the fixed Search Monitor before exercising independent application
    // fixtures, just as the operator would when moving to those surfaces.
    await page.evaluate(() => document.querySelector('#loadingIndicator').classList.remove('visible'));

    // Settings individual Restart controls must name the service and require an in-site second click
    // before their existing lifecycle handler is allowed to run.
    await page.evaluate(() => {
        const row = document.createElement('div');
        row.dataset.consoleService = 'gemini';
        const button = document.createElement('button');
        button.dataset.eveosServiceRestart = 'gemini';
        button.title = 'Restart only the running Gemini Live Link service';
        button.textContent = 'Restart';
        button.addEventListener('click', () => { window.__reloadFixture.settingsDispatches = (window.__reloadFixture.settingsDispatches || 0) + 1; });
        row.appendChild(button);
        document.body.appendChild(row);
    });
    const settingsRestart = page.locator('[data-eveos-service-restart="gemini"]');
    await settingsRestart.click();
    assert.equal(await page.evaluate(() => window.__reloadFixture.settingsDispatches || 0), 0,
        'Settings first pointer click must not dispatch a restart');
    assert.equal(await settingsRestart.getAttribute('aria-label'), 'Confirm restart Gemini Live Link');
    assert.match(await settingsRestart.getAttribute('title'), /interrupts only Gemini Live Link/i);
    await settingsRestart.click();
    assert.equal(await page.evaluate(() => window.__reloadFixture.settingsDispatches || 0), 1,
        'Settings confirmation must dispatch exactly one existing restart handler');

    // WatchFusion owns Start/Stop presentation, but selective Restart must use the same shared
    // lifecycle client and preserve all unrelated services. Its service controller owns the
    // effective port, so the shared route does not need a redundant port query parameter.
    await page.evaluate(() => {
        const overlay = document.createElement('section');
        overlay.id = 'watchfusion-overlay';
        overlay.innerHTML = '<header><div class="watchfusion-head-actions"><button data-wf-action="stop">Stop</button></div></header><span data-wf-message></span>';
        document.body.appendChild(overlay);
        window.__reloadFixture.watchRefreshes = 0;
        window.EveWatchFusion = {
            ready: true,
            async open() { return true; },
            async refresh() { window.__reloadFixture.watchRefreshes += 1; return { running: true }; },
            getState: () => ({ running: true, state: 'running', port: 9087 })
        };
    });
    await page.addScriptTag({ content: watchFusionReload });
    const watchRestart = page.getByRole('button', { name: 'Restart WatchFusion' });
    await watchRestart.waitFor();
    const beforeWatch = await page.evaluate(() => window.__reloadFixture.restartCalls.length);
    await watchRestart.click();
    assert.equal(await page.evaluate(() => window.__reloadFixture.restartCalls.length), beforeWatch,
        'WatchFusion first click must only arm interruption confirmation');
    assert.match(await page.locator('#watchfusion-overlay [data-wf-message]').textContent(), /interrupts WatchFusion only/i);
    await page.getByRole('button', { name: 'Confirm restart WatchFusion' }).click();
    await page.waitForFunction(before => window.__reloadFixture.restartCalls.length === before + 1, beforeWatch);
    assert.deepEqual(await page.evaluate(() => window.__reloadFixture.restartCalls.at(-1)),
        { service: 'watchFusion', port: '' });
    await page.waitForFunction(() => /restarted and verified ready/i.test(document.querySelector('#watchfusion-overlay [data-wf-message]')?.textContent || ''));

    // Add the managed Spotify Internal Player surface and prove its helper-only restart is a
    // real two-click pointer confirmation that produces exactly one shared lifecycle request.
    await page.evaluate(() => {
        const item = {
            id: 'spotify-fixture', type: 'music', sourceProvider: 'spotify', title: 'Fixture Spotify',
            spotifyUrl: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', volume: 0.4
        };
        const host = document.createElement('div');
        host.id = 'spotify-restart-fixture';
        document.body.appendChild(host);
        const view = {
            open() { return host; }, hide() {}, isOpen() { return true; }, setStatus(value) { host.dataset.status = String(value); },
            setVisualVisible() {}, sync() {}, setVolume() {}, setQueue() {}
        };
        window.EveAudioflixInternalPlayer = { createController: () => view };
        window.EveAudioflixSpotifyRemote = {
            snapshot: () => ({ connected: true, base: 'http://127.0.0.1:8765', lastState: { managed: { presentation: 'hidden' }, engine: { status: 'playing' } } }),
            connect: async () => ({ connected: true }),
            send: async (command) => command === 'take-control'
                ? { ok: true, isOwner: true } : { ok: true },
            disconnect: () => {}
        };
        window.EveAudioflixSpotifyAnyBrowser = {
            ready: true,
            snapshot: () => ({ active: true, item, playback: { item, paused: false, currentTime: 10, duration: 180 } })
        };
        window.EveAudioflix = { queueConnection: { snapshot: () => ({ entries: [item], currentIndex: 0 }), step() {}, jump() {} } };
        window.EveAudioflixState = { setItemVolume() {} };
        window.EveAudioflixAudio = {
            ready: true, openInternalView: async () => true, pause: async () => true,
            playItem: async () => true, seek: async () => true, stopAll: async () => true, updateItemVolume() {}
        };
    });
    await page.addScriptTag({ content: read('js/modules/features/audioflix/audioflix.spotify.media.js') });
    // Exercise the real management facade instead of omitting the restart owner.
    await page.addScriptTag({ content: read('js/modules/features/audioflix/audioflix.spotify.management.js') });
    await page.addScriptTag({ content: spotifySurface });
    await page.evaluate(() => window.EveAudioflixAudio.openInternalView({
        id: 'spotify-fixture', type: 'music', sourceProvider: 'spotify', title: 'Fixture Spotify',
        spotifyUrl: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', volume: 0.4
    }));
    const restartEngine = page.getByRole('button', { name: 'Restart engine' });
    await restartEngine.waitFor();
    const beforeSpotify = await page.evaluate(() => window.__reloadFixture.restartCalls.length);
    await restartEngine.click();
    assert.equal(await page.evaluate(() => window.__reloadFixture.restartCalls.length), beforeSpotify,
        'Spotify helper first click must only confirm the interruption');
    assert.match(await page.locator('#spotify-restart-fixture').getAttribute('data-status'), /will stop and will not auto-resume/i);
    await page.getByRole('button', { name: 'Confirm restart' }).click();
    await page.waitForFunction(before => window.__reloadFixture.restartCalls.length === before + 1, beforeSpotify);
    const spotifyCall = await page.evaluate(() => window.__reloadFixture.restartCalls.at(-1));
    assert.deepEqual(spotifyCall, { service: 'spotifyEngine', port: '8765' });
    await page.waitForFunction(() => /restarted and is idle/i.test(document.querySelector('#spotify-restart-fixture')?.dataset.status || ''));

    assert.deepEqual(diagnostics.pageErrors, [], 'selective reload fixture must not raise browser errors');
    console.log('EVEOS_SELECTIVE_RELOAD_BROWSER_OK toolbarLayouts=9 updateVisibility=true pointerConfirm=true duplicateSingleFlight=true settingsConfirm=true watchFusionShared=true spotifyHelperOnly=true');
} catch (error) {
    diagnostics.failure = String(error?.stack || error);
    if (page) {
        await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
        fs.writeFileSync(path.join(artifacts, 'failure.html'), await page.content().catch(() => ''));
    }
    process.exitCode = 1;
    console.error(`EVEOS_SELECTIVE_RELOAD_BROWSER_FAIL\n${diagnostics.failure.split('\n').slice(0, 28).join('\n')}\nEvidence: ${artifacts}`);
} finally {
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(diagnostics, null, 2));
    if (page) await page.context().tracing.stop({ path: path.join(artifacts, 'trace.zip') });
    await browser.close();
}
