const path = require('path');
const { chromium } = require('playwright');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FILE_URL = 'file:///' + path.join(REPO_ROOT, 'EveOS.html').replace(/\\/g, '/');

async function main() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 520, height: 700 } });
    const pageErrors = [];
    let credentialConfigured = false;
    let credentialPosts = 0;

    async function inspectAgenticDialog(selector) {
        return page.locator(selector).evaluate((dialog) => {
            const rect = dialog.getBoundingClientRect();
            const content = dialog.querySelector('.mdl-dialog__content');
            const actions = dialog.querySelector('.mdl-dialog__actions, footer');
            const style = getComputedStyle(dialog);
            return {
                open: dialog.open,
                viewport: { width: innerWidth, height: innerHeight },
                rect: {
                    left: Math.round(rect.left),
                    top: Math.round(rect.top),
                    right: Math.round(rect.right),
                    bottom: Math.round(rect.bottom),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                },
                background: style.backgroundColor,
                backgroundImage: style.backgroundImage,
                color: style.color,
                display: style.display,
                className: dialog.className,
                dynamicThemePresent: !!document.getElementById('screenCaptureSettingsStyles'),
                childCount: dialog.children.length,
                inlineDisplay: dialog.style.display,
                parentDisplay: dialog.parentElement ? getComputedStyle(dialog.parentElement).display : null,
                parentSize: dialog.parentElement ? {
                    width: Math.round(dialog.parentElement.getBoundingClientRect().width),
                    height: Math.round(dialog.parentElement.getBoundingClientRect().height)
                } : null,
                contentOverflowY: content ? getComputedStyle(content).overflowY : null,
                actionHeight: actions ? Math.round(actions.getBoundingClientRect().height) : 0
            };
        });
    }

    function requireModernDialog(name, result) {
        const escapedViewport = result.rect.left < -1 || result.rect.top < -1
            || result.rect.right > result.viewport.width + 1
            || result.rect.bottom > result.viewport.height + 1;
        const legacyLightSurface = result.background === 'rgb(255, 255, 255)'
            || (result.background === 'rgba(0, 0, 0, 0)' && result.backgroundImage === 'none');
        if (!result.open || escapedViewport || legacyLightSurface
            || result.rect.width < 300 || result.actionHeight < 36) {
            throw new Error(`${name} dialog is not a modern responsive surface: ${JSON.stringify(result)}`);
        }
    }

    page.on('pageerror', (error) => pageErrors.push(error?.stack || String(error)));
    await page.addInitScript(() => {
        class MockWebSocket {
            static CONNECTING = 0;
            static OPEN = 1;
            static CLOSING = 2;
            static CLOSED = 3;

            constructor() {
                this.readyState = MockWebSocket.CONNECTING;
                setTimeout(() => {
                    this.readyState = MockWebSocket.OPEN;
                    this.onopen?.({ type: 'open' });
                }, 10);
            }

            send() {}

            close() {
                this.readyState = MockWebSocket.CLOSED;
                this.onclose?.({ code: 1000, reason: 'smoke', wasClean: true });
            }
        }
        window.WebSocket = MockWebSocket;
        try {
            localStorage.setItem('eve.geminiMonitorView', 'summary');
            localStorage.setItem('geminiConnectionEnabled', 'false');
            localStorage.removeItem('geminiApiKey');
        } catch (error) {
            // file:// storage may be restricted in some browser builds.
        }
    });

    await page.route(/http:\/\/127\.0\.0\.1:(?:3000|8765)\/api\/gemini-server\/status/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ running: true, state: 'running', message: 'Gemini server is running.' })
        });
    });
    await page.route('http://127.0.0.1:9084/status', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'running' })
        });
    });
    await page.route(/http:\/\/127\.0\.0\.1:(?:9082|3000|8765)\/api\/gemini-credentials(?:\/status)?/, async (route) => {
        if (route.request().method() === 'POST') {
            credentialPosts += 1;
            credentialConfigured = true;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                ok: true,
                configured: credentialConfigured,
                protection: 'windows-dpapi'
            })
        });
    });

    try {
        await page.goto(FILE_URL, { waitUntil: 'load', timeout: 240000 });
        await page.waitForFunction(() => !!window.SearchMonitorBoot && !!window.GeminiServerControl, undefined, {
            timeout: 120000
        });
        await page.evaluate(() => window.SearchMonitorBoot.expand());
        await page.click('[data-gemini-monitor-view-btn="full"]');
        await page.waitForFunction(() => (
            !!window.__GEMINI_WORKSPACE_READY
            && !!document.getElementById('sessionControlsDialog')
            && document.getElementById('sessionControlsDialog')?.dataset.sessionControlsBound === '1'
        ), undefined, { timeout: 120000 });

        await page.waitForFunction(() => {
            const groups = window.AgenticFunctions;
            return groups && Object.keys(groups).length === 6 && Object.values(groups)
                .every(group => Object.values(group).some(value => typeof value === 'function'));
        }, undefined, { timeout: 10000 }).catch(async error => {
            const inventory = await page.evaluate(() => Object.fromEntries(
                Object.entries(window.AgenticFunctions || {}).map(([name, group]) =>
                    [name, Object.fromEntries(Object.entries(group).map(([key, value]) => [key, typeof value]))])));
            throw new Error(`Agentic implementation readiness failed: ${JSON.stringify(inventory)}; ${error.message}`);
        });
        const controls = await page.evaluate(() => {
            const ids = [
                'timePerceptionToggle',
                'contextMemoryToggle',
                'geminiLiveLinkToggle',
                'geminiLiveLinkSendButton',
                'playProcessedAudioToggle',
                'audioSettingsButton',
                'sessionControlsSettingsButton',
                'screenCaptureSettingsButton',
                'aiSelftalkToggle',
                'selfTalkSettingsButton'
            ];
            return {
                missing: ids.filter((id) => !document.getElementById(id)),
                agenticFunctions: Object.fromEntries(Object.entries(window.AgenticFunctions)
                    .map(([name, group]) => [name, Object.keys(group)
                        .filter(key => typeof group[key] === 'function').sort()])),
                sessionBound: document.getElementById('sessionControlsDialog')?.dataset.sessionControlsBound,
                liveLinkBound: document.getElementById('gemini-live-link-card')?.dataset.bound,
                liveLinkTitle: document.querySelector('#gemini-live-link-card .gemini-live-link-title')?.textContent?.trim(),
                liveLinkManifest: document.getElementById('geminiLiveLinkManifest')?.textContent || ''
            };
        });
        if (controls.missing.length || controls.sessionBound !== '1' || controls.liveLinkBound !== '1'
            || controls.liveLinkTitle !== 'EveOS Context Relay'
            || !/Scope/i.test(controls.liveLinkManifest)
            || !/Active tab/i.test(controls.liveLinkManifest)) {
            throw new Error(`Agentic controls are not fully wired: ${JSON.stringify(controls)}`);
        }

        const commandLayout = await page.evaluate(() => {
            const ids = ['sendHistoryButton', 'clearChatButton', 'clearSystemLogButton', 'togglePastChatsButton'];
            return ids.map(id => {
                const element = document.getElementById(id);
                if (!element) return { id, missing: true };
                const box = element.getBoundingClientRect();
                return {
                    id, missing: false, left: box.left, right: box.right, width: box.width,
                    viewportWidth: innerWidth, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth
                };
            });
        });
        if (commandLayout.some(item => item.missing || item.left < -1
            || item.right > item.viewportWidth + 1 || item.scrollWidth > item.clientWidth + 2)) {
            throw new Error(`Gemini command buttons overflow at narrow width: ${JSON.stringify(commandLayout)}`);
        }

        await page.evaluate(() => window.WorldBookNarrationManagerAgentic?.openSettings?.());
        await page.waitForFunction(() => {
            const dialog = document.getElementById('world-book-narration-settings-dialog');
            return !!dialog && (dialog.open || dialog.hasAttribute('open'));
        }, undefined, { timeout: 10000 });
        requireModernDialog('World Book Narration', await inspectAgenticDialog('#world-book-narration-settings-dialog'));
        const narrationVoice = await page.evaluate(() => {
            const select = document.querySelector('[data-narration-browser-voice]');
            const card = document.querySelector('.gemini-narration-settings-card');
            const rect = card?.getBoundingClientRect();
            return {
                exists: !!select,
                fieldKey: select?.dataset.narrationField || '',
                cardRight: rect?.right || 0,
                viewportWidth: innerWidth
            };
        });
        if (!narrationVoice.exists || narrationVoice.fieldKey !== 'browserVoice'
            || narrationVoice.cardRight > narrationVoice.viewportWidth + 1) {
            throw new Error(`Narration shared Browser TTS voice UI is missing or overflowing: ${JSON.stringify(narrationVoice)}`);
        }
        await page.click('[data-narration-cancel]');

        const coreToggleState = await page.evaluate(() => {
            const exerciseToggle = (id, storageKey, getter) => {
                const toggle = document.getElementById(id);
                const original = toggle.checked;
                toggle.checked = !original;
                toggle.dispatchEvent(new Event('change', { bubbles: true }));
                const changed = {
                    checked: toggle.checked,
                    stored: localStorage.getItem(storageKey),
                    runtime: getter()
                };
                toggle.checked = original;
                toggle.dispatchEvent(new Event('change', { bubbles: true }));
                return changed;
            };
            return {
                time: exerciseToggle('timePerceptionToggle', 'timePerceptionEnabled',
                    () => window.AgenticFunctions.TimePerception.isTimePerceptionEnabled()),
                memory: exerciseToggle('contextMemoryToggle', 'contextMemoryEnabled',
                    () => window.AgenticFunctions.ConversationMemory.isContextMemoryEnabled())
            };
        });
        for (const [name, state] of Object.entries(coreToggleState)) {
            if (state.stored !== String(state.checked) || state.runtime !== state.checked) {
                throw new Error(`${name} agentic toggle did not update runtime and persistence: ${JSON.stringify(state)}`);
            }
        }

        await page.evaluate(() => {
            window.__geminiRelayToggleEvents = [];
            window.addEventListener('eve:gemini-live-link-toggled', (event) => window.__geminiRelayToggleEvents.push(event.detail?.enabled));
            const toggle = document.getElementById('geminiLiveLinkToggle'); toggle.checked = false; toggle.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const relayPaused = await page.evaluate(() => {
            const box = (selector) => {
                const element = document.querySelector(selector);
                if (!element) return null;
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return {
                    width: Math.round(rect.width || parseFloat(style.width) || 0),
                    height: Math.round(rect.height || parseFloat(style.height) || 0),
                    display: style.display
                };
            };
            return {
                settingsDisabled: document.getElementById('geminiLiveLinkSettingsButton')?.disabled,
                persistedEnabled: window.eveState?.config?.geminiLiveLinkEnabled,
                toggleEvents: window.__geminiRelayToggleEvents || [],
                toggleChecked: document.getElementById('geminiLiveLinkToggle')?.checked,
                card: box('#gemini-live-link-card'),
                toggle: box('label[for="geminiLiveLinkToggle"]'),
                track: box('label[for="geminiLiveLinkToggle"] .mdl-switch__track'),
                thumb: box('label[for="geminiLiveLinkToggle"] .mdl-switch__thumb'),
                manifest: box('#geminiLiveLinkManifest'),
                status: box('#geminiLiveLinkStatus'),
                subtitle: box('.gemini-live-link-subtitle'),
                paused: document.getElementById('gemini-live-link-card')?.classList.contains('is-relay-paused')
            };
        });
        if (relayPaused.settingsDisabled !== true
            || relayPaused.persistedEnabled !== false
            || relayPaused.toggleChecked !== false
            || relayPaused.toggleEvents.at(-1) !== false) {
            throw new Error(`Gemini Live Link toggle is not wired: ${JSON.stringify(relayPaused)}`);
        }
        if (!relayPaused.paused
            || relayPaused.card.height > 175
            || relayPaused.toggle.width !== 52
            || relayPaused.track.width !== 36
            || relayPaused.track.height !== 14
            || relayPaused.thumb.width !== 20
            || relayPaused.thumb.height !== 20) {
            throw new Error(`Gemini Live Link paused state is not compact: ${JSON.stringify(relayPaused)}`);
        }
        await page.evaluate(() => {
            const toggle = document.getElementById('geminiLiveLinkToggle'); toggle.checked = true; toggle.dispatchEvent(new Event('change', { bubbles: true }));
        });

        await page.evaluate(() => { const toggle = document.getElementById('playProcessedAudioToggle'); toggle.checked = false; toggle.dispatchEvent(new Event('change', { bubbles: true })); });
        await page.waitForFunction(() => document.getElementById('audioSettingsButton')?.disabled);
        await page.evaluate(() => { const toggle = document.getElementById('playProcessedAudioToggle'); toggle.checked = true; toggle.dispatchEvent(new Event('change', { bubbles: true })); });
        await page.waitForFunction(() => !document.getElementById('audioSettingsButton')?.disabled);
        await page.evaluate(() => document.getElementById('audioSettingsButton').click());
        requireModernDialog('Audio Processing', await inspectAgenticDialog('#audioSettingsDialog'));
        await page.fill('#processedAudioDelayInput', '137');
        await page.click('#audioSettingsSave');
        if (await page.evaluate(() => localStorage.getItem('processedAudioDelay')) !== '137') {
            throw new Error('Audio Processing settings did not persist through Save.');
        }

        await page.evaluate(() => document.getElementById('selfTalkSettingsButton').click());
        requireModernDialog('AI Self-talk', await inspectAgenticDialog('#selfTalkSettingsDialog'));
        if (process.env.EVE_SMOKE_SCREENSHOT) {
            await page.screenshot({ path: path.resolve(process.env.EVE_SMOKE_SCREENSHOT) });
        }
        await page.fill('#newPromptInput', 'smoke prompt instruction');
        await page.click('#addPromptBtn');
        const promptDraftAdded = await page.locator('#selfTalkPromptList').textContent();
        if (!promptDraftAdded?.includes('smoke prompt instruction')) {
            throw new Error(`AI Self-talk Add prompt did not update the list: ${promptDraftAdded}`);
        }
        await page.fill('#newInstructionInput', 'smoke system instruction');
        await page.click('#addInstructionBtn');
        const instructionDraftAdded = await page.locator('#systemInstructionList').textContent();
        if (!instructionDraftAdded?.includes('smoke system instruction')) {
            throw new Error(`AI Self-talk Add instruction did not update the list: ${instructionDraftAdded}`);
        }
        await page.fill('#baseDelayInput', '9');
        await page.fill('#maxDelayInput', '21');
        await page.click('#selfTalkSettingsSave');
        const selfTalkSaved = await page.evaluate(() => ({
            prompt: localStorage.getItem('selfTalkPrompt'),
            instruction: localStorage.getItem('selfTalkSystemMessage'),
            base: localStorage.getItem('baseSelftalkDelay'),
            extra: localStorage.getItem('maxSelftalkDelayOffset')
        }));
        if (!selfTalkSaved.prompt?.includes('smoke prompt instruction')
            || !selfTalkSaved.instruction?.includes('smoke system instruction')
            || selfTalkSaved.base !== '9000' || selfTalkSaved.extra !== '21000') {
            throw new Error(`AI Self-talk settings did not persist: ${JSON.stringify(selfTalkSaved)}`);
        }

        await page.evaluate(() => document.getElementById('screenCaptureSettingsButton').click());
        await page.waitForFunction(() => document.getElementById('screenCaptureSettingsDialog')?.open);
        requireModernDialog('Screen Capture', await inspectAgenticDialog('#screenCaptureSettingsDialog'));
        await page.fill('#screenCaptureIntervalInput', '1750');
        await page.fill('#screenCaptureQualityInput', '0.9');
        await page.fill('#screenCaptureMaxDimensionInput', '1920');
        await page.selectOption('#screenCaptureFormatInput', 'webp');
        await page.check('#screenCaptureSilentToggle');
        await page.click('#screenCaptureSettingsSave');
        const screenSaved = await page.evaluate(() => ({
            interval: localStorage.getItem('screenCaptureInterval'),
            quality: localStorage.getItem('screenCaptureQuality'),
            maxDimension: localStorage.getItem('screenCaptureMaxDimension'),
            format: localStorage.getItem('screenCaptureFormat'),
            silent: localStorage.getItem('screenCaptureSilentObservation')
        }));
        if (JSON.stringify(screenSaved) !== JSON.stringify({
            interval: '1750', quality: '0.9', maxDimension: '1920', format: 'webp', silent: 'true'
        })) {
            throw new Error(`Screen Capture settings did not persist: ${JSON.stringify(screenSaved)}`);
        }

        await page.evaluate(() => document.getElementById('sessionControlsSettingsButton').click());
        await page.waitForFunction(() => document.getElementById('sessionControlsDialog')?.open);
        const narrowDialog = await page.evaluate(() => {
            const dialog = document.getElementById('sessionControlsDialog');
            const box = dialog.getBoundingClientRect();
            const header = dialog.querySelector('.gemini-session-dialog__header');
            const actions = dialog.querySelector('.gemini-session-dialog__actions');
            const chat = document.getElementById('chatLog')?.getBoundingClientRect();
            const system = document.getElementById('systemLog')?.getBoundingClientRect();
            return {
                viewport: { width: innerWidth, height: innerHeight },
                box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
                background: getComputedStyle(dialog).backgroundColor,
                headerMarginBottom: getComputedStyle(header).marginBottom,
                actionsPadding: getComputedStyle(actions).padding,
                chatHeight: chat?.height || 0,
                systemHeight: system?.height || 0
            };
        });
        if (narrowDialog.box.left < -1 || narrowDialog.box.top < -1
            || narrowDialog.box.right > narrowDialog.viewport.width + 1
            || narrowDialog.box.bottom > narrowDialog.viewport.height + 1
            || (narrowDialog.box.right - narrowDialog.box.left) < 480
            || narrowDialog.background === 'rgba(0, 0, 0, 0)'
            || narrowDialog.headerMarginBottom !== '0px'
            || narrowDialog.actionsPadding !== '12px 16px'
            || narrowDialog.chatHeight > 320 || narrowDialog.systemHeight > 185) {
            throw new Error(`Agentic layout escaped its viewport: ${JSON.stringify(narrowDialog)}`);
        }

        await page.fill('#apiKeyInputSess', `smoke-key-${Date.now()}-not-real`);
        await page.click('#sessionControlsSave');
        await page.waitForFunction(() => !document.getElementById('sessionControlsDialog')?.open, undefined, {
            timeout: 10000
        });
        if (credentialPosts !== 1) {
            throw new Error(`Credential save did not reach the encrypted vault: ${credentialPosts}`);
        }
        const browserKey = await page.evaluate(() => localStorage.getItem('geminiApiKey'));
        if (browserKey) throw new Error('API key remained in plaintext browser storage after secure save.');

        await page.setViewportSize({ width: 1600, height: 1000 });
        await page.evaluate(() => document.getElementById('sessionControlsSettingsButton').click());
        await page.waitForFunction(() => document.getElementById('sessionControlsDialog')?.open);
        const wideDialog = await page.evaluate(() => {
            const dialog = document.getElementById('sessionControlsDialog');
            const box = dialog.getBoundingClientRect();
            return {
                viewport: { width: innerWidth, height: innerHeight },
                box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
                credentialState: document.getElementById('geminiCredentialBadge')?.dataset.state
            };
        });
        if (wideDialog.box.left < -1 || wideDialog.box.top < -1
            || wideDialog.box.right > wideDialog.viewport.width + 1
            || wideDialog.box.bottom > wideDialog.viewport.height + 1
            || (wideDialog.box.right - wideDialog.box.left) < 600
            || wideDialog.credentialState !== 'ready') {
            throw new Error(`Wide Session Controls layout/status failed: ${JSON.stringify(wideDialog)}`);
        }

        if (pageErrors.length) throw new Error(`Page errors:\n${pageErrors.join('\n\n')}`);
        if (process.env.EVE_SMOKE_VERBOSE === '1') {
            console.log(JSON.stringify({ controls, credentialPosts, narrowDialog, wideDialog }));
        }
        console.log('GEMINI_AGENTIC_CONTROLS_BROWSER_SMOKE_OK');
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
});
