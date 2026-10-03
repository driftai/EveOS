// Browser routing checks extracted intact; no assertions or pointer steps are skipped.
async function qualifyRouting(page) {
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
    const nativeSelectionStayedOptional = await page.evaluate(() => {
        const snapshot = window.EveAudioflixState.getSnapshot();
        return snapshot.nativeOutputId === 'sd:1'
            && snapshot.nativeBridgeEnabled === false
            && window.EveAudioflixNative.shouldSuppressBrowserPlayback() === false;
    });
    await page.click('[data-af-action="toggle-native-bridge"]');
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
    await page.click('[data-af-action="local-only"]');
    await page.waitForFunction(() => {
        const snapshot = window.EveAudioflixState.getSnapshot();
        return snapshot.routeMode === 'browser'
            && snapshot.nativeBridgeEnabled === false
            && snapshot.nativeSuppressBrowserPlayback === false
            && !snapshot.preferredSinkId;
    }, undefined, { timeout: 10000 });
    const localPlaybackApplied = await page.evaluate(() => {
        const snapshot = window.EveAudioflixState.getSnapshot();
        return window.EveAudioflixNative.shouldSuppressBrowserPlayback() === false
            && !snapshot.geminiVoicePortEnabled
            && snapshot.geminiVoiceMonitorEnabled !== false
            && window.__audioflixContextSink === '';
    });
    await page.click('[data-af-action="clear-gemini-events"]');
    await page.waitForFunction(() => window.EveAudioflixState.getSnapshot().counters.routedGeminiEvents === 0, undefined, {
        timeout: 10000
    });
    const clearResult = await page.evaluate(() => ({
        routedEvents: window.EveAudioflixState.getSnapshot().counters.routedGeminiEvents,
        headerText: document.querySelector('.audioflix-header-actions')?.textContent || ''
    }));
    return { selectiveRouteApplied, nativeSelectionStayedOptional, nativeRouteApplied, localPlaybackApplied, result, clearResult };
}
module.exports = { qualifyRouting };
