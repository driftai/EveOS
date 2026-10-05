/* Search Monitor AI Home: provider shells and the generic Local MoE lifecycle surface. */
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
        gemini: Object.freeze({
            label: 'Gemini Link',
            status: '/api/gemini-server/status',
            stop: '/api/gemini-server/stop',
            start: '/api/gemini-server/start'
        }),
        'local-moe': Object.freeze({
            label: 'Local MoE',
            status: '/api/local-moe/status',
            stop: '/api/local-moe/stop',
            start: '/api/local-moe/start'
        }),
        'nexus-browser': Object.freeze({
            label: 'Nexus Browser',
            status: '/api/nexus-browser/status',
            stop: '/api/nexus-browser/stop',
            start: '/api/nexus-browser/start'
        })
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
        const agentNexusMarkup = window.EveOSAgentNexus?.markup?.()
            || '<p class="eveos-ai-provider-message">Agent Nexus module is unavailable.</p>';
        return `
            <div class="gemini-monitor-shell-toolbar">
                <div class="gemini-monitor-shell-copy">
                    <div class="gemini-monitor-shell-kicker">EveOS AI Home</div>
                    <div class="gemini-monitor-shell-title">Search Monitor Assistant</div>
                </div>
                <div class="gemini-monitor-toolbar-actions">
                    <div class="gemini-server-control" data-eveos-control-plane data-state="checking">
                        <span class="gemini-server-state" data-eveos-control-status>Checking</span>
                        <button type="button" class="gemini-server-toggle" data-eveos-control-toggle disabled>
                            <i class="material-icons" aria-hidden="true">sync</i>
                            <span data-eveos-control-action-label>Start</span>
                        </button>
                    </div>
                    <button type="button" class="gemini-server-inspector-toggle eveos-control-open" data-eveos-control-open title="Open EveOS localhost" aria-label="Open EveOS localhost" hidden>
                        <i class="material-icons" aria-hidden="true">open_in_new</i>
                    </button>
                    <button type="button" class="gemini-server-inspector-toggle" data-search-monitor-reload-ui title="Reload Search Monitor UI after a code pull" aria-label="Reload Search Monitor UI">
                        <i class="material-icons" aria-hidden="true">refresh</i>
                    </button>
                    <button type="button" class="gemini-server-inspector-toggle" data-gemini-server-inspector-toggle title="Open EveOS runtime monitor" aria-label="Open EveOS runtime monitor">
                        <i class="material-icons" aria-hidden="true">dns</i>
                    </button>
                    <div class="gemini-monitor-view-switch" role="group" aria-label="Search Monitor view">
                        <button type="button" class="gemini-monitor-view-btn" data-gemini-monitor-view-btn="summary">Compact</button>
                        <button type="button" class="gemini-monitor-view-btn" data-gemini-monitor-view-btn="full">Workspace</button>
                    </div>
                </div>
            </div>
            <div id="search-monitor-assistant-pane" class="gemini-monitor-summary-pane">
                <div class="gemini-monitor-card">
                    <div class="gemini-monitor-head">
                        <div>
                            <div class="gemini-monitor-kicker">Search Monitor</div>
                            <h3 class="gemini-monitor-title">Assistant standby</h3>
                        </div>
                        <div class="gemini-monitor-pill">Compact</div>
                    </div>
                    <div class="gemini-monitor-body">
                        <div class="gemini-monitor-status-row">
                            <span class="gemini-monitor-status-dot" aria-hidden="true"></span>
                            <span class="gemini-monitor-status-text">Ready for context relay, prompt assistance, and provider control.</span>
                        </div>
                        <p class="gemini-monitor-copy">Switch to Workspace to manage Gemini Link, the local inference core, and future EveOS agents independently.</p>
                    </div>
                </div>
            </div>
            <div class="gemini-monitor-workspace-shell" data-ai-home-workspace>
                <div class="gemini-monitor-workspace-head">
                    <div>
                        <div class="gemini-monitor-workspace-kicker">Provider workspace</div>
                        <div class="gemini-monitor-workspace-title">AI infrastructure</div>
                    </div>
                    <div class="gemini-monitor-workspace-pill">Explicit start</div>
                </div>
                <p class="gemini-monitor-workspace-note">Providers stay isolated and collapsed until you open them. Viewing this workspace never starts a model.</p>

                <details class="eveos-ai-provider" data-ai-provider="gemini">
                    <summary class="eveos-ai-provider-summary">
                        <span class="eveos-ai-provider-icon eveos-ai-provider-icon--gemini">G</span>
                        <span class="eveos-ai-provider-heading">
                            <strong>Gemini Link</strong>
                            <small>Cloud live voice, context relay, and agentic controls</small>
                        </span>
                        <span class="eveos-ai-provider-pill">On demand</span>
                        <i class="material-icons eveos-ai-provider-chevron" aria-hidden="true">expand_more</i>
                    </summary>
                    <div class="eveos-ai-provider-body">
                        <div class="gemini-monitor-card eveos-ai-provider-intro">
                            <div class="gemini-monitor-status-row">
                                <span class="gemini-monitor-status-dot" aria-hidden="true"></span>
                                <span class="gemini-monitor-status-text" data-gemini-provider-message>Gemini stays parked until you explicitly load its workspace.</span>
                            </div>
                            <div class="eveos-ai-provider-controls" data-gemini-monitor-idle>
                                <button type="button" data-gemini-monitor-load>Load the Gemini workspace</button>
                                <button type="button" data-provider-reload="gemini">Reload Gemini server</button>
                            </div>
                            <details class="gemini-api-setup-guide">
                                <summary><span>Gemini API setup guide</span><small>Gemini Link + Sonic Forge</small></summary>
                                <div class="gemini-api-setup-guide-body">
                                    <ol>
                                        <li>Create a Gemini API key in <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio</a>.</li>
                                        <li>Open Session Controls in this section, paste the key, and save it.</li>
                                        <li>Start Gemini Link. Sonic Forge reuses the same saved credential.</li>
                                    </ol>
                                    <p class="gemini-api-security-note">Treat the key like a password. Never place it in prompts, screenshots, exports, source files, or commits.</p>
                                    <a class="gemini-api-docs-link" href="https://ai.google.dev/gemini-api/docs/api-key" target="_blank" rel="noopener noreferrer">Read Google’s API-key guide</a>
                                </div>
                            </details>
                        </div>
                        <div id="gemini-provider-runtime-host" class="eveos-ai-provider-runtime" data-gemini-runtime-shell hidden></div>
                    </div>
                </details>

                <details class="eveos-ai-provider" data-ai-provider="local-moe">
                    <summary class="eveos-ai-provider-summary">
                        <span class="eveos-ai-provider-icon eveos-ai-provider-icon--local">M</span>
                        <span class="eveos-ai-provider-heading">
                            <strong>Local MoE Harness</strong>
                            <small data-local-moe-summary>Generic local inference core · checking when opened</small>
                        </span>
                        <span class="eveos-ai-provider-pill" data-local-moe-state>Stopped</span>
                        <button type="button" class="eveos-ai-provider-action" data-local-moe-primary data-local-moe-action="start">Start</button>
                        <i class="material-icons eveos-ai-provider-chevron" aria-hidden="true">expand_more</i>
                    </summary>
                    <div class="eveos-ai-provider-body">
                        <div class="eveos-ai-status-grid">
                            <div><span>Harness</span><strong data-local-moe-harness>Stopped</strong></div>
                            <div><span>Model runtime</span><strong data-local-moe-runtime>Stopped</strong></div>
                            <div><span>Model</span><strong data-local-moe-model>Configured model</strong></div>
                            <div><span>Profile</span><strong data-local-moe-profile>—</strong></div>
                            <div><span>Ports</span><strong data-local-moe-ports>5180 · 1919</strong></div>
                            <div><span>GPU</span><strong data-local-moe-gpu>Standby</strong></div>
                        </div>
                        <p class="eveos-ai-provider-message" data-local-moe-message>Open this section to check the local inference core. Nothing starts automatically.</p>
                        <div class="eveos-ai-provider-controls">
                            <button type="button" data-local-moe-action="setup">Setup runtime</button>
                            <button type="button" data-local-moe-action="refresh">Refresh</button>
                            <button type="button" data-provider-reload="local-moe">Reload Local MoE</button>
                        </div>
                        <section class="eveos-local-moe-inline" data-local-moe-inline hidden aria-label="Local MoE models and chat">
                            <div class="eveos-local-moe-inline-head">
                                <span><strong>Models & chat</strong><small>Local Harness workspace</small></span>
                                <span class="eveos-ai-provider-pill">Inline</span>
                            </div>
                            <iframe data-local-moe-frame title="Local MoE models and chat"
                                sandbox="allow-forms allow-scripts allow-same-origin"
                                allow="clipboard-read; clipboard-write" referrerpolicy="no-referrer"></iframe>
                        </section>
                    </div>
                </details>

                <details class="eveos-ai-provider" data-ai-provider="agents">
                    <summary class="eveos-ai-provider-summary">
                        <span class="eveos-ai-provider-icon eveos-ai-provider-icon--agent">A</span>
                        <span class="eveos-ai-provider-heading">
                            <strong>Agent Nexus</strong>
                            <small>TLO, Nexus Browser, and private local agent profiles</small>
                        </span>
                        <span class="eveos-ai-provider-pill">TLO chat</span>
                        <i class="material-icons eveos-ai-provider-chevron" aria-hidden="true">expand_more</i>
                    </summary>
                    <div class="eveos-ai-provider-body">
                        <div class="eveos-ai-provider-controls">
                            <button type="button" data-provider-reload="nexus-browser">Reload Nexus Browser</button>
                        </div>
                        ${agentNexusMarkup}
                    </div>
                </details>
            </div>
        `;
    }

    function localControl() {
        return window.EveOSLocalControl || null;
    }

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
        const idle = boundRoot?.querySelector('[data-gemini-monitor-idle]');
        const runtime = boundRoot?.querySelector('[data-gemini-runtime-shell]');
        if (idle) idle.hidden = geminiWorkspaceLoaded;
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
        if (Number.isFinite(Number(used)) && Number.isFinite(Number(total))) {
            return `${Math.round(Number(used))}/${Math.round(Number(total))} MB`;
        }
        return status?.running ? 'Telemetry ready' : 'Standby';
    }

    function runtimeStateLabel(status) {
        if (!status?.running) return 'Harness stopped';
        if (status.runtimeReady === true) return 'Ready';

        const stage = String(status.runtimeStartupStage || '').trim().toLowerCase();
        if (status.runtimeManagedRunning === true
            || ['starting', 'loading_weights', 'checking_identity'].includes(stage)) {
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
        const resynchronizing = !running && status?.state === 'starting'
            && !!frame.dataset.localMoeUrl;
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
        setText('[data-local-moe-message]',
            overrideMessage || status.runtimeLastError || status.message || 'Status available.');
        syncLocalMoeInline(status);

        const primary = boundRoot.querySelector('[data-local-moe-primary]');
        if (primary) {
            const modelCanStart = running
                && status.runtimeReady !== true
                && status.runtimeManagedRunning !== true
                && status.runtimeReachable !== true;
            const shouldStop = starting
                || (running && !modelCanStart);
            primary.dataset.localMoeAction = shouldStop ? 'stop' : 'start';
            primary.textContent = localMoeBusy
                ? 'Working…'
                : modelCanStart
                    ? (status.runtimeLastError ? 'Retry model' : 'Start model')
                    : shouldStop ? 'Stop' : 'Start';
            primary.disabled = localMoeBusy || blocked || (!running && status.setupReady === false);
        }
        const setup = boundRoot.querySelector('[data-local-moe-action="setup"]');
        if (setup) {
            setup.hidden = status.setupReady === true;
            setup.disabled = localMoeBusy;
        }
        boundRoot.querySelectorAll('[data-local-moe-action="refresh"]').forEach((button) => {
            button.disabled = localMoeBusy;
        });
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
                const fallback = lastLocalMoeStatus || {
                    running: false, state: 'unavailable', setupReady: true, port: 5180, runtimePort: 1919
                };
                renderLocalMoe(fallback, requestErrorMessage(error));
                return null;
            } finally {
                localMoeRefreshPromise = null;
            }
        })();
        return localMoeRefreshPromise;
    }

    async function invokeLocalMoe(action) {
        if (!ACTION_PATHS[action] || localMoeBusy) return null;
        localMoeBusy = true;
        localMoeRefreshGeneration += 1;
        let finalMessage = '';
        const startingModelOnly = action === 'start' && lastLocalMoeStatus?.running === true;
        renderLocalMoe(lastLocalMoeStatus || {
            running: false, state: 'stopped', setupReady: true, port: 5180, runtimePort: 1919
        }, `${action === 'setup'
            ? 'Opening setup'
            : action === 'start'
                ? (startingModelOnly ? 'Starting selected model' : 'Starting Local MoE')
                : 'Stopping'}…`);
        try {
            const status = await request(
                ACTION_PATHS[action],
                { method: 'POST' },
                action === 'stop' ? 35000 : action === 'start' ? 18000 : 9000
            );
            renderLocalMoe(status);
            return status;
        } catch (error) {
            finalMessage = requestErrorMessage(error, `Local MoE ${action} failed because Local Control is offline.`);
            return null;
        } finally {
            localMoeBusy = false;
            renderLocalMoe(lastLocalMoeStatus || {
                running: false, state: 'unavailable', setupReady: true, port: 5180, runtimePort: 1919
            }, finalMessage);
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
        if (reloadUi) {
            event.preventDefault();
            window.location.reload();
            return;
        }
        const geminiLoad = event.target.closest('[data-gemini-monitor-load]');
        if (geminiLoad) {
            event.preventDefault();
            loadGeminiWorkspace();
            return;
        }
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
        agents?.addEventListener('toggle', function () {
            if (agents.open) refreshOpenAgentNexus(true);
        });
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
        markup,
        bind,
        setWorkspaceActive,
        isGeminiOpen,
        refreshLocalMoe,
        restartProvider
    });
})();
