/* Search Monitor AI Home: provider lifecycle/controller surface. */
(function () {
    'use strict';

    const LOCAL_MOE_EMBED_VERSION = '20260923.3';
    if (window.EveOSSearchMonitorAiHome) return;

    const STATUS_PATH = '/api/local-moe/status';
    const ACTION_PATHS = {
        start: '/api/local-moe/start',
        stop: '/api/local-moe/stop',
        setup: '/api/local-moe/setup'
    };
    const PROVIDER_RELOADS = Object.freeze({
        gemini: Object.freeze({ label: 'Gemini Link', status: '/api/gemini-server/status', stop: '/api/gemini-server/stop', start: '/api/gemini-server/start' }),
        'local-moe': Object.freeze({ label: 'Local MoE', status: '/api/local-moe/status', stop: '/api/local-moe/stop', start: '/api/local-moe/start' }),
        'nexus-browser': Object.freeze({ label: 'Nexus Browser', status: '/api/nexus-browser/status', stop: '/api/nexus-browser/stop', start: '/api/nexus-browser/start' })
    });
    let boundRoot = null;
    let localMoeBusy = false;
    let localMoeLoaded = false;
    let localMoeRefreshGeneration = 0;
    let localMoeRefreshPromise = null;
    let lastLocalMoeStatus = null;
    let onGeminiOpen = null;
    let workspaceActive = false;
    let controlHeartbeatBound = false;
    let geminiWorkspaceLoaded = false;
    let providerReloadBusy = '';

    function markup() {
        const renderer = window.EveOSSearchMonitorAiHomeMarkup?.markup;
        if (typeof renderer !== 'function') throw new Error('Search Monitor AI Home markup module is unavailable.');
        return renderer();
    }

    function localControl() { return window.EveOSLocalControl || null; }

    async function request(path, options, timeoutMs) {
        const control = localControl();
        if (!control) throw new Error('EveOS Local Control is not loaded yet.');
        return control.fetchJson(control.baseUrl() + path, options, timeoutMs || 6000);
    }

    function requestErrorMessage(error, fallback) {
        const message = String(error?.message || '').trim();
        if (!message || /failed to fetch|network|abort/i.test(message)) {
            const control = window.EveOSControlPlane?.getState?.() || {};
            if (control.controllerAvailable) {
                return 'Local Control is online, but Local MoE status is temporarily unreachable. Search Monitor will retry automatically.';
            }
            return fallback || 'Local Control is offline. Start it from the localhost control above, then refresh.';
        }
        return message;
    }

    function setText(selector, value) {
        const node = boundRoot?.querySelector(selector);
        if (node) node.textContent = value;
    }

    function setProviderMessage(provider, message) {
        if (!boundRoot || !message) return;
        if (provider === 'gemini') setText('[data-gemini-provider-message]', message);
        if (provider === 'local-moe') setText('[data-local-moe-message]', message);
        if (provider === 'nexus-browser') setText('[data-nexus-browser-message]', message);
    }

    function syncReloadButtons() {
        boundRoot?.querySelectorAll('[data-provider-reload]').forEach((button) => {
            const ownProvider = button.dataset.providerReload;
            button.disabled = !!providerReloadBusy;
            button.textContent = providerReloadBusy === ownProvider
                ? 'Reloading…'
                : ownProvider === 'gemini'
                    ? 'Reload Gemini server'
                    : ownProvider === 'local-moe'
                        ? 'Reload Local MoE'
                        : 'Reload Nexus Browser';
        });
    }

    function syncGeminiGate() {
        const loadButton = boundRoot?.querySelector('[data-gemini-monitor-load]');
        const runtime = boundRoot?.querySelector('[data-gemini-runtime-shell]');
        if (loadButton) loadButton.hidden = geminiWorkspaceLoaded;
        if (runtime) runtime.hidden = !geminiWorkspaceLoaded;
    }

    function loadGeminiWorkspace() {
        geminiWorkspaceLoaded = true;
        syncGeminiGate();
        setProviderMessage('gemini', 'Gemini workspace loaded on demand.');
        if (workspaceActive) onGeminiOpen?.();
    }

    async function setKeepLocalControlAfterToolStop(enabled) {
        return request('/api/control-plane/consoles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keepLocalControlAfterToolStop: !!enabled })
        }, 7000);
    }

    async function restartProvider(provider) {
        const spec = PROVIDER_RELOADS[provider];
        if (!spec || providerReloadBusy) return null;
        providerReloadBusy = provider;
        syncReloadButtons();
        setProviderMessage(provider, `Checking ${spec.label} before reload…`);
        let restoreKeepAlive = false;
        try {
            if (window.EveOSControlPlane?.ensureController) {
                const ready = await window.EveOSControlPlane.ensureController();
                if (!ready) throw new Error('EveOS Local Control is unavailable.');
            }
            const current = await request(spec.status, null, 8000);
            if (current?.running !== true) {
                setProviderMessage(provider, `${spec.label} is stopped, so there is nothing to reload.`);
                return current;
            }
            const preferences = await request('/api/control-plane/consoles', null, 8000);
            restoreKeepAlive = preferences?.keepLocalControlAfterToolStop === false;
            if (restoreKeepAlive) await setKeepLocalControlAfterToolStop(true);
            setProviderMessage(provider, `Reloading ${spec.label} without stopping the rest of EveOS…`);
            await request(spec.stop, { method: 'POST' }, 40000);
            const restarted = await request(spec.start, { method: 'POST' }, provider === 'local-moe' ? 30000 : 20000);
            setProviderMessage(provider, `${spec.label} reloaded. Other EveOS services stayed running.`);
            if (provider === 'local-moe') await refreshLocalMoe();
            if (provider === 'nexus-browser') await window.EveOSNexusBrowser?.activate?.();
            return restarted;
        } catch (error) {
            setProviderMessage(provider, error?.message || `${spec.label} reload failed.`);
            return null;
        } finally {
            if (restoreKeepAlive) {
                try { await setKeepLocalControlAfterToolStop(false); } catch {}
            }
            providerReloadBusy = '';
            syncReloadButtons();
        }
    }

    function gpuLabel(status) {
        const gpu = status?.gpuCoexistence?.gpu || status?.system?.gpu || {};
        const utilization = gpu.util_pct ?? gpu.utilization_pct ?? gpu.utilization ?? gpu.utilizationPercent;
        const used = gpu.memory_used_mb ?? gpu.memoryUsedMb;
        const total = gpu.memory_total_mb ?? gpu.memoryTotalMb;
        if (Number.isFinite(Number(utilization))) return `${Math.round(Number(utilization))}% util`;
        if (Number.isFinite(Number(used)) && Number.isFinite(Number(total))) return `${Math.round(Number(used))}/${Math.round(Number(total))} MB`;
        return status?.running ? 'Telemetry ready' : 'Standby';
    }

    function runtimeStateLabel(status) {
        if (!status?.running) return 'Harness stopped';
        if (status.runtimeReady === true) return 'Ready';
        const stage = String(status.runtimeStartupStage || '').trim().toLowerCase();
        if (status.runtimeManagedRunning === true || ['starting', 'loading_weights', 'checking_identity'].includes(stage)) {
            if (stage === 'checking_identity') return 'Loading · identity check';
            return 'Loading model';
        }
        if (status.runtimeLastError) return 'Needs attention';
        if (status.runtimeReachable === true) return 'Reachable · not ready';
        return 'Stopped';
    }

    function syncLocalMoeInline(status) {
        const provider = boundRoot?.querySelector('[data-ai-provider="local-moe"]');
        const host = boundRoot?.querySelector('[data-local-moe-inline]');
        const frame = boundRoot?.querySelector('[data-local-moe-frame]');
        if (!provider || !host || !frame) return;
        const running = status?.running === true;
        const resynchronizing = !running && status?.state === 'starting' && !!frame.dataset.localMoeUrl;
        const shouldShow = (running || resynchronizing) && provider.open === true && !!status.url;
        host.hidden = !shouldShow;
        if (!running && !resynchronizing) {
            frame.removeAttribute('src');
            delete frame.dataset.localMoeUrl;
            return;
        }
        if (shouldShow && frame.dataset.localMoeUrl !== status.url) {
            const separator = status.url.includes('?') ? '&' : '?';
            frame.src = `${status.url}${separator}eveos_embed=${LOCAL_MOE_EMBED_VERSION}`;
            frame.dataset.localMoeUrl = status.url;
        }
    }

    function renderLocalMoe(status, overrideMessage) {
        if (!boundRoot || !status) return;
        lastLocalMoeStatus = status;
        const running = status.running === true;
        const starting = status.state === 'starting';
        const blocked = status.state === 'blocked' || status.state === 'external';
        const stateLabel = running ? 'Online' : starting ? 'Starting' : blocked ? 'Blocked' : 'Stopped';
        setText('[data-local-moe-state]', stateLabel);
        setText('[data-local-moe-summary]', status.message || 'Generic local inference core');
        setText('[data-local-moe-harness]', running ? 'Online' : status.state || 'Stopped');
        setText('[data-local-moe-runtime]', runtimeStateLabel(status));
        setText('[data-local-moe-model]', status.activeModel?.label || status.activeModel?.id || 'Configured model');
        setText('[data-local-moe-profile]', status.activeProfile || '—');
        setText('[data-local-moe-ports]', `${status.port || 5180} · ${status.runtimePort || 1919}`);
        setText('[data-local-moe-gpu]', gpuLabel(status));
        setText('[data-local-moe-message]', overrideMessage || status.runtimeLastError || status.message || 'Status available.');
        syncLocalMoeInline(status);
        const primary = boundRoot.querySelector('[data-local-moe-primary]');
        if (primary) {
            const modelCanStart = running && status.runtimeReady !== true && status.runtimeManagedRunning !== true && status.runtimeReachable !== true;
            const shouldStop = starting || (running && !modelCanStart);
            primary.dataset.localMoeAction = shouldStop ? 'stop' : 'start';
            primary.textContent = localMoeBusy ? 'Working…' : modelCanStart
                ? (status.runtimeLastError ? 'Retry model' : 'Start model') : shouldStop ? 'Stop' : 'Start';
            primary.disabled = localMoeBusy || blocked || (!running && status.setupReady === false);
        }
        const setup = boundRoot.querySelector('[data-local-moe-action="setup"]');
        if (setup) { setup.hidden = status.setupReady === true; setup.disabled = localMoeBusy; }
        boundRoot.querySelectorAll('[data-local-moe-action="refresh"]').forEach((button) => { button.disabled = localMoeBusy; });
    }

    function refreshLocalMoe() {
        if (!boundRoot || localMoeBusy) return Promise.resolve(lastLocalMoeStatus);
        if (localMoeRefreshPromise) return localMoeRefreshPromise;
        const generation = ++localMoeRefreshGeneration;
        setText('[data-local-moe-message]', 'Checking Local MoE infrastructure…');
        localMoeRefreshPromise = (async function () {
            try {
                const status = await request(STATUS_PATH, null, 7000);
                if (generation !== localMoeRefreshGeneration) return lastLocalMoeStatus;
                localMoeLoaded = true;
                renderLocalMoe(status);
                return status;
            } catch (error) {
                if (generation !== localMoeRefreshGeneration) return lastLocalMoeStatus;
                const fallback = lastLocalMoeStatus || { running: false, state: 'unavailable', setupReady: true, port: 5180, runtimePort: 1919 };
                renderLocalMoe(fallback, requestErrorMessage(error));
                return null;
            } finally { localMoeRefreshPromise = null; }
        })();
        return localMoeRefreshPromise;
    }

    async function invokeLocalMoe(action) {
        if (!ACTION_PATHS[action] || localMoeBusy) return null;
        localMoeBusy = true;
        localMoeRefreshGeneration += 1;
        let finalMessage = '';
        const startingModelOnly = action === 'start' && lastLocalMoeStatus?.running === true;
        renderLocalMoe(lastLocalMoeStatus || { running: false, state: 'stopped', setupReady: true, port: 5180, runtimePort: 1919 },
            `${action === 'setup' ? 'Opening setup' : action === 'start' ? (startingModelOnly ? 'Starting selected model' : 'Starting Local MoE') : 'Stopping'}…`);
        try {
            const status = await request(ACTION_PATHS[action], { method: 'POST' }, action === 'stop' ? 35000 : action === 'start' ? 18000 : 9000);
            renderLocalMoe(status);
            return status;
        } catch (error) {
            finalMessage = requestErrorMessage(error, `Local MoE ${action} failed because Local Control is offline.`);
            return null;
        } finally {
            localMoeBusy = false;
            renderLocalMoe(lastLocalMoeStatus || { running: false, state: 'unavailable', setupReady: true, port: 5180, runtimePort: 1919 }, finalMessage);
        }
    }

    function handleAction(event) {
        const reloadButton = event.target.closest('[data-provider-reload]');
        if (reloadButton) {
            event.preventDefault();
            event.stopPropagation();
            restartProvider(reloadButton.dataset.providerReload);
            return;
        }
        const reloadUi = event.target.closest('[data-search-monitor-reload-ui]');
        if (reloadUi) { event.preventDefault(); window.location.reload(); return; }
        const geminiLoad = event.target.closest('[data-gemini-monitor-load]');
        if (geminiLoad) { event.preventDefault(); loadGeminiWorkspace(); return; }
        const button = event.target.closest('[data-local-moe-action]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        const action = button.dataset.localMoeAction;
        if (action === 'refresh') refreshLocalMoe();
        else invokeLocalMoe(action);
    }

    function activeAgentNexusView(agents) {
        const panel = agents?.querySelector?.('[data-agent-nexus-panel]:not([hidden])');
        return panel?.dataset?.agentNexusPanel || '';
    }

    function refreshOpenAgentNexus(activate) {
        const agents = boundRoot?.querySelector('[data-ai-provider="agents"]');
        if (!agents?.open) return;
        const view = activeAgentNexusView(agents);
        if (view === 'tlo') {
            if (activate) window.EveOSTloChat?.activate?.();
            else window.EveOSTloChat?.refreshStatus?.();
        } else if (view === 'nexus-browser') {
            if (activate) window.EveOSNexusBrowser?.activate?.();
            else window.EveOSNexusBrowser?.refresh?.();
        }
    }

    function handleControlHeartbeat() {
        if (!workspaceActive || !boundRoot) return;
        const localMoe = boundRoot.querySelector('[data-ai-provider="local-moe"]');
        if (localMoe?.open) refreshLocalMoe();
        refreshOpenAgentNexus(false);
    }

    function bind(container, options) {
        boundRoot = container;
        onGeminiOpen = options?.onGeminiOpen || null;
        window.EveOSAgentNexus?.bind?.(container);
        if (!controlHeartbeatBound) {
            controlHeartbeatBound = true;
            window.addEventListener('eve:eveos-control-plane-status', handleControlHeartbeat);
        }
        const gemini = container.querySelector('[data-ai-provider="gemini"]');
        const localMoe = container.querySelector('[data-ai-provider="local-moe"]');
        const agents = container.querySelector('[data-ai-provider="agents"]');
        gemini?.addEventListener('toggle', function () {
            syncGeminiGate();
            if (gemini.open && geminiWorkspaceLoaded && workspaceActive) onGeminiOpen?.();
        });
        localMoe?.addEventListener('toggle', function () {
            if (localMoe.open) refreshLocalMoe();
            else if (lastLocalMoeStatus) syncLocalMoeInline(lastLocalMoeStatus);
        });
        agents?.addEventListener('toggle', function () { if (agents.open) refreshOpenAgentNexus(true); });
        container.addEventListener('click', handleAction);
        syncGeminiGate();
        syncReloadButtons();
    }

    function setWorkspaceActive(active) {
        workspaceActive = !!active;
        const localMoe = boundRoot?.querySelector('[data-ai-provider="local-moe"]');
        if (active && localMoe?.open) refreshLocalMoe();
        const gemini = boundRoot?.querySelector('[data-ai-provider="gemini"]');
        if (active && gemini?.open && geminiWorkspaceLoaded) onGeminiOpen?.();
        if (active) refreshOpenAgentNexus(true);
        return !!(active && gemini?.open && geminiWorkspaceLoaded);
    }

    function isGeminiOpen() {
        return !!(geminiWorkspaceLoaded && boundRoot?.querySelector('[data-ai-provider="gemini"]')?.open);
    }

    window.EveOSSearchMonitorAiHome = Object.freeze({
        markup, bind, setWorkspaceActive, isGeminiOpen, refreshLocalMoe, restartProvider
    });
})();
