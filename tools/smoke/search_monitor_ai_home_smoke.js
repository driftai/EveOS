#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const tloChatPath = path.join(ROOT, 'js', 'modules', 'gemini', 'search_monitor', 'tloChat.js');
const nexusBrowserPath = path.join(ROOT, 'js', 'modules', 'gemini', 'search_monitor', 'nexusBrowser.js');
const agentNexusPath = path.join(ROOT, 'js', 'modules', 'gemini', 'search_monitor', 'agentNexus.js');
const aiHomeMarkupPath = path.join(ROOT, 'js', 'modules', 'gemini', 'search_monitor', 'searchMonitorAiHome.markup.js');
const aiHomePath = path.join(ROOT, 'js', 'modules', 'gemini', 'search_monitor', 'searchMonitorAiHome.js');
const initPath = path.join(ROOT, 'js', 'modules', 'gemini', 'gemini-init.js');
const loaderPath = path.join(ROOT, 'js', 'modules', 'gemini', 'html_loaders', 'layout', 'mdl_wrap', 'mdlLayoutWrapperUILoader.js');
const harnessAppPath = path.join(ROOT, 'tools', 'Local-MoE-Harness', 'web', 'app.js');
const harnessIndexPath = path.join(ROOT, 'tools', 'Local-MoE-Harness', 'web', 'index.html');
const manifestPath = path.join(ROOT, 'js', 'config', 'manifest', 'scripts.parts', '13-gemini.js');
const viewportCssPath = path.join(ROOT, 'css', 'modules', 'gemini', 'gemini_link_surfaces.viewport.css');
const tloChatSource = fs.readFileSync(tloChatPath, 'utf8');
const nexusBrowserSource = fs.readFileSync(nexusBrowserPath, 'utf8');
const agentNexusSource = fs.readFileSync(agentNexusPath, 'utf8');
const aiHomeMarkupSource = fs.readFileSync(aiHomeMarkupPath, 'utf8');
const source = fs.readFileSync(aiHomePath, 'utf8');
const initSource = fs.readFileSync(initPath, 'utf8');
const loaderSource = fs.readFileSync(loaderPath, 'utf8');
const harnessAppSource = fs.readFileSync(harnessAppPath, 'utf8');
const harnessIndexSource = fs.readFileSync(harnessIndexPath, 'utf8');
const manifestSource = fs.readFileSync(manifestPath, 'utf8');
const viewportCssSource = fs.readFileSync(viewportCssPath, 'utf8');

