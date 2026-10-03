#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { runBrowserSmoke } = require('./browser-smoke-diagnostics.shared');

const ROOT = path.resolve(__dirname, '..', '..');
const FILE_URL = 'file:///' + path.join(ROOT, 'EveOS.html').replace(/\\/g, '/');

function assert(condition, message) {
    if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

function baseAgent(overrides = {}) {
    return {
        id: 'tlo',
        displayName: 'TLO',
        role: 'Local EveOS agent',
        identity: 'Local test identity',
        workingRules: ['Stay scoped'],
        providerBinding: { provider: 'local-moe', modelId: '', profile: '' },
        allowedTools: ['nexus-browser'],
        permissions: [],
        privateNotes: ['PRIVATE_BROWSER_SMOKE_SENTINEL'],
        scopes: [{
            id: 'default',
            label: 'Default',
            instructions: 'Use the default local scope.',
            context: [],
            allowedTools: ['nexus-browser']
        }],
        ...overrides
    };
}

async function main() {
    const requests = [];
    let savedAgent = baseAgent();
    let savedDefinition = { text: '# TLO\n\nBrowser smoke definition\n', source: 'starter-file',
        path: 'config/agents/tlo/AGENT.md', origin: 'Origin-only browser smoke sentinel' };
    let runtimeReady = false;

    await runBrowserSmoke({
        name: 'agent-nexus-browser',
        viewport: { width: 1600, height: 1200 }
    }, async ({ page, browserMode, events }) => {
        events.mockRequests = requests;
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
        };

        await page.route(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/(?:eve-state\/modular\/(?:tlo|agent-management)|nexus-browser|local-moe)/, async (route) => {
            const request = route.request();
            const url = new URL(request.url());
            const entry = { method: request.method(), path: url.pathname };
            requests.push(entry);

            if (request.method() === 'OPTIONS') {
                await route.fulfill({ status: 204, headers: corsHeaders, body: '' });
                return;
            }

            if (url.pathname === '/api/eve-state/modular/tlo/status') {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    headers: corsHeaders,
                    body: JSON.stringify({
                        ok: true,
                        state: runtimeReady ? 'ready' : 'stopped',
                        canChat: runtimeReady,
                        message: runtimeReady ? 'TLO is ready through the active Local MoE model.' : 'Local MoE is stopped.',
                        agent: {
                            id: 'tlo',
                            displayName: 'TLO',
                            role: 'Local EveOS agent',
                            provider: 'local-moe',
                            scopeId: 'default',
                            activeModelId: runtimeReady ? 'qwen36-nvfp4' : ''
                        }
                    })
                });
                return;
            }

            if (url.pathname === '/api/eve-state/modular/agent-management' && request.method() === 'GET') {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    headers: corsHeaders,
                    body: JSON.stringify({
                        ok: true,
                        persisted: true,
                        store: {
                            schema: 'eveos.agent-management',
                            schemaVersion: 1,
                            agents: [savedAgent]
                        }
                    })
                });
                return;
            }

            if (url.pathname === '/api/eve-state/modular/agent-management/save' && request.method() === 'POST') {
                const payload = request.postDataJSON();
                savedAgent = payload.agent;
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    headers: corsHeaders,
                    body: JSON.stringify({ ok: true, agent: savedAgent })
                });
                return;
            }

            if (url.pathname === '/api/eve-state/modular/agent-management/definition') {
                if (request.method() === 'POST') {
                    savedDefinition = { ...savedDefinition, text: request.postDataJSON().text,
                        source: 'private-file', path: 'data/runtime/agent-management/tlo/AGENT.md' };
                }
                await route.fulfill({ status: 200, contentType: 'application/json', headers: corsHeaders,
                    body: JSON.stringify({ ok: true, definition: savedDefinition }) });
                return;
            }

            if (url.pathname === '/api/eve-state/modular/agent-management/portable/preview') {
                await route.fulfill({ status: 200, contentType: 'application/json', headers: corsHeaders,
                    body: JSON.stringify({ ok: true, plan: { incomingAgents: 1, incomingRooms: 1,
                        incomingMessages: 2, addedAgents: [], addedRooms: ['room-imported'],
                        conflictingAgents: [], conflictingRooms: [], canApply: true } }) });
                return;
            }
            if (url.pathname === '/api/eve-state/modular/agent-management/portable/apply') {
                await route.fulfill({ status: 200, contentType: 'application/json', headers: corsHeaders,
                    body: JSON.stringify({ ok: true, plan: { backupPath: 'ignored-test-backup' } }) });
                return;
            }

            if (url.pathname === '/api/local-moe/status' && request.method() === 'GET') {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    headers: corsHeaders,
                    body: JSON.stringify({
                        ok: true,
                        running: runtimeReady,
                        state: runtimeReady ? 'running' : 'stopped',
                        setupReady: true,
                        runtimeReady,
                        runtimeHealth: runtimeReady ? 'ok' : 'Offline',
                        port: 5180,
                        runtimePort: 1919,
                        message: runtimeReady ? 'Local MoE Harness is online and managed by EveOS.' : 'Local MoE is stopped.'
                    })
                });
                return;
            }

            if (url.pathname === '/api/nexus-browser/status') {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    headers: corsHeaders,
                    body: JSON.stringify({
                        ok: true,
                        service: 'nexus-browser-control',
                        state: runtimeReady ? 'running' : 'stopped',
                        running: runtimeReady,
                        dependenciesReady: true,
                        setupAvailable: false,
                        extensionReady: true,
                        extensionConnected: runtimeReady,
                        appBinding: runtimeReady ? { connected: true, providerName: 'ChatGPT App' } : { connected: false },
                        onlineTargets: runtimeReady ? 14 : 0,
                        localTargets: runtimeReady ? 1 : 0,
                        dexRooms: runtimeReady ? 1 : 0,
                        port: 9088,
                        message: runtimeReady ? 'Nexus Browser is online.' : 'Nexus Browser is ready and stopped.'
                    })
                });
                return;
            }

            // A start/stop/setup action is never expected during passive navigation in this smoke.
            await route.fulfill({
                status: 409,
                contentType: 'application/json',
                headers: corsHeaders,
                body: JSON.stringify({ ok: false, message: `Unexpected mutation: ${request.method()} ${url.pathname}` })
            });
        });

        await page.goto(FILE_URL, { waitUntil: 'domcontentloaded', timeout: 240000 });
        await page.waitForFunction(() => (
            !!window.SearchMonitorBoot
            && !!window.EveOSSearchMonitorAiHome
            && !!window.EveOSAgentNexus
            && !!window.EveOSTloChat
            && !!window.EveOSNexusBrowser
            && !!document.querySelector('[data-ai-provider="agents"]')
        ), undefined, { timeout: 120000 });

        await page.evaluate(() => window.SearchMonitorBoot?.expand?.());
        await page.waitForFunction(() => (
            !document.getElementById('loadingIndicator')?.classList.contains('compact')
        ), undefined, { timeout: 10000 });

        await page.locator('[data-gemini-monitor-view-btn="full"]').click();
        await page.waitForFunction(() => {
            const root = document.getElementById('gemini-ui-root');
            const workspace = root?.querySelector('[data-ai-home-workspace]');
            return root?.dataset.geminiMonitorView === 'full'
                && !!workspace
                && window.getComputedStyle(workspace).display !== 'none';
        }, undefined, { timeout: 10000 });

        const agents = page.locator('[data-ai-provider="agents"]');
        const agentSummary = agents.locator(':scope > summary');
        await agentSummary.click();
        await page.waitForFunction(() => document.querySelector('[data-ai-provider="agents"]')?.open === true);

        const tloPanel = page.locator('[data-agent-nexus-panel="tlo"]');
        assert(await tloPanel.isVisible(), 'TLO must be the default visible Agent Nexus panel');
        await page.waitForFunction(() => (
            document.querySelector('[data-tlo-state]')?.textContent?.trim() === 'Stopped'
        ), undefined, { timeout: 10000 });

        runtimeReady = true;
        await page.evaluate(() => {
            window.dispatchEvent(new CustomEvent('eve:eveos-control-plane-status', {
                detail: { controllerAvailable: true, webRunning: true, serverState: 'running' }
            }));
        });
        await page.waitForFunction(() => (
            document.querySelector('[data-local-moe-state]')?.textContent?.trim() === 'Online'
            && document.querySelector('[data-tlo-state]')?.textContent?.trim() === 'Ready'
            && document.querySelector('[data-nexus-browser-state]')?.textContent?.trim() === 'Online'
            && document.querySelector('[data-nexus-browser-app-connection]')?.textContent?.trim() === 'Connected · ChatGPT App'
        ), undefined, { timeout: 10000 });

        await page.locator('[data-agent-nexus-view="nexus-browser"]').first().click();
        const browserPanel = page.locator('[data-agent-nexus-panel="nexus-browser"]');
        assert(await browserPanel.isVisible(), 'Nexus Browser panel did not become visible');
        await page.waitForFunction(() => (
            document.querySelector('[data-nexus-browser-state]')?.textContent?.trim() === 'Online'
        ), undefined, { timeout: 10000 });

        await page.locator('[data-agent-nexus-view="management"]').first().click();
        const managementPanel = page.locator('[data-agent-nexus-panel="management"]');
        assert(await managementPanel.isVisible(), 'Agent Management panel did not become visible');
        await page.waitForFunction(() => (
            document.querySelector('[data-agent-management-form]')?.hidden === false
            && document.querySelector('[data-agent-management-status]')?.textContent?.includes('loaded')
        ), undefined, { timeout: 10000 });

        const nameField = page.locator('[data-agent-management-form] [name="displayName"]');
        assert(await nameField.inputValue() === 'TLO', 'Agent Management did not load the persisted profile');
        assert(
            await page.locator('[data-agent-management-form] [name="privateNotes"]').inputValue()
                === 'PRIVATE_BROWSER_SMOKE_SENTINEL',
            'Private notes were not available inside the explicitly opened private management surface'
        );
        const definitionEditor = page.locator('[data-agent-management-form] [name="tloDefinition"]');
        assert(await definitionEditor.isVisible(), 'TLO file definition editor is not visible');
        assert(await definitionEditor.inputValue() === savedDefinition.text, 'TLO definition did not load');
        assert((await page.locator('[data-agent-tlo-path]').textContent()).includes('AGENT.md'),
            'The active definition path was not visible');
        assert((await page.locator('[data-agent-tlo-origin]').textContent()).includes('Origin-only browser smoke sentinel'),
            'TLO origin metadata was not visible separately');
        assert(!(await page.locator('[data-agent-json-identity]').isVisible()),
            'Legacy JSON identity editor is visible beside the authoritative TLO file');
        await definitionEditor.fill('# TLO\n\nEdited in browser');
        await page.locator('[data-agent-management-action="save-definition"]').click();
        await page.waitForFunction(() => document.querySelector('[data-agent-management-status]')?.textContent?.includes('definition saved'));
        assert(savedDefinition.text.includes('Edited in browser'), 'Definition save did not use the file-backed route');

        await nameField.fill('TLO Browser Smoke');
        await page.locator('[data-agent-management-form] [data-agent-management-action="save"]').click();
        await page.waitForFunction(() => (
            document.querySelector('[data-agent-management-status]')?.textContent?.includes('saved to the private local store')
        ), undefined, { timeout: 10000 });
        assert(savedAgent.displayName === 'TLO Browser Smoke', 'Agent Management save did not send the edited profile');

        await page.locator('[data-agent-portable-file]').setInputFiles({
            name: 'dummy-agent-nexus.json', mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify({ schema: 'eveos.agent-nexus-portable', schemaVersion: 1 }))
        });
        await page.locator('[data-agent-management-action="preview"]').click();
        await page.waitForFunction(() => !document.querySelector('[data-agent-management-action="apply"]')?.hidden);
        assert((await page.locator('[data-agent-portable-status]').textContent()).includes('1 rooms'),
            'Portable preview counts were not shown');
        await page.locator('[data-agent-management-action="apply"]').click();
        await page.waitForFunction(() => document.querySelector('[data-agent-portable-status]')?.textContent?.includes('Import complete'));

        await page.locator('[data-agent-management-action="new"]').click();
        const draftId = await page.locator('[data-agent-management-form] [name="id"]').inputValue();
        assert(/^agent-\d+$/.test(draftId), `New-agent action did not create a local draft: ${draftId}`);

        const geometry = await page.evaluate(() => {
            const monitorNode = document.getElementById('loadingIndicator');
            const agentsNode = document.querySelector('[data-ai-provider="agents"]');
            const nav = document.querySelector('.eveos-agent-nexus-nav');
            const rect = (node) => {
                if (!node) return null;
                const box = node.getBoundingClientRect();
                return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
            };
            return { monitor: rect(monitorNode), agents: rect(agentsNode), nav: rect(nav) };
        });
        assert(geometry.monitor && geometry.agents && geometry.nav, 'Agent Nexus geometry could not be measured');
        assert(geometry.agents.width > 300 && geometry.nav.width > 250, 'Agent Nexus collapsed below usable desktop width');
        assert(
            geometry.agents.left >= geometry.monitor.left - 1
            && geometry.agents.right <= geometry.monitor.right + 1,
            'Agent Nexus escaped the Search Monitor bounds'
        );

        const mutatingLifecycle = requests.filter((entry) => (
            entry.method !== 'GET'
            && /\/api\/(?:local-moe|nexus-browser)\/(?:start|stop|setup)/.test(entry.path)
        ));
        assert(mutatingLifecycle.length === 0,
            `Passive Agent Nexus navigation mutated a runtime: ${JSON.stringify(mutatingLifecycle)}`);

        const localMoeStatusReads = requests.filter((entry) => (
            entry.path === '/api/local-moe/status' && entry.method === 'GET'
        ));
        const tloStatusReads = requests.filter((entry) => entry.path === '/api/eve-state/modular/tlo/status');
        const nexusStatusReads = requests.filter((entry) => entry.path === '/api/nexus-browser/status');
        const managementReads = requests.filter((entry) => (
            entry.path === '/api/eve-state/modular/agent-management' && entry.method === 'GET'
        ));
        const managementWrites = requests.filter((entry) => (
            entry.path === '/api/eve-state/modular/agent-management/save' && entry.method === 'POST'
        ));
        assert(localMoeStatusReads.length >= 1, 'Entering Workspace did not perform the passive Local MoE status read');
        assert(tloStatusReads.length >= 1, 'Opening Agent Nexus did not perform a passive TLO status read');
        assert(nexusStatusReads.length >= 1, 'Opening Nexus Browser did not perform a passive status read');
        assert(managementReads.length === 2, `Agent Management loaded ${managementReads.length} times instead of twice`);
        assert(managementWrites.length === 1, `Agent Management saved ${managementWrites.length} times instead of once`);
        assert(events.pageErrors.length === 0, `Page errors detected: ${events.pageErrors.join('\n')}`);

        console.log('AGENT_NEXUS_BROWSER_SMOKE_OK ' + JSON.stringify({
            browserMode,
            requests: requests.length,
            localMoeStatusReads: localMoeStatusReads.length,
            tloStatusReads: tloStatusReads.length,
            nexusStatusReads: nexusStatusReads.length,
            managementReads: managementReads.length,
            managementWrites: managementWrites.length,
            statusRecovery: true
        }));
    });
}

main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
});
