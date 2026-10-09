/* Search Monitor AI Home provider-shell markup. */
(function () {
    'use strict';
    if (window.EveOSSearchMonitorAiHomeMarkup) return;

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

    window.EveOSSearchMonitorAiHomeMarkup = Object.freeze({ markup });
})();