const requests = [];
let localMoeResponse = {
    ok: true, running: false, state: 'stopped', setupReady: true, runtimeReady: false,
    runtimeReachable: false, runtimeHealth: 'offline', runtimeManagedRunning: false,
    runtimeStartupStage: 'stopped', runtimeLastError: '',
    activeModel: { id: 'qwen36-nvfp4', label: 'Qwen 35B' }, port: 5180, runtimePort: 1919,
    message: 'Stopped; explicit start required.'
};
const windowMock = {
    setTimeout, clearTimeout,
    location: { protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:8765' },
    open() {}, addEventListener() {},
    EveOSLocalControl: {
        baseUrl: () => 'http://127.0.0.1:9082',
        async fetchJson(url, options) {
            requests.push({ url, method: options?.method || 'GET' });
            return { ...localMoeResponse };
        }
    }
};
const sharedContext = { window: windowMock, console, setTimeout, clearTimeout, AbortController, URLSearchParams };
vm.runInNewContext(tloChatSource, sharedContext, { filename: tloChatPath });
vm.runInNewContext(nexusBrowserSource, sharedContext, { filename: nexusBrowserPath });
vm.runInNewContext(agentNexusSource, sharedContext, { filename: agentNexusPath });
vm.runInNewContext(aiHomeMarkupSource, sharedContext, { filename: aiHomeMarkupPath });
vm.runInNewContext(source, sharedContext, { filename: aiHomePath });

function assert(condition, message) { if (!condition) throw new Error(message); }

(async () => {
    const api = windowMock.EveOSSearchMonitorAiHome;
    assert(api, 'AI Home API was not exported');
    assert(windowMock.EveOSSearchMonitorAiHomeMarkup?.markup, 'AI Home markup API was not exported');
    const markup = api.markup();
    for (const provider of ['gemini', 'local-moe', 'agents']) {
        assert(markup.includes(`data-ai-provider="${provider}"`), `Missing ${provider} provider section`);
    }
    assert(markup.includes('Search Monitor Assistant'), 'Compact Search Monitor Assistant was removed');
    assert(markup.includes('data-eveos-control-plane'), 'Top localhost control is missing');
    assert(markup.includes('data-agent-id="tlo"') && markup.includes('data-agent-tool-id="nexus-browser"'),
        'Agent Nexus does not expose TLO and Nexus Browser as distinct peers');
    assert(markup.includes('data-agent-nexus-view="management"') && markup.includes('Agent Management'),
        'Agent Nexus is missing the private Agent Management surface');
    assert(agentNexusSource.includes('/api/eve-state/modular/agent-management'),
        'Agent Nexus is not wired to versioned local Agent Management');
    assert(!agentNexusSource.includes('/api/local-moe/start') && !tloChatSource.includes('/api/local-moe/start'),
        'Opening Agent Nexus can start Local MoE instead of remaining passive');
    assert(!/<details[^>]+data-ai-provider="(?:gemini|local-moe|agents)"[^>]*\sopen(?:\s|>)/.test(markup),
        'A provider is expanded by default');
    assert(source.includes('/api/local-moe/start') && source.includes('/api/local-moe/stop'),
        'Local MoE lifecycle routes are missing');
    assert(source.includes('eve:eveos-control-plane-status')
        && source.includes('EveOSTloChat?.refreshStatus?.()')
        && source.includes('EveOSNexusBrowser?.refresh?.()'),
        'Search Monitor runtime peers no longer recover from the control-plane heartbeat');
    assert(tloChatSource.includes('api_unreachable') && tloChatSource.includes('EveOSControlPlane?.getState?.()'),
        'TLO no longer distinguishes API reachability from EveOS server state');
    assert(markup.includes('data-local-moe-frame') && markup.includes('Local MoE models and chat'),
        'Local MoE chat is not embedded in its provider workspace');
    assert(markup.includes('sandbox="allow-forms allow-scripts allow-same-origin"'),
        'Local MoE inline chat is missing its iframe isolation contract');
    assert(!source.includes('window.open(lastLocalMoeStatus.url'),
        'Local MoE still requires a separate tab instead of its inline workspace');
    assert(harnessAppSource.includes("document.activeElement?.closest?.('#chat-form')"),
        'Harness status polling can replace live controls while inline chat has focus');
    assert(harnessAppSource.includes("!modelPanel.classList.contains('hidden') && !modelSwitchInProgress"),
        'Harness status polling can replace model-switch controls while the library is open');
    assert(harnessAppSource.includes('LocalMoeConfirm.ask')
        && !harnessAppSource.includes('window.confirm(')
        && harnessIndexSource.includes('/static/confirmation-ui.js'),
        'Embedded Harness model switching still depends on sandbox-blocked native dialogs');
    assert(harnessAppSource.includes('${runtimeLabel} stopped') && harnessAppSource.includes('lifecycle.startup_stage'),
        'Harness UI no longer distinguishes an intentionally stopped model runtime from an offline Harness');
    assert(source.includes("const LOCAL_MOE_EMBED_VERSION = '20260923.3';")
        && harnessIndexSource.includes('/static/app.js?v=20260923.3'),
        'Local MoE embed/app cache revisions are not synchronized');
    assert(!initSource.includes("requestGeminiBoot('full-monitor-view')"),
        'Opening Workspace still boots Gemini before its provider is opened');
    assert(loaderSource.includes("getElementById('gemini-provider-runtime-host')"),
        'Gemini full UI is not scoped to its provider body');
    assert(manifestSource.indexOf('tloChat.js') < manifestSource.indexOf('nexusBrowser.js')
        && manifestSource.indexOf('nexusBrowser.js') < manifestSource.indexOf('agentNexus.js')
        && manifestSource.indexOf('agentNexus.js') < manifestSource.indexOf('searchMonitorAiHome.markup.js')
        && manifestSource.indexOf('searchMonitorAiHome.markup.js') < manifestSource.indexOf('searchMonitorAiHome.js')
        && manifestSource.indexOf('searchMonitorAiHome.js') < manifestSource.indexOf('gemini-init.js'),
        'Agent Nexus, AI Home markup, and AI Home controller are not registered in dependency order');
    assert(/#loadingIndicator:not\(\.compact\):not\(\.wide-mode\):not\(\.fullscreen-mode\)[^{]+\.gemini-monitor-shell-toolbar\s*\{[^}]*flex-direction:\s*column/s.test(viewportCssSource),
        'Normal-width Search Monitor does not stack its title above toolbar actions');
    assert(/#loadingIndicator:not\(\.compact\):not\(\.wide-mode\):not\(\.fullscreen-mode\)[^{]+\.gemini-monitor-toolbar-actions\s*\{[^}]*flex-wrap:\s*wrap/s.test(viewportCssSource),
        'Normal-width Search Monitor actions can overflow into the title row');

    const listeners = {};
    const gemini = { open: false, addEventListener(type, fn) { listeners[`gemini:${type}`] = fn; } };
    const localMoe = { open: false, addEventListener(type, fn) { listeners[`local:${type}`] = fn; } };
    const primary = { dataset: {}, textContent: '', disabled: false };
    const inlineHost = { hidden: true };
    const inlineFrame = { dataset: {}, src: '', removeAttribute(name) { if (name === 'src') this.src = ''; } };
    const textNodes = new Map([
        ['[data-local-moe-state]', { textContent: '' }], ['[data-local-moe-summary]', { textContent: '' }],
        ['[data-local-moe-harness]', { textContent: '' }], ['[data-local-moe-runtime]', { textContent: '' }],
        ['[data-local-moe-model]', { textContent: '' }], ['[data-local-moe-profile]', { textContent: '' }],
        ['[data-local-moe-ports]', { textContent: '' }], ['[data-local-moe-gpu]', { textContent: '' }],
        ['[data-local-moe-message]', { textContent: '' }]
    ]);
    const root = {
        addEventListener() {},
        querySelector(selector) {
            if (selector === '[data-ai-provider="gemini"]') return gemini;
            if (selector === '[data-ai-provider="local-moe"]') return localMoe;
            if (selector === '[data-local-moe-primary]') return primary;
            if (selector === '[data-local-moe-inline]') return inlineHost;
            if (selector === '[data-local-moe-frame]') return inlineFrame;
            return textNodes.get(selector) || null;
        },
        querySelectorAll() { return []; }
    };
    let geminiBootRequests = 0;
    api.bind(root, { onGeminiOpen() { geminiBootRequests += 1; } });
    api.setWorkspaceActive(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(requests.length === 1 && requests[0].url.endsWith('/api/local-moe/status'),
        'Workspace activation must perform only a passive Local MoE status read');
    assert(requests[0].method === 'GET', 'Workspace activation issued a mutating Local MoE request');
    assert(geminiBootRequests === 0, 'Workspace activation booted collapsed Gemini Link');
    gemini.open = true;
    listeners['gemini:toggle']();
    assert(geminiBootRequests === 1, 'Opening Gemini Link did not request its preserved workspace');

    localMoe.open = true;
    localMoeResponse = {
        ...localMoeResponse, running: true, state: 'running', runtimeReady: false, runtimeReachable: false,
        runtimeManagedRunning: false, runtimeStartupStage: 'stopped', runtimeLastError: '', runtimeHealth: 'offline',
        message: 'Local MoE Harness is online.', url: 'http://127.0.0.1:5180/'
    };
    await api.refreshLocalMoe();
    assert(textNodes.get('[data-local-moe-state]').textContent === 'Online'
        && textNodes.get('[data-local-moe-harness]').textContent === 'Online',
        'Healthy Harness was mislabeled offline when the model runtime was stopped');
    assert(textNodes.get('[data-local-moe-runtime]').textContent === 'Stopped',
        'Stopped model runtime was mislabeled as an offline Local MoE Harness');
    assert(primary.dataset.localMoeAction === 'start' && primary.textContent === 'Start model',
        'Online Harness with stopped model did not expose a model-start recovery action');

    localMoeResponse = { ...localMoeResponse, runtimeManagedRunning: true, runtimeStartupStage: 'loading_weights' };
    await api.refreshLocalMoe();
    assert(textNodes.get('[data-local-moe-runtime]').textContent === 'Loading model',
        'Managed model startup was not rendered separately from Harness health');
    assert(primary.dataset.localMoeAction === 'stop' && primary.textContent === 'Stop',
        'Managed model startup did not expose the full Local MoE stop action');

    localMoeResponse = {
        ...localMoeResponse, runtimeReady: true, runtimeReachable: true,
        runtimeManagedRunning: true, runtimeStartupStage: 'ready', runtimeHealth: 'ok'
    };
    await api.refreshLocalMoe();
    assert(inlineHost.hidden === false && inlineFrame.src.startsWith(localMoeResponse.url)
        && inlineFrame.src.includes('eveos_embed='), 'Running Local MoE did not mount its inline Harness workspace');

    const mountedSource = inlineFrame.src;
    localMoeResponse = { ...localMoeResponse, running: false, state: 'starting' };
    await api.refreshLocalMoe();
    assert(inlineHost.hidden === false && inlineFrame.src === mountedSource,
        'Transient Local MoE resync unloaded the active embedded Harness');
    localMoeResponse = { ...localMoeResponse, running: true, state: 'running' };

    const requestsBeforeReopen = requests.length;
    listeners['local:toggle']();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(requests.length === requestsBeforeReopen + 1,
        'Reopening Local MoE reused stale status instead of performing a fresh read');

    const originalFetchJson = windowMock.EveOSLocalControl.fetchJson;
    let resolveOlderStatus;
    let resolveNewerStatus;
    let overlapCalls = 0;
    windowMock.EveOSLocalControl.fetchJson = async () => new Promise((resolve) => {
        overlapCalls += 1;
        if (overlapCalls === 1) resolveOlderStatus = resolve;
        else resolveNewerStatus = resolve;
    });
    const olderRefresh = api.refreshLocalMoe();
    const newerRefresh = api.refreshLocalMoe();
    resolveNewerStatus({
        ...localMoeResponse, running: true, state: 'running', runtimeReady: true, runtimeReachable: true,
        runtimeManagedRunning: true, runtimeStartupStage: 'ready', runtimeHealth: 'ok', message: 'Newest healthy status'
    });
    await newerRefresh;
    resolveOlderStatus({
        ...localMoeResponse, running: false, state: 'stopped', runtimeReady: false, runtimeReachable: false,
        runtimeManagedRunning: false, runtimeStartupStage: 'stopped', runtimeHealth: 'offline',
        message: 'Older stale stopped status'
    });
    await olderRefresh;
    windowMock.EveOSLocalControl.fetchJson = originalFetchJson;
    assert(textNodes.get('[data-local-moe-state]').textContent === 'Online'
        && textNodes.get('[data-local-moe-runtime]').textContent === 'Ready',
        'Older Local MoE status response overwrote a newer healthy response');

    localMoeResponse = {
        ...localMoeResponse, running: false, state: 'stopped', runtimeReady: false,
        runtimeReachable: false, runtimeManagedRunning: false, runtimeStartupStage: 'stopped'
    };
    await api.refreshLocalMoe();
    assert(inlineHost.hidden === true && inlineFrame.src === '', 'Stopped Local MoE did not unload its inline Harness workspace');

    console.log('SEARCH_MONITOR_AI_HOME_SMOKE_OK');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
