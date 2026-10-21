const path = require('path');
const fs = require('fs');
const { runBrowserSmoke } = require('./browser-smoke-diagnostics.shared');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FILE_URL = 'file:///' + path.join(REPO_ROOT, 'EveOS.html').replace(/\\/g, '/');

function isBenignConsoleError(entry) {
    return /Tracking Prevention blocked access to storage/i.test(entry)
        || /Failed to load resource/i.test(entry)
        || /Access to fetch at/i.test(entry)
        || /QuotaExceededError/i.test(entry)
        || /Critical module CacheManager is missing/i.test(entry)
        || /ERR_FAILED 200 \(OK\)/i.test(entry)
        || /ERR_CONNECTION_RESET/i.test(entry)
        || /ERR_FAILED 403 \(Forbidden\)/i.test(entry);
}

async function main() {
    await runBrowserSmoke({
        name: 'gemini-monitor-dual-view',
        viewport: { width: 1600, height: 1280 }
    }, async ({ page, events }) => {
        const pageErrors = events.pageErrors;
        const consoleErrors = [];
        page.on('console', (msg) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text());
        });
        await page.goto(FILE_URL, { waitUntil: 'domcontentloaded', timeout: 240000 });
        await page.waitForFunction(() => (
            !!document.getElementById('loadingIndicator')
            && !!document.getElementById('gemini-ui-root')
            && !!window.SearchMonitorBoot
            && !!window.EveOSSearchMonitorAiHome
            && !!document.getElementById('search-monitor-assistant-pane')
        ), undefined, { timeout: 120000 });

        await page.evaluate(() => {
            document.getElementById('loadingIndicator')?.click();
        });
        await page.waitForFunction(() => !document.getElementById('loadingIndicator')?.classList.contains('compact'), undefined, { timeout: 10000 });

        await page.evaluate(() => {
            document.querySelector('[data-gemini-monitor-view-btn="full"]')?.click();
        });
        await page.waitForFunction(() => {
            const root = document.getElementById('gemini-ui-root');
            return !!root && root.dataset.geminiMonitorView === 'full';
        }, undefined, { timeout: 10000 });

        const passiveWorkspace = await page.evaluate(() => {
            const root = document.getElementById('gemini-ui-root');
            const summary = document.getElementById('search-monitor-assistant-pane');
            const workspace = root?.querySelector('.gemini-monitor-workspace-shell');
            const provider = root?.querySelector('[data-ai-provider="gemini"]');
            return {
                summaryDisplay: summary ? window.getComputedStyle(summary).display : '',
                loadingMessage: summary ? window.getComputedStyle(summary, '::after').content : '',
                workspaceDisplay: workspace ? window.getComputedStyle(workspace).display : '',
                geminiProviderOpen: provider?.open === true,
                fullUiPresent: !!root?.querySelector('.mdl-layout__container'),
                fullReady: root?.dataset.geminiFullReady || ''
            };
        });
        if (passiveWorkspace.summaryDisplay !== 'none'
            || passiveWorkspace.workspaceDisplay === 'none'
            || passiveWorkspace.geminiProviderOpen
            || passiveWorkspace.fullUiPresent
            || passiveWorkspace.loadingMessage !== 'none') {
            throw new Error(`Workspace mode violated passive provider isolation: ${JSON.stringify(passiveWorkspace)}`);
        }

        await page.locator('[data-ai-provider="gemini"] > summary').click();
        await page.waitForFunction(() => (
            document.querySelector('[data-ai-provider="gemini"]')?.open === true
        ), undefined, { timeout: 10000 });
        const providerOpened = await page.evaluate(() => {
            const root = document.getElementById('gemini-ui-root');
            return {
                fullUiPresent: !!root?.querySelector('.mdl-layout__container'),
                runtimeHidden: root?.querySelector('[data-gemini-runtime-shell]')?.hidden === true,
                fullReady: root?.dataset.geminiFullReady || ''
            };
        });
        if (providerOpened.fullUiPresent || !providerOpened.runtimeHidden || providerOpened.fullReady === '1') {
            throw new Error(`Opening Gemini must preserve the explicit workspace load gate: ${JSON.stringify(providerOpened)}`);
        }
        await page.locator('[data-gemini-monitor-load]').click();
        await page.waitForFunction(() => (
            document.getElementById('gemini-ui-root')?.dataset.geminiFullReady === '1'
            && !!document.querySelector('#gemini-provider-runtime-host .mdl-layout__container')
        ), undefined, { timeout: 120000 });

        const result = await page.evaluate(() => {
            function box(selector) {
                const el = document.querySelector(selector);
                if (!el) return null;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return {
                    x: rect.x,
                    right: rect.right,
                    width: rect.width,
                    height: rect.height,
                    display: style.display,
                    position: style.position
                };
            }

            const root = document.getElementById('gemini-ui-root');
            const summaryPane = box('#search-monitor-assistant-pane');
            const workspace = box('#gemini-provider-runtime-host .mdl-layout__container');
            const liveLinkCard = box('#gemini-live-link-card');
            const liveLinkSettings = document.getElementById('geminiLiveLinkSettingsButton');
            const selfTalkActions = box('.gemini-agentic-card--self-talk .gemini-agentic-card-actions');
            const selfTalkToggle = box('.gemini-agentic-card--self-talk .gemini-agentic-switch');
            const audioToggle = box('.gemini-agentic-card--audio .gemini-agentic-switch');
            const apiGuide = document.querySelector('.gemini-api-setup-guide');

            return {
                compact: document.getElementById('loadingIndicator')?.classList.contains('compact') || false,
                rootMode: root?.dataset.geminiMonitorView || '',
                fullReady: root?.dataset.geminiFullReady || '',
                loadingMessage: document.getElementById('search-monitor-assistant-pane')
                    ? window.getComputedStyle(document.getElementById('search-monitor-assistant-pane'), '::after').content
                    : '',
                savedMode: window.localStorage?.getItem('eve.geminiMonitorView') || '',
                summaryPane,
                workspace,
                providerOpen: document.querySelector('[data-ai-provider="gemini"]')?.open === true,
                liveLinkCard,
                liveLinkCollapsed: document.getElementById('gemini-live-link-card')?.classList.contains('is-settings-collapsed') || false,
                liveLinkSettingsExpanded: liveLinkSettings?.getAttribute('aria-expanded') || '',
                selfTalkActions,
                selfTalkToggle,
                audioToggle,
                apiGuide: {
                    exists: !!apiGuide,
                    open: apiGuide?.open === true,
                    keyLink: apiGuide?.querySelector('a[href*="aistudio.google.com/apikey"]')?.href || '',
                    docsLink: apiGuide?.querySelector('a[href*="ai.google.dev/gemini-api/docs/api-key"]')?.href || '',
                    mentionsSonicForge: /Sonic Forge/i.test(apiGuide?.textContent || '')
                }
            };
        });

        if (result.rootMode !== 'full' || result.savedMode !== 'full') {
            throw new Error(`Gemini monitor did not persist full workspace mode: ${JSON.stringify(result)}`);
        }
        if (result.compact) {
            throw new Error(`Search Monitor collapsed while switching Gemini workspace mode: ${JSON.stringify(result)}`);
        }
        if (!result.summaryPane || result.summaryPane.display !== 'none') {
            throw new Error(`Compact summary pane should be hidden in workspace mode: ${JSON.stringify(result)}`);
        }
        if (!result.providerOpen) {
            throw new Error(`Gemini provider did not remain explicitly open after activation: ${JSON.stringify(result)}`);
        }
        if (result.loadingMessage !== 'none') {
            throw new Error(`Ready Gemini workspace retained its loading message: ${JSON.stringify(result)}`);
        }
        if (!result.workspace || result.workspace.display === 'none' || result.workspace.height < 220) {
            throw new Error(`Full Gemini workspace did not render in monitor: ${JSON.stringify(result)}`);
        }
        if (!result.liveLinkCard || result.liveLinkCard.height < 64 || !result.liveLinkCollapsed) {
            throw new Error(`Collapsed Gemini Live Link card did not render: ${JSON.stringify(result)}`);
        }
        if (!result.selfTalkToggle || result.selfTalkToggle.width < 48 || result.selfTalkToggle.height < 28) {
            throw new Error(`Self-talk toggle did not render inside its card bounds: ${JSON.stringify(result)}`);
        }
        if (!result.audioToggle || result.audioToggle.width < 48 || result.audioToggle.height < 28) {
            throw new Error(`Audio toggle did not render inside its card bounds: ${JSON.stringify(result)}`);
        }
        if (!result.apiGuide.exists || result.apiGuide.open
            || !result.apiGuide.keyLink || !result.apiGuide.docsLink || !result.apiGuide.mentionsSonicForge) {
            throw new Error(`Gemini API setup guide is incomplete or not collapsed by default: ${JSON.stringify(result)}`);
        }
        if (!result.selfTalkActions
            || result.selfTalkToggle.x < result.selfTalkActions.x
            || result.selfTalkToggle.right > (result.selfTalkActions.right + 1)) {
            throw new Error(`Self-talk toggle overflowed its action row: ${JSON.stringify(result)}`);
        }

        await page.evaluate(() => document.getElementById('geminiLiveLinkSettingsButton')?.click());
        await page.waitForFunction(() => document.getElementById('geminiLiveLinkSettingsDialog')?.open, undefined, { timeout: 10000 });
        const liveLinkDialog = await page.evaluate(() => {
            const dialog = document.getElementById('geminiLiveLinkSettingsDialog');
            const rect = dialog?.getBoundingClientRect();
            return {
                open: !!dialog?.open,
                height: rect?.height || 0,
                ariaExpanded: document.getElementById('geminiLiveLinkSettingsButton')?.getAttribute('aria-expanded') || '',
                modeOptions: document.getElementById('geminiLiveLinkMode')?.options.length || 0,
                scopeOptions: document.getElementById('geminiLiveLinkScopeMode')?.options.length || 0
            };
        });
        if (!liveLinkDialog.open || liveLinkDialog.ariaExpanded !== 'true'
            || liveLinkDialog.height < 300 || liveLinkDialog.modeOptions < 4 || liveLinkDialog.scopeOptions < 4) {
            throw new Error(`Gemini Live Link settings dialog did not render: ${JSON.stringify(liveLinkDialog)}`);
        }
        result.liveLinkDialog = liveLinkDialog;

        const criticalConsoleErrors = consoleErrors.filter((entry) => !isBenignConsoleError(entry));
        if (pageErrors.length) {
            throw new Error(`Page errors detected:\n${pageErrors.join('\n\n')}`);
        }
        if (criticalConsoleErrors.length) {
            throw new Error(`Console errors detected:\n${criticalConsoleErrors.join('\n')}`);
        }

        const resultDir = path.join(REPO_ROOT, 'data', 'runtime', 'smoke-results');
        fs.mkdirSync(resultDir, { recursive: true });
        fs.writeFileSync(path.join(resultDir, 'gemini-monitor-dual-view-result.json'), JSON.stringify({ passiveWorkspace, providerOpened, result }, null, 2));
        console.log('GEMINI_MONITOR_DUAL_VIEW_SMOKE_OK passiveWorkspace=true explicitLoad=true geometry=true controls=true');
    });
}

main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
});
