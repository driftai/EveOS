const path = require('path');
const { launchChromiumOrConnect, waitForEveCoreHydrated } = require('./playwright-browser');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FILE_URL = 'file:///' + path.join(REPO_ROOT, 'EveOS.html').replace(/\\/g, '/');
const VERBOSE_BROWSER_LOGS = process.env.EVE_SMOKE_VERBOSE === '1';
const SCREENSHOT_PATH = process.env.EVE_SMOKE_SCREENSHOT || '';

function silentWavDataUrl() {
    const sampleRate = 8000;
    const sampleCount = 800;
    const wav = Buffer.alloc(44 + sampleCount * 2);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(sampleCount * 2, 40);
    return `data:audio/wav;base64,${wav.toString('base64')}`;
}

async function main() {
    const { browser } = await launchChromiumOrConnect({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const pageErrors = [];
    page.on('pageerror', (error) => {
        console.error('[BROWSER ERROR]', error);
        pageErrors.push(error?.stack || String(error));
    });
    page.on('console', (msg) => {
        if (VERBOSE_BROWSER_LOGS || msg.type() === 'error') {
            console.log(`[BROWSER CONSOLE] ${msg.type()}: ${msg.text()}`);
        }
    });

    await page.addInitScript(() => {
        try {
            localStorage.clear();
        } catch {}
        window.__eveSmokeNoAutoGemini = true;
        window.__audioflixLabelsUnlocked = false;
        window.__audioflixTrackStopped = false;
        window.__audioflixContextSink = '';
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: {
                enumerateDevices: async () => window.__audioflixLabelsUnlocked
                    ? [
                        { kind: 'audiooutput', deviceId: 'cable-output', label: 'CABLE Input (VB-Audio Virtual Cable)' },
                        { kind: 'audiooutput', deviceId: 'speakers-output', label: 'Smoke Speakers' }
                    ]
                    : [
                        { kind: 'audiooutput', deviceId: 'cable-output', label: '' },
                        { kind: 'audiooutput', deviceId: 'speakers-output', label: '' }
                    ],
                selectAudioOutput: async () => ({ deviceId: 'speakers-output', label: 'Smoke Speakers' }),
                getUserMedia: async () => {
                    window.__audioflixLabelsUnlocked = true;
                    return {
                        getTracks: () => [{
                            stop: () => { window.__audioflixTrackStopped = true; }
                        }]
                    };
                }
            }
        });
        const realFetch = window.fetch.bind(window);
        window.__audioflixNativePlayCount = 0;
        window.fetch = async (url, options = {}) => {
            const text = String(url || '');
            if (/\/api\/status(?:$|[?#])/.test(text)) {
                return new Response(JSON.stringify({
                    ok: true,
                    service: 'eveos-local-server'
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (text.includes('/api/audioflix/')) {
                if (text.includes('/api/audioflix/devices')) {
                    return new Response(JSON.stringify({
                        ok: true,
                        playbackAvailable: true,
                        message: 'Native playback ready.',
                        devices: [
                            { id: 'sd:1', label: 'CABLE Input (VB-Audio Virtual Cable)', kind: 'output', playable: true },
                            { id: 'win:1', label: 'Speakers (Discovery)', kind: 'output', playable: false }
                        ]
                    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
                if (text.includes('/api/audioflix/play-pcm')) {
                    window.__audioflixNativePlayCount += 1;
                    return new Response(JSON.stringify({ ok: true, queued: 32 }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            return realFetch(url, options);
        };
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: async (text) => { window.__audioflixCopiedText = text; } }
        });
        Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
            configurable: true,
            value: async function (deviceId) {
                Object.defineProperty(this, 'sinkId', { configurable: true, value: deviceId });
            }
        });
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (AudioContextCtor) {
            Object.defineProperty(AudioContextCtor.prototype, 'setSinkId', {
                configurable: true,
                value: async function (deviceId) {
                    window.__audioflixContextSink = deviceId;
                    Object.defineProperty(this, 'sinkId', { configurable: true, value: deviceId });
                }
            });
        }
    });

    await page.goto(FILE_URL, { waitUntil: 'load', timeout: 180000 });

    await waitForEveCoreHydrated(page);
    await page.waitForFunction(() => !!window.EveAudioflix?.open && !!window.EveAudioflixState && !!window.__EVE_DEFERRED_SCRIPT_STATE?.completedAt, undefined, {
        timeout: 60000
    });

    await page.click('.topbar-audioflix-btn');
    await page.waitForSelector('#audioflix-overlay:not([hidden]) .audioflix-panel', { timeout: 10000 });
    const drawerInitiallyCollapsed = await page.evaluate(() => {
        const drawer = document.querySelector('.audioflix-routing-drawer');
        return !!drawer && !drawer.classList.contains('is-open') && !document.querySelector('.audioflix-route-board');
    });

    // The add form is collapsed by default; open it via its toggle first.
    await page.click('[data-af-action="toggle-add"][data-af-type="sound"]');
    await page.waitForSelector('form[data-af-form="sound"]', { timeout: 5000 });
    await page.fill('form[data-af-form="sound"] input[name="title"]', 'Smoke Chime');
    await page.fill('form[data-af-form="sound"] input[name="url"]', silentWavDataUrl());
    await page.fill('form[data-af-form="sound"] input[name="category"]', 'Smoke');
    await page.fill('form[data-af-form="sound"] input[name="volume"]', '0.5');
    await page.click('form[data-af-form="sound"] button[type="submit"]');
    await page.waitForFunction(() => (
        window.EveAudioflixState?.getSnapshot?.().soundboard?.length > 0
    ), undefined, { timeout: 5000 });

    // --- Frontend/Backend view + exposure (sounds now default exposed=false) ---
    const soundId = await page.evaluate(() => window.EveAudioflixState.getSnapshot().soundboard[0].id);
    const soundDurationOk = await page.evaluate(async (id) => {
        const item = window.EveAudioflixState.getSnapshot().soundboard.find((entry) => entry.id === id);
        window.dispatchEvent(new CustomEvent('eve:audioflix-progress', {
            detail: { item, currentTime: 0, duration: 2.75, paused: true }
        }));
        await new Promise((resolve) => setTimeout(resolve, 40));
        const saved = window.EveAudioflixState.getSnapshot().soundboard.find((entry) => entry.id === id);
        const card = document.querySelector(`[data-af-action="item-info"][data-af-id="${id}"]`)?.closest('.audioflix-item-card');
        return Math.abs(Number(saved?.duration || 0) - 2.75) < 0.001
            && card?.querySelector('.audioflix-time-duration')?.textContent === '0:02';
    }, soundId);
    await page.click('[data-af-action="toggle-view-mode"]'); // -> frontend
    // Unexposed sound must be filtered out of the Frontend (performance) view.
    await page.waitForFunction(() => /No exposed sounds/.test(document.querySelector('.audioflix-content')?.textContent || ''), undefined, { timeout: 5000 });
    const frontendHidesUnexposed = true;
    // Expose via the same API the settings-modal checkbox calls, then confirm it surfaces in Frontend.
    await page.evaluate((id) => window.EveAudioflixState.setItemExposed('sound', id, true), soundId);
    await page.click('[data-af-action="toggle-view-mode"]'); // -> backend (forces rerender)
    await page.click('[data-af-action="toggle-view-mode"]'); // -> frontend again, now re-filtered
    await page.waitForFunction(() => /Smoke Chime/.test(document.querySelector('.audioflix-content')?.textContent || ''), undefined, { timeout: 5000 });
    const frontendShowsExposed = true;
    await page.click('[data-af-action="toggle-view-mode"]'); // restore backend view for the rest of the run
    await page.waitForFunction(() => window.EveAudioflixState.getSnapshot().soundboardViewMode === 'backend', undefined, { timeout: 5000 });

    // --- Custom frontend groups (many-to-many) ---
    // Create a group through the Groups manager UI.
    await page.click('[data-af-action="toggle-groups"]');
    await page.waitForSelector('form[data-af-form="add-group"]', { timeout: 5000 });
    await page.fill('form[data-af-form="add-group"] input[name="name"]', 'Memes');
    await page.click('form[data-af-form="add-group"] button[type="submit"]');
    await page.waitForFunction(() => (window.EveAudioflixState.getSnapshot().soundboardGroups || []).includes('Memes'), undefined, { timeout: 5000 });
    // Assign the sound to the group via the settings-modal checkbox and set custom hotkey to '1'.
    await page.click(`[data-af-action="item-info"][data-af-id="${soundId}"]`);
    await page.waitForSelector('.audioflix-group-cb[data-af-group="Memes"]', { timeout: 5000 });
    await page.click('.audioflix-group-cb[data-af-group="Memes"]');
    await page.fill('.audioflix-hotkey-input', '1');
    await page.dispatchEvent('.audioflix-hotkey-input', 'change');
    await page.waitForFunction((id) => (window.EveAudioflixState.getSnapshot().soundGroupMap[id] || []).includes('Memes'), soundId, { timeout: 5000 });
    await page.click('.audioflix-info-close-action');
    // Frontend opens at All Groups until the user chooses a focus. Select the real group pill
    // before asserting the active-group grid and hotkey path.
    await page.click('[data-af-action="toggle-view-mode"]');
    await page.waitForSelector('.audioflix-group-pill[data-af-group="Memes"]', { timeout: 5000 });
    await page.click('.audioflix-group-pill[data-af-group="Memes"]');
    await page.waitForFunction(() => {
        const state = window.EveAudioflixState?.getSnapshot?.();
        const pill = document.querySelector('.audioflix-group-pill[data-af-group="Memes"]');
        const grid = document.querySelector('.audioflix-item-grid[data-af-active-group="Memes"]');
        const badge = grid && grid.querySelector('.audioflix-hotkey-badge');
        return state?.activeFrontendGroup === 'Memes'
            && !!pill
            && !!grid
            && /Smoke Chime/.test(grid.textContent || '')
            && !!badge
            && badge.textContent === '1';
    }, undefined, { timeout: 5000 });
    const groupRendersInFrontend = true;
    // Hotkey: pressing "1" plays the first sound of the active group.
    const hotkeyPlayed = await page.evaluate(async (id) => {
        const played = [];
        const orig = window.EveAudioflixAudio.playItem;
        window.EveAudioflixAudio.playItem = (item) => { played.push(item && item.id); return Promise.resolve(true); };
        document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
        await new Promise((r) => setTimeout(r, 50));
        window.EveAudioflixAudio.playItem = orig;
        return played.includes(id);
    }, soundId);
    await page.click('[data-af-action="toggle-view-mode"]'); // back to backend
    await page.waitForFunction(() => window.EveAudioflixState.getSnapshot().soundboardViewMode === 'backend', undefined, { timeout: 5000 });
    await page.click('[data-af-action="toggle-groups"]'); // close the manager for the rest of the run

    // Settings must offer a true destructive delete, distinct from removing a group/folder tag.
    const disposableSoundId = await page.evaluate(() => {
        const S = window.EveAudioflixState;
        const added = S.addItem('sound', { title: 'Delete Me Sound', url: 'data:audio/wav;base64,UklGRg==', category: 'Disposable' });
        S.addSoundboardGroup('Disposable');
        S.toggleSoundGroup(added.id, 'Disposable', true);
        return added.id;
    });
    await page.waitForSelector(`[data-af-action="item-info"][data-af-id="${disposableSoundId}"]`, { timeout: 5000 });
    await page.click(`[data-af-action="item-info"][data-af-id="${disposableSoundId}"]`);
    await page.waitForSelector(`.audioflix-info-card [data-af-action="delete-item"][data-af-id="${disposableSoundId}"]`, { timeout: 5000 });
    await page.click(`.audioflix-info-card [data-af-action="delete-item"][data-af-id="${disposableSoundId}"]`);
    await page.waitForSelector(`.audioflix-delete-confirm [data-af-action="confirm-delete-item"][data-af-id="${disposableSoundId}"]`, { timeout: 5000 });
    await page.click(`.audioflix-delete-confirm [data-af-action="confirm-delete-item"][data-af-id="${disposableSoundId}"]`);
    await page.waitForFunction((id) => !window.EveAudioflixState.getSnapshot().soundboard.some((item) => item.id === id), disposableSoundId, { timeout: 5000 });
    const soundDeleteOk = await page.evaluate((id) => !(id in (window.EveAudioflixState.getSnapshot().soundGroupMap || {})), disposableSoundId);

    await page.click('[data-af-action="tab"][data-af-tab="music"]');
    await page.click('[data-af-action="toggle-add"][data-af-type="music"]');
    await page.waitForSelector('form[data-af-form="music"]', { timeout: 5000 });
    await page.fill('form[data-af-form="music"] input[name="title"]', 'Smoke Track');
    await page.fill('form[data-af-form="music"] input[name="url"]', 'https://example.com/smoke-track.mp3');
    await page.fill('form[data-af-form="music"] input[name="artist"]', 'EveOS');
    await page.fill('form[data-af-form="music"] input[name="folder"]', 'Audioflix');
    await page.click('form[data-af-form="music"] button[type="submit"]');
    await page.waitForFunction(() => window.EveAudioflixState.getSnapshot().music.length === 1, undefined, { timeout: 5000 });

    const internalViewUiOk = await page.evaluate(async () => {
        const item = window.EveAudioflixState.getSnapshot().music[0];
        const button = document.querySelector(`[data-af-action="internal-view"][data-af-id="${item.id}"]`);
        if (!button) return false;
        const original = window.EveAudioflixAudio.openInternalView;
        window.__audioflixInternalViewItem = '';
        window.EveAudioflixAudio.openInternalView = async (selected) => { window.__audioflixInternalViewItem = selected?.id || ''; };
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        window.EveAudioflixAudio.openInternalView = original;
        return window.__audioflixInternalViewItem === item.id;
    });

    const musicTransportOk = await page.evaluate(async () => {
        const item = window.EveAudioflixState.getSnapshot().music[0];
        const card = document.querySelector(`[data-af-action="play"][data-af-id="${item.id}"]`)?.closest('.audioflix-item-card');
        const volume = card?.querySelector('.audioflix-volume-slider');
        if (!card || !volume) return false;
        volume.value = '0.42';
        volume.dispatchEvent(new Event('input', { bubbles: true }));
        window.dispatchEvent(new CustomEvent('eve:audioflix-progress', {
            detail: { item, currentTime: 30, duration: 120, paused: false }
        }));
        const seek = card.querySelector('.audioflix-seek-slider');
        const progressRendered = card.classList.contains('is-current')
            && seek.disabled === false
            && Number(seek.max) === 120;
        window.__audioflixSeekValue = -1;
        const originalSeek = window.EveAudioflixAudio.seek;
        window.EveAudioflixAudio.seek = async (value) => { window.__audioflixSeekValue = value; return true; };
        seek.value = '45';
        seek.dispatchEvent(new Event('input', { bubbles: true }));
        seek.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 20));
        window.EveAudioflixAudio.seek = originalSeek;
        const saved = window.EveAudioflixState.getSnapshot().music[0];
        return saved.volume === 0.42
            && saved.duration === 120
            && progressRendered
            && window.__audioflixSeekValue === 45;
    });

    const disposableMusicId = await page.evaluate(() => {
        const S = window.EveAudioflixState;
        const added = S.addItem('music', { title: 'Delete Me Track', url: 'https://example.com/delete-me.mp3', folder: 'Disposable' });
        S.addMusicGroup('Disposable Music');
        S.toggleMusicGroup(added.id, 'Disposable Music', true);
        return added.id;
    });
    await page.waitForSelector(`[data-af-action="item-info"][data-af-id="${disposableMusicId}"]`, { timeout: 5000 });
    await page.click(`[data-af-action="item-info"][data-af-id="${disposableMusicId}"]`);
    await page.waitForSelector(`.audioflix-info-card [data-af-action="delete-item"][data-af-id="${disposableMusicId}"]`, { timeout: 5000 });
    await page.click(`.audioflix-info-card [data-af-action="delete-item"][data-af-id="${disposableMusicId}"]`);
    await page.waitForSelector(`.audioflix-delete-confirm [data-af-action="confirm-delete-item"][data-af-id="${disposableMusicId}"]`, { timeout: 5000 });
    await page.click(`.audioflix-delete-confirm [data-af-action="confirm-delete-item"][data-af-id="${disposableMusicId}"]`);
    await page.waitForFunction((id) => !window.EveAudioflixState.getSnapshot().music.some((item) => item.id === id), disposableMusicId, { timeout: 5000 });
    const musicDeleteOk = await page.evaluate((id) => !(id in (window.EveAudioflixState.getSnapshot().musicGroupMap || {})), disposableMusicId);

    await page.click('[data-af-action="tab"][data-af-tab="soundlab"]');
    await page.waitForSelector('[data-audioflix-soundlab] [data-af-action="soundlab-control-view"]');
    await page.click('[data-af-action="soundlab-control-view"][data-sf-view="knobs"]');
    await page.waitForSelector('.sonic-forge-controls-grid.is-knobs');
    const soundLabUiOk = await page.evaluate(() => (
        document.querySelectorAll('.sonic-forge-controls-grid.is-knobs .sonic-forge-knob-shell').length === 6
        && /Sonic Forge/.test(document.querySelector('[data-audioflix-soundlab]')?.textContent || '')
        && window.EveAudioflixState.getSnapshot().soundLab?.controlView === 'knobs'
    ));
    if (SCREENSHOT_PATH) {
        await page.locator('#audioflix-overlay .audioflix-panel').screenshot({ path: SCREENSHOT_PATH });
    }

    await page.click('[data-af-action="tab"][data-af-tab="router"]');
    await page.click('[data-af-action="toggle-routing-drawer"]');
    await page.waitForSelector('.audioflix-routing-drawer.is-open .audioflix-route-board', { timeout: 10000 });
    await page.click('[data-af-action="arm-cable"]');
    await page.waitForFunction(() => {
        const status = document.querySelector('.audioflix-player span')?.textContent || '';
        return /CABLE Input not visible|Gemini voice port armed/.test(status);
    }, undefined, { timeout: 10000 });
    const selectiveRouteApplied = await page.evaluate(() => {
        const snapshot = window.EveAudioflixState.getSnapshot();
        return snapshot.routeMode === 'browser-selective'
            && snapshot.geminiVoicePortEnabled === true
            && /CABLE Input/.test(snapshot.preferredSinkLabel || '');
    });
    await page.waitForFunction(() => {
        const options = [...(document.querySelector('[data-af-control="monitor-output-select"]')?.options || [])];
        return options.some((option) => option.value === 'cable-output' && option.disabled);
    }, undefined, { timeout: 10000 });
    await page.waitForFunction(() => {
        const options = [...(document.querySelector('[data-af-control="native-output-select"]')?.options || [])];
        return options.some((option) => option.value === 'sd:1' && !option.disabled)
            && options.some((option) => option.value === 'win:1' && option.disabled);
    }, undefined, { timeout: 10000 });
    await page.selectOption('[data-af-control="native-output-select"]', 'sd:1');
    const nativeRouteApplied = await page.evaluate(async () => {
        const snapshot = window.EveAudioflixState.getSnapshot();
        const sent = await window.EveAudioflixNative.sendGeminiChunk('AAAA', { sampleRate: 24000, channels: 1 });
        return snapshot.routeMode === 'native-bridge'
            && snapshot.nativeBridgeEnabled === true
            && /CABLE Input/.test(snapshot.nativeOutputLabel || '')
            && window.EveAudioflixNative.shouldSuppressBrowserPlayback() === true
            && sent === true
            && window.__audioflixNativePlayCount > 0;
    });
    await page.click('[data-af-action="copy-route-status"]');
    await page.waitForFunction(() => /Audioflix Routing Status/.test(window.__audioflixCopiedText || ''), undefined, {
        timeout: 10000
    });
    await page.click('[data-af-action="mark-windows-route"]');
    await page.waitForFunction(() => window.EveAudioflixState.getSnapshot().routeMode === 'manual', undefined, {
        timeout: 10000
    });
    await page.click('[data-af-action="copy-route-status"]');
    await page.waitForFunction(() => /Windows mixer route/.test(window.__audioflixCopiedText || ''), undefined, {
        timeout: 10000
    });
    await page.evaluate(() => {
        window.EveAudioflixGemini.setMonitorEnabled(true);
        window.EveAudioflixGemini.setMonitorSink('monitor-smoke-device', 'Smoke Monitor Speakers');
    });
    await page.click('[data-af-action="toggle-gemini-monitor"]');
    await page.waitForFunction(() => window.EveAudioflixState.getSnapshot().geminiVoiceMonitorEnabled === false, undefined, {
        timeout: 10000
    });
    await page.click('[data-af-action="toggle-gemini-monitor"]');
    await page.waitForFunction(() => window.EveAudioflixState.getSnapshot().geminiVoiceMonitorEnabled === true, undefined, {
        timeout: 10000
    });
    const result = await page.evaluate(() => {
        const snapshot = window.EveAudioflixState.getSnapshot();
        const monitorBlocksCable = [...(document.querySelector('[data-af-control="monitor-output-select"]')?.options || [])]
            .some((option) => option.value === 'cable-output' && option.disabled);
        window.EveAudioflixGemini.setVoicePortEnabled(true);
        window.EveAudioflixGemini.setConversationMode('text-brain-live-voice');
        window.dispatchEvent(new CustomEvent('eve:gemini-audio-output', {
            detail: { kind: 'complete', chars: 24, at: Date.now() }
        }));
        const updated = window.EveAudioflixState.getSnapshot();
        return {
            hasOverlay: !document.getElementById('audioflix-overlay')?.hidden,
            soundCount: snapshot.soundboard.length,
            musicCount: snapshot.music.length,
            voicePortEnabled: updated.geminiVoicePortEnabled,
            voiceMonitorEnabled: updated.geminiVoiceMonitorEnabled,
            voiceMonitorLabel: updated.geminiVoiceMonitorSinkLabel,
            routeMode: updated.routeMode,
            mode: updated.geminiConversationMode,
            routedEvents: updated.counters.routedGeminiEvents,
            hasRouterNotes: /CABLE/i.test(document.querySelector('.audioflix-content')?.textContent || ''),
            hasRouteBoard: /Gemini Voice/.test(document.querySelector('.audioflix-route-board')?.textContent || ''),
            drawerExpanded: document.querySelector('.audioflix-routing-drawer')?.classList.contains('is-open'),
            hasRouteHealth: /Output routing/.test(document.querySelector('.audioflix-route-health')?.textContent || ''),
            hasRouteGuide: /Windows mixer route is marked|Next useful action/.test(document.querySelector('.audioflix-route-guide')?.textContent || ''),
            routeActions: [...document.querySelectorAll('.audioflix-route-actions [data-af-action]')]
                .map((button) => button.dataset.afAction).join(','),
            hasBrowserCore: /Browser Output Core/.test(document.querySelector('.audioflix-status-grid')?.textContent || ''),
            hasSelectiveCopy: /Selective browser route/.test(window.__audioflixCopiedText || ''),
            hasVoiceRouteTest: typeof window.EveAudioflixGemini.playVoiceRouteTest === 'function',
            hasTestSignal: typeof window.EveAudioflixAudio.playTestSignal === 'function',
            hasMonitorCard: /Local Monitor/i.test(document.querySelector('.audioflix-status-grid')?.textContent || ''),
            monitorBlocksCable,
            labelsUnlocked: window.__audioflixLabelsUnlocked === true,
            unlockTrackStopped: window.__audioflixTrackStopped === true,
            hasUnlockButton: !!document.querySelector('[data-af-action="unlock-output-names"]'),
            hasBananaPreset: !!document.querySelector('.audioflix-vbcable-preset [data-af-action="arm-cable"]'),
            presetApplied: /CABLE Input/.test(updated.preferredSinkLabel || ''),
            copiedRouteStatus: /Browser Core/.test(window.__audioflixCopiedText || '') && /Windows mixer route/.test(window.__audioflixCopiedText || ''),
            webAudioSink: window.__audioflixContextSink,
            buttonExpanded: document.querySelector('.topbar-audioflix-btn')?.getAttribute('aria-expanded')
        };
    });
    await page.click('[data-af-action="clear-gemini-events"]');
    await page.waitForFunction(() => window.EveAudioflixState.getSnapshot().counters.routedGeminiEvents === 0, undefined, {
        timeout: 10000
    });
    const clearResult = await page.evaluate(() => ({
        routedEvents: window.EveAudioflixState.getSnapshot().counters.routedGeminiEvents,
        headerText: document.querySelector('.audioflix-header-actions')?.textContent || ''
    }));

    const failures = [];
    if (!drawerInitiallyCollapsed) failures.push('routing drawer was not collapsed by default');
    if (!frontendHidesUnexposed) failures.push('Frontend view did not hide unexposed sound (default exposed=false)');
    if (!frontendShowsExposed) failures.push('Frontend view did not surface a sound after exposing it');
    if (!soundDurationOk) failures.push('soundboard duration did not persist/render after metadata arrived');
    if (!soundDeleteOk) failures.push('sound settings delete did not remove the item and its group membership');
    if (!musicDeleteOk) failures.push('music settings delete did not remove the item and its group membership');
    if (!groupRendersInFrontend) failures.push('active group selector/grid/hotkey badge did not render in Frontend view');
    if (!hotkeyPlayed) failures.push('number hotkey did not play the active group sound');
    if (!result.hasOverlay) failures.push('overlay not visible');
    if (!selectiveRouteApplied) failures.push('Auto CABLE did not create selective browser route');
    if (result.soundCount !== 1) failures.push(`expected 1 sound, got ${result.soundCount}`);
    if (result.musicCount !== 1) failures.push(`expected 1 track, got ${result.musicCount}`);
    if (!internalViewUiOk) failures.push('music Internal View action was missing or not wired');
    if (!musicTransportOk) failures.push('music volume/seek transport did not persist or dispatch');
    if (!soundLabUiOk) failures.push('Sonic Forge knob view did not render or persist');
    if (!result.voicePortEnabled) failures.push('Gemini voice port did not persist');
    if (!result.voiceMonitorEnabled) failures.push('Gemini voice monitor did not persist');
    if (result.voiceMonitorLabel !== 'Smoke Monitor Speakers') failures.push(`wrong monitor label: ${result.voiceMonitorLabel}`);
    if (result.routeMode !== 'manual') failures.push(`manual Windows mixer route did not persist: ${result.routeMode}`);
    if (result.mode !== 'text-brain-live-voice') failures.push(`wrong mode: ${result.mode}`);
    if (result.routedEvents < 1) failures.push('Gemini audio event not recorded');
    if (!result.hasRouterNotes) failures.push('router notes missing');
    if (!result.drawerExpanded) failures.push('routing drawer did not expand');
    if (!result.hasRouteBoard) failures.push('route board missing');
    if (!result.hasRouteGuide) failures.push('route guide missing');
    if (!result.hasRouteHealth) failures.push('route health row missing');
    if (!/local-only/.test(result.routeActions) || !/mark-windows-route/.test(result.routeActions) || !/test-signal/.test(result.routeActions) || !/copy-route-status/.test(result.routeActions)) failures.push(`route actions incomplete: ${result.routeActions}`);
    if (!result.hasBrowserCore) failures.push('Browser Output Core card missing');
    if (!result.hasSelectiveCopy) failures.push('selective browser route note missing from copied status');
    if (!result.hasVoiceRouteTest) failures.push('Gemini WebAudio route test helper missing');
    if (!result.hasTestSignal) failures.push('test signal helper missing');
    if (!result.copiedRouteStatus) failures.push('copy route status did not write useful text');
    if (!result.hasMonitorCard) failures.push('Local Monitor card missing');
    if (!result.monitorBlocksCable) failures.push('Local Monitor did not block the Voice Port CABLE sink');
    if (!nativeRouteApplied) failures.push('native Audioflix bridge route did not apply/send');
    if (!result.hasUnlockButton) failures.push('unlock device names button missing');
    if (!result.labelsUnlocked) failures.push('Auto CABLE did not unlock hidden browser output labels');
    if (!result.unlockTrackStopped) failures.push('unlock device label media track was not stopped');
    if (clearResult.routedEvents !== 0 || !/0 Gemini events/.test(clearResult.headerText)) failures.push('Gemini event counter did not clear through UI');
    if (!result.hasBananaPreset) failures.push('Banana preset button missing');
    if (!result.presetApplied) failures.push('Banana preset did not select CABLE Input');
    if (result.webAudioSink !== 'cable-output') failures.push(`Web Audio sink did not follow the selected output: ${result.webAudioSink}`);
    if (result.buttonExpanded !== 'true') failures.push('topbar aria-expanded not updated');
    if (pageErrors.length) failures.push(`page errors: ${pageErrors.join('\n')}`);

    await browser.close();
    if (failures.length) throw new Error(failures.join('; '));
    console.log('AUDIOFLIX_UI_SMOKE_OK');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
