#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { qualifyAudioflixProjectionGeometry } from './helpers/audioflix_projection_geometry.mjs';
import { qualifyMaterialization } from './helpers/audioflix_projection_materialization.mjs';
import { qualifyProjectionAllocations } from './helpers/audioflix_projection_allocations.mjs';
import { qualifyTransportSyncLabels } from './helpers/audioflix_transport_sync_labels.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifact = path.join(ROOT, 'data/runtime/smoke-results/audioflix-ui-projection-browser.json');
const errors = [], checks = [];
const browser = await chromium.launch({ headless: true });
try {
    const allocations = qualifyProjectionAllocations(ROOT, checks);
    const transportLabels = await qualifyTransportSyncLabels(browser, ROOT, checks);
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('http://projection.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body><div id="audioflix-overlay"></div></body>' }));
    await page.goto('http://projection.test');
    await page.evaluate(() => {
        const music = Array.from({ length: 20 }, (_, index) => ({ id: `p-${index}`, type: 'music', title: `Track ${index}`, folder: index < 10 ? 'Test' : 'Other', duration: 120, volume: .5, exposed: true }));
        window.__state = { music, soundboard: [], musicGroups: ['Group A'],
            musicGroupMap: Object.fromEntries(music.slice(0, 10).map(item => [item.id, ['Group A']])), musicFolders: ['Test', 'Other'], musicViewMode: 'frontend' };
        window.__queue = { items: [], groupName: 'All Music', currentIndex: -1, isPlaying: false, shuffle: false, loop: false };
        window.__view = { activeTab: 'music', settingsOpen: false, routingOpen: true, fullscreenOn: false, portedSounds: [], playbackStatus: 'Idle' };
        window.__nexus = false; window.__revision = 1; window.__fullRenders = 0; window.__libraryRenders = 0;
        window.__state.music[0].sourceProvider = 'spotify';
        window.EveAudioflixState = {
            ensure: () => window.__state,
            normalizeVolume: value => Number(value ?? 1),
            getRevision: () => window.__revision,
            update(patch) { Object.assign(window.__state, patch || {}); window.__revision += 1; return window.__state; }
        };
        window.__directVolume = false;
        window.EveAudioflixSpotifyVolume = { snapshot: () => ({ directControl: window.__directVolume }) };
        window.EveAudioflixUiActionsLocalize = { create: () => async () => false };
        window.EveAudioflixUiActionsNexus = { create: () => async () => false };
        window.EveAudioflixUiActionsRouting = { create: () => async () => false };
        window.EveAudioflixUiForms = { create: () => () => {} };
        window.EveAudioflixAudio = { syncQueueView() {}, attachWaveform() {}, stopAll: async () => true };
    });
    for (const file of ['audioflix.transport.js', 'audioflix.groups.tree.js', 'audioflix.ui.group-tree.js', 'audioflix.ui.window.js', 'audioflix.ui.render.js', 'audioflix.ui.toolbar.js', 'audioflix.ui.panel.js', 'audioflix.ui.actions.js']) {
        await page.addScriptTag({ path: path.join(ROOT, 'js/modules/features/audioflix', file) });
    }
    await page.evaluate(() => {
        const root = document.getElementById('audioflix-overlay');
        const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const renderer = window.__renderer = window.EveAudioflixUiRender.create({ state: () => window.__state, esc,
            itemMeta: item => item.folder, groupTags: () => '', internalViewButton: () => '', groupKey: item => item.folder,
            isItemExposed: () => true, groupsOf: id => window.__state.musicGroupMap?.[id] || [], allGroups: () => window.__state.musicGroups || [], classifierEntries: () => [], getPorted: () => [], getActiveRepeaters: () => ({}),
            getActiveMusicQueue: () => window.__queue, getCollapsedGroups: () => ({}), stopSvg: 'Stop', playSvg: 'Play', cogSvg: 'Details', layerPlaySvg: 'Layer' });
        const toolbar = window.EveAudioflixUiToolbar.create({ state: () => window.__state, esc,
            uiNexus: { renderButton: () => '<button id="nexus-toggle" data-af-action="toggle-nexus" data-af-type="music">Nexus</button>', renderPanel: () => '<div class="audioflix-nexus-panel"><input value="query"></div>' },
            uiClass: { renderButton: () => '<button data-af-action="toggle-classifiers">Classifiers</button>' },
            getFlags: () => ({ addFormOpen: {}, localizeFormOpen: {}, groupsOpen: {}, foldersOpen: {}, nexusState: { open: window.__nexus, type: 'music' } }) });
        const panel = window.__panel = window.EveAudioflixUiPanel.create({ state: () => window.__state, esc, closeSvg: 'Close', hotkeyComboIssue: () => null,
            frontendActiveGroup: renderer.frontendActiveGroup,
            renderItems: renderer.renderItems, renderAddSection: type => toolbar(type).replace('data-af-action="toggle-view-mode"', 'id="view-toggle" data-af-action="toggle-view-mode"'),
            view: () => window.__view, modal: () => '', tools: () => ({ routing: { renderStatusCards: () => '<select id="live-output"><option>Output</option></select>' },
                narration: { renderAudioflixSummary: () => '<strong id="narration-title"></strong>', syncAudioflixSummary: () => { const title = document.getElementById('narration-title'); if (title) title.textContent = 'Selected stopped reader'; } } }),
            playback: () => ({ queue: renderer, status() {}, nexus: { open: false } }) });
        window.__full = () => { window.__fullRenders += 1; root.innerHTML = panel.render(); };
        window.__library = () => { window.__libraryRenders += 1; return panel.library(root); };
        const ctx = { state: () => window.__state, frontendActiveGroup: renderer.frontendActiveGroup, frontendGroupEntries: renderer.frontendGroupEntries,
            get activeMusicQueue() { return window.__queue; }, set activeMusicQueue(value) { window.__queue = value; },
            get activeTab() { return window.__view.activeTab; }, set activeTab(value) { window.__view.activeTab = value; },
            get smartArtistExpanded() { return false; }, set smartArtistExpanded(_value) {},
            get settingsOpen() { return window.__view.settingsOpen; }, set settingsOpen(value) { window.__view.settingsOpen = value; },
            get routingOpen() { return window.__view.routingOpen; }, set routingOpen(value) { window.__view.routingOpen = value; },
            get fullscreenOn() { return window.__view.fullscreenOn; }, set fullscreenOn(value) { window.__view.fullscreenOn = value; },
            overlay: root, portedSounds: [], pushHotkeysToBridge() {}, rerender: window.__full, rerenderLibrary: window.__library,
            rerenderPlayback: () => panel.playback(root), rerenderTransient: () => panel.transient(root),
            shuffleQueue: ids => [...ids].reverse(), playQueueIndex: async index => { window.__queue.currentIndex = index; panel.playback(root); }, invalidateQueueRun() {} };
        const actions = window.EveAudioflixUiActions.create(ctx);
        root.addEventListener('click', event => {
            if (event.target.id === 'nexus-toggle') { window.__nexus = !window.__nexus; panel.transient(root); }
            const target = event.target.closest('[data-af-action]');
            if (target) actions.handleAction(target, event);
        });
        window.__full();
        window.__card = root.querySelector('.audioflix-item-card');
        window.__play = window.__card.querySelector('[data-af-action="play"]');
        window.__wave = root.querySelector('canvas');
        window.__output = root.querySelector('#live-output');
        window.__header = root.querySelector('.audioflix-header');
    });
    assert.deepEqual(await page.evaluate(() => ({
        items: window.__renderer.frontendMusicItems() === window.__renderer.frontendMusicItems(),
        projection: window.__renderer.frontendActiveGroup('music') === window.__renderer.frontendActiveGroup('music')
    })), { items: true, projection: true });
    checks.push('same-revision-frontend-projection-reused');
    await page.locator('#nexus-toggle').click();
    await page.locator('#nexus-toggle').click();
    await page.locator('.audioflix-settings-toggle').click();
    await page.locator('.audioflix-settings-toggle').click();
    assert.deepEqual(await page.evaluate(() => ({ card: window.__card === document.querySelector('.audioflix-item-card'),
        play: window.__play === document.querySelector('[data-af-action="play"]'), wave: window.__wave === document.querySelector('canvas'),
        output: window.__output === document.querySelector('#live-output') })), { card: true, play: true, wave: true, output: true });
    checks.push('transient-preserves-library-and-live-routing');
    assert.equal(await page.locator('.audioflix-volume-slider').first().isDisabled(), true);
    await page.evaluate(() => { window.__volume = document.querySelector('.audioflix-volume-slider'); window.__directVolume = true; window.__panel.playback(document.getElementById('audioflix-overlay')); });
    assert.equal(await page.locator('.audioflix-volume-slider').first().isDisabled(), false);
    await page.evaluate(() => { window.__directVolume = false; window.__panel.playback(document.getElementById('audioflix-overlay')); });
    assert.equal(await page.locator('.audioflix-volume-slider').first().isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__volume === document.querySelector('.audioflix-volume-slider')), true);
    checks.push('capability-reconnect-preserves-slider');
    await page.locator('[data-af-action="toggle-routing-drawer"]').click();
    await page.locator('[data-af-action="toggle-routing-drawer"]').click();
    assert.equal(await page.locator('#narration-title').textContent(), 'Selected stopped reader');
    assert.equal(await page.evaluate(() => window.__card === document.querySelector('.audioflix-item-card')), true);
    assert.deepEqual(await page.evaluate(() => ({
        wave: !!document.querySelector('#audioflix-waveform'),
        output: !!document.querySelector('#live-output')
    })), { wave: true, output: true });
    await page.evaluate(() => {
        // Routing close/open intentionally remounts these controls. From here onward,
        // this fresh identity is the baseline that library-only projection must preserve.
        window.__wave = document.querySelector('#audioflix-waveform');
        window.__output = document.querySelector('#live-output');
    });
    checks.push('routing-open-hydrates-stopped-reader');
    await page.locator('[data-af-action="select-folder-scope"][data-af-scope="Test"]').click();
    await page.locator('[data-af-action="select-frontend-group"][data-af-group="Group A"]').click();
    await page.evaluate(() => {
        const toggle = window.__toggle = document.querySelector('#view-toggle');
        window.__toggleFocus = { blur: 0, restored: 0, removed: 0 };
        const focus = toggle.focus;
        toggle.focus = function (...args) { window.__toggleFocus.restored++; return Reflect.apply(focus, this, args); };
        toggle.addEventListener('blur', () => window.__toggleFocus.blur++);
        new MutationObserver(records => {
            for (const record of records) if ([...record.removedNodes].includes(toggle)) window.__toggleFocus.removed++;
        }).observe(toggle.parentElement, { childList: true });
    });
    for (const mode of ['backend', 'frontend']) {
        await page.locator('#view-toggle').click();
        assert.deepEqual(await page.evaluate(() => ({ ...window.__toggleFocus,
            sameNode: window.__toggle === document.querySelector('#view-toggle'), focused: document.activeElement === window.__toggle,
            mode: window.__state.musicViewMode })),
        { blur: 0, restored: 0, removed: 0, sameNode: true, focused: true, mode },
        'Real view toggle must keep focus without detaching or calling focus() during toolbar reconciliation');
    }
    checks.push('view-toggle-retains-uninterrupted-native-focus');
    assert.deepEqual(await page.evaluate(() => ({ full: window.__fullRenders, library: window.__libraryRenders,
        header: window.__header === document.querySelector('.audioflix-header'), wave: window.__wave === document.querySelector('canvas'),
        output: window.__output === document.querySelector('#live-output'), folder: window.__state.activeMusicFolderScope,
        group: window.__state.activeFrontendMusicGroup, mode: window.__state.musicViewMode })),
    { full: 1, library: 4, header: true, wave: true, output: true, folder: 'Test', group: 'Group A', mode: 'frontend' });
    checks.push('scope-and-view-project-library-only');
    await page.locator('[data-af-action="play-music-group"]').click();
    await page.waitForFunction(() => !!document.querySelector('[data-af-action="stop-music-group"]'));
    await page.evaluate(() => { window.__loop = document.querySelector('[data-af-action="loop-music-group"]'); window.__loopClicks = 0;
        window.__loop.addEventListener('click', () => window.__loopClicks++); window.__queue.currentIndex = 1; window.__panel.playback(document.getElementById('audioflix-overlay')); });
    assert.equal(await page.locator('.audioflix-item-card').nth(0).locator('.audioflix-queue-badge').textContent(), '#1 Played');
    assert.equal(await page.locator('.audioflix-item-card').nth(1).locator('.audioflix-queue-badge').textContent(), '#2 Playing');
    const box = await page.locator('[data-af-action="loop-music-group"]').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.evaluate(() => { for (let index = 0; index < 30; index++) window.__panel.playback(document.getElementById('audioflix-overlay')); });
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => ({ clicks: window.__loopClicks, loop: window.__queue.loop,
        sameButton: window.__loop === document.querySelector('[data-af-action="loop-music-group"]') })),
    { clicks: 1, loop: true, sameButton: true });
    checks.push('queue-projection-and-real-pointer');
    await page.locator('[data-af-action="shuffle-music-group"]').click();
    assert.equal(await page.locator('.audioflix-item-card').nth(1).locator('.audioflix-queue-badge').textContent(), '#1 Playing');
    await page.locator('[data-af-action="stop-music-group"]').click();
    assert.equal(await page.locator('.audioflix-queue-badge').count(), 0);
    checks.push('reorder-and-stop-retain-cards');
    assert.equal(await page.evaluate(() => { window.__view.activeTab = 'soundboard'; return window.__panel.transient(document.getElementById('audioflix-overlay')); }), false);
    await page.evaluate(() => { window.__view.activeTab = 'music'; window.__state.music[0].title = 'Changed metadata'; window.__full(); });
    assert.equal(await page.locator('.audioflix-item-card').nth(0).locator('strong').textContent(), 'Changed metadata');
    assert.equal(await page.evaluate(() => window.__fullRenders), 2);
    checks.push('structural-render-remains-authoritative');
    await page.addStyleTag({ path: path.join(ROOT, 'js/modules/features/audioflix/audioflix.layer-voices.css') });
    await page.addScriptTag({ path: path.join(ROOT, 'js/modules/features/audioflix/audioflix.ui.layer-voices.js') });
    await page.evaluate(() => {
        const fixture = document.createElement('section');
        fixture.style.cssText = 'position:fixed;left:12px;top:12px;z-index:2147483647;width:260px;background:#07191d;padding:8px';
        fixture.innerHTML = '<button id="layer-burst">Layer Play</button><div class="audioflix-layer-voices" data-af-layer-voices="burst-sound"></div>';
        document.getElementById('audioflix-overlay').append(fixture); window.__layerClicks = 0;
        document.getElementById('layer-burst').addEventListener('click', () => { window.__layerClicks += 1; });
        const voices = Array.from({ length: 10 }, (_, index) => ({ id: `voice-${index}`, sequence: index + 1,
            currentTime: index, duration: 60, remaining: 60 - index, progress: index / 60 }));
        window.dispatchEvent(new CustomEvent('eve:audioflix-layer-voices', { detail: { itemId: 'burst-sound', voices } }));
    });
    await page.waitForFunction(() => document.querySelectorAll('[data-af-layer-voices="burst-sound"] .audioflix-layer-voice').length === 10);
    await page.evaluate(() => {
        const host = document.querySelector('[data-af-layer-voices="burst-sound"]');
        window.__layerFirst = host.firstElementChild; host.scrollTop = host.scrollHeight; window.__layerScroll = host.scrollTop;
        window.__layerChildMutations = 0;
        new MutationObserver(records => { window.__layerChildMutations += records.reduce((sum, record) => sum + record.addedNodes.length + record.removedNodes.length, 0); })
            .observe(host, { childList: true });
    });
    const layerButton = await page.locator('#layer-burst').boundingBox();
    await page.mouse.move(layerButton.x + layerButton.width / 2, layerButton.y + layerButton.height / 2); await page.mouse.down();
    await page.evaluate(() => {
        for (let tick = 1; tick <= 40; tick += 1) {
            const voices = Array.from({ length: 10 }, (_, index) => ({ id: `voice-${index}`, sequence: index + 1,
                currentTime: tick + index, duration: 90, remaining: 90 - tick - index, progress: (tick + index) / 90 }));
            window.dispatchEvent(new CustomEvent('eve:audioflix-layer-voices', { detail: { itemId: 'burst-sound', voices } }));
        }
    });
    await page.mouse.up(); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await page.evaluate(() => { const host = document.querySelector('[data-af-layer-voices="burst-sound"]'); return {
        clicks: window.__layerClicks, stableFirst: window.__layerFirst === host.firstElementChild,
        childMutations: window.__layerChildMutations, retainedScroll: host.scrollTop >= window.__layerScroll - 1
    }; }), { clicks: 1, stableFirst: true, childMutations: 0, retainedScroll: true });
    checks.push('layer-burst-preserves-pointer-and-dom');
    await page.evaluate(() => {
        window.__savedRaf = window.requestAnimationFrame; window.requestAnimationFrame = () => 98765;
        const voices = Array.from({ length: 10 }, (_, index) => ({ id: `voice-${index}`, currentTime: 55,
            duration: 90, remaining: 35, progress: 55 / 90 }));
        window.dispatchEvent(new CustomEvent('eve:audioflix-layer-voices', { detail: { itemId: 'burst-sound', voices } }));
    });
    await page.waitForFunction(() => document.querySelector('[data-af-layer-voices="burst-sound"] em')?.textContent === '-0:35.000');
    await page.evaluate(() => { window.requestAnimationFrame = window.__savedRaf; delete window.__savedRaf; });
    checks.push('layer-progress-falls-back-when-frame-stalls');
    const geometry = await qualifyAudioflixProjectionGeometry(page, ROOT, checks);
    const materialization = await qualifyMaterialization(page, checks);
    assert.deepEqual(errors, []);
    fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, JSON.stringify({ ok: true, checks, geometry, materialization, allocations, transportLabels, pageErrors: errors }));
    console.log(`AUDIOFLIX_UI_PROJECTION_BROWSER_OK checks=${checks.length} realPointer=true`);
} catch (error) {
    fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, JSON.stringify({ ok: false, checks, error: String(error.stack || error), pageErrors: errors }));
    console.error('AUDIOFLIX_UI_PROJECTION_BROWSER_FAIL\n' + String(error.stack || error).split('\n').slice(0, 38).join('\n')); process.exitCode = 1;
} finally { await browser.close(); }
