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

        await page.evaluate(() => {
            window.__geminiRelayToggleEvents = [];
            window.addEventListener('eve:gemini-live-link-toggled', (event) => {
                window.__geminiRelayToggleEvents.push(event.detail?.enabled);
            });
        });
        await page.click('label[for="geminiLiveLinkToggle"]');
        const relayPaused = await page.evaluate(() => {
            const box = (selector) => {
                const element = document.querySelector(selector);
                if (!element) return null;
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return {
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
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
        await page.click('label[for="geminiLiveLinkToggle"]');

        await page.click('label[for="playProcessedAudioToggle"]');
        await page.waitForFunction(() => document.getElementById('audioSettingsButton')?.disabled);
        await page.click('label[for="playProcessedAudioToggle"]');
        await page.waitForFunction(() => !document.getElementById('audioSettingsButton')?.disabled);
        await page.click('#audioSettingsButton');
        if (!(await page.locator('#audioSettingsDialog').evaluate((dialog) => dialog.open))) {
            throw new Error('Audio Processing settings did not open.');
        }
        await page.click('#audioSettingsCancel');

        await page.click('#selfTalkSettingsButton');
        if (!(await page.locator('#selfTalkSettingsDialog').evaluate((dialog) => dialog.open))) {
            throw new Error('AI Self-talk settings did not open.');
        }
        await page.click('#selfTalkSettingsCancel');

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
        console.log(`GEMINI_AGENTIC_CONTROLS_BROWSER_SMOKE_OK ${JSON.stringify({
            controls,
            credentialPosts,
            narrowDialog,
            wideDialog
        })}`);
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
});
