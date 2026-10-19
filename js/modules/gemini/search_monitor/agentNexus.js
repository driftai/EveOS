/* Agent Nexus: peer surfaces and local Agent Management UI. */
(function () {
    'use strict';

    if (window.EveOSAgentNexus) return;

    const API_PATH = '/api/eve-state/modular/agent-management';
    const boundRoots = new WeakSet();
    let root = null;
    let store = null;
    let selectedAgentId = 'tlo';
    let busy = false;
    let tloDefinition = null;
    let importBundle = null;
    const draftAgentIds = new Set();

    function markup() {
        const tloMarkup = window.EveOSTloChat?.markup?.()
            || '<p class="eveos-ai-provider-message">TLO Chat module is unavailable.</p>';
        const nexusBrowserMarkup = window.EveOSNexusBrowser?.markup?.()
            || '<p class="eveos-ai-provider-message">Nexus Browser module is unavailable.</p>';
        return `
            <div class="eveos-agent-nexus-intro">
                <strong>Two peers, separate responsibilities</strong>
                <span>TLO is a Local MoE-backed agent. Nexus Browser provides Headed / observable provider work with a Headless local-control option.</span>
            </div>
            <div class="eveos-agent-nexus-nav" role="tablist" aria-label="Agent Nexus surfaces">
                <button type="button" class="is-active" data-agent-nexus-view="tlo" role="tab" aria-selected="true">TLO</button>
                <button type="button" data-agent-nexus-view="nexus-browser" role="tab" aria-selected="false">Nexus Browser</button>
                <button type="button" data-agent-nexus-view="management" role="tab" aria-selected="false">Agent Management</button>
            </div>
            <section class="eveos-agent-nexus-panel" data-agent-nexus-panel="tlo">
                ${tloMarkup}
            </section>
            <section class="eveos-agent-nexus-panel" data-agent-nexus-panel="nexus-browser" hidden>
                ${nexusBrowserMarkup}
            </section>
            <section class="eveos-agent-nexus-panel" data-agent-nexus-panel="management" hidden>
                <div class="eveos-agent-management-head">
                    <span><strong>Agent Management</strong><small>Private profiles persist only on this machine.</small></span>
                    <button type="button" data-agent-management-action="new">New agent</button>
                </div>
                <p class="eveos-agent-management-status" data-agent-management-status>Open this view to load local agent profiles.</p>
                ${window.EveOSAgentDocuments?.secureBanner?.() || ''}
                <div class="eveos-agent-tabs" data-agent-management-tabs role="tablist" aria-label="Local agents"></div>
                <form class="eveos-agent-form" data-agent-management-form hidden>
                    <label>Agent ID<input name="id" maxlength="64" pattern="[a-z0-9][a-z0-9._-]{0,63}" required></label>
                    <label>Display name<input name="displayName" maxlength="100" required></label>
                    <label class="is-wide">Role<input name="role" maxlength="240"></label>
                    <label class="is-wide" data-agent-json-identity>Identity<textarea name="identity" rows="4" maxlength="16000"></textarea></label>
                    <label class="is-wide" data-agent-tlo-definition hidden>TLO AGENT.md <small>Private local override; used for new TLO turns.</small><textarea name="tloDefinition" rows="12" maxlength="16000"></textarea><button type="button" data-agent-management-action="save-definition">Save TLO definition</button><small data-agent-tlo-source></small><small data-agent-tlo-path></small></label>
                    <details class="is-wide eveos-agent-origin" data-agent-tlo-origin-panel hidden><summary>Origin / Creation Context (reference only)</summary><pre data-agent-tlo-origin></pre></details>
                    <label>Provider<select name="provider"><option value="local-moe">Local MoE</option><option value="unassigned">Unassigned</option></select></label>
                    <label>Model ID<input name="modelId" maxlength="160" placeholder="Use Harness selection"></label>
                    <label class="is-wide" data-agent-json-rules>Working rules <small>One per line</small><textarea name="workingRules" rows="4"></textarea></label>
                    <label class="is-wide">Allowed tools <small>One per line</small><textarea name="allowedTools" rows="3"></textarea></label>
                    <label class="is-wide">Default scope instructions<textarea name="scopeInstructions" rows="4"></textarea></label>
                    <label class="is-wide">Private notes <small>Never included in browser projections</small><textarea name="privateNotes" rows="3"></textarea></label>
                    <div class="eveos-agent-form-actions is-wide">
                        <button type="submit" data-agent-management-action="save">Save locally</button>
                        <span>Schema v1 · atomic local persistence</span>
                    </div>
                </form>
                ${window.EveOSAgentDocuments?.markup?.() || ''}
                <div class="eveos-agent-management-head">
                    <span><strong>Private Agent Nexus transfer</strong><small>Stop Nexus Browser first. Exports include room messages; review the downloaded file before sharing.</small></span>
                </div>
                <div class="eveos-agent-form-actions">
                    <button type="button" data-agent-management-action="export">Export agents + rooms</button>
                    <label>Import JSON<input type="file" accept=".json,application/json" data-agent-portable-file></label>
                    <button type="button" data-agent-management-action="preview">Preview import</button>
                    <button type="button" data-agent-management-action="apply" hidden>Apply reviewed import</button>
                </div>
                <p class="eveos-agent-management-status" data-agent-portable-status>Import adds only new IDs; conflicts block the entire apply. Live bindings and private notes are excluded.</p>
            </section>
        `;
    }

    function setStatus(message, state) {
        const node = root?.querySelector('[data-agent-management-status]');
        if (!node) return;
        node.textContent = message;
        node.dataset.state = state || 'idle';
    }

    function setPortableStatus(message, state) {
        const node = root?.querySelector('[data-agent-portable-status]');
        if (!node) return;
        node.textContent = message;
        node.dataset.state = state || 'idle';
    }

    function candidateBases() {
        const networkBases = window.GeminiServerNetwork?.localCandidateBases?.() || [];
        const registryBase = window.EveOSPortRegistry?.url?.('EVEOS_WEB_PORT');
        const current = /^https?:$/.test(window.location?.protocol || '') ? window.location.origin : '';
        return Array.from(new Set([current, registryBase, 'http://127.0.0.1:8765', ...networkBases].filter(Boolean)));
    }

    async function request(path, options) {
        let lastError = null;
        for (const base of candidateBases()) {
            const controller = new AbortController();
            const timer = window.setTimeout(() => controller.abort(), 5000);
            try {
                const response = await fetch(`${base}${path}`, {
                    cache: 'no-store',
                    headers: { 'Content-Type': 'application/json' },
                    ...options,
                    signal: controller.signal
                });
                const payload = await response.json().catch(() => ({}));
                if (response.status === 404) {
                    lastError = new Error('Agent Management endpoint not found.');
                    continue;
                }
                if (!response.ok || payload.ok !== true) {
                    throw new Error(payload.error || `Agent Management request failed (${response.status}).`);
                }
                return payload;
            } catch (error) {
                lastError = error;
                if (!/fetch|network|abort|not found/i.test(String(error?.message || ''))) throw error;
            } finally {
                window.clearTimeout(timer);
            }
        }
        throw lastError || new Error('EveOS localhost is unavailable.');
    }

    function splitLines(value) {
        return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    }

    function selectedAgent() {
        return store?.agents?.find((agent) => agent.id === selectedAgentId) || null;
    }

    function renderTabs() {
        const host = root?.querySelector('[data-agent-management-tabs]');
        if (!host) return;
        host.replaceChildren();
        for (const agent of store?.agents || []) {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.agentManagementAgent = agent.id;
            button.textContent = agent.displayName;
            button.classList.toggle('is-active', agent.id === selectedAgentId);
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-selected', String(agent.id === selectedAgentId));
            host.appendChild(button);
        }
    }

    function writeField(form, name, value) {
        const field = form?.elements?.namedItem(name);
        if (field) field.value = value || '';
    }

    function renderForm() {
        const form = root?.querySelector('[data-agent-management-form]');
        const agent = selectedAgent();
        if (!form || !agent) return;
        const scope = agent.scopes?.find((item) => item.id === 'default') || agent.scopes?.[0] || {};
        form.hidden = false;
        writeField(form, 'id', agent.id);
        form.elements.namedItem('id').readOnly = !draftAgentIds.has(agent.id);
        writeField(form, 'displayName', agent.displayName);
        writeField(form, 'role', agent.role);
        writeField(form, 'identity', agent.identity);
        writeField(form, 'provider', agent.providerBinding?.provider || 'unassigned');
        writeField(form, 'modelId', agent.providerBinding?.modelId);
        writeField(form, 'workingRules', (agent.workingRules || []).join('\n'));
        writeField(form, 'allowedTools', (agent.allowedTools || []).join('\n'));
        writeField(form, 'scopeInstructions', scope.instructions);
        writeField(form, 'privateNotes', (agent.privateNotes || []).join('\n'));
        const isTlo = agent.id === 'tlo';
        form.querySelector('[data-agent-json-identity]').hidden = isTlo;
        form.querySelector('[data-agent-json-rules]').hidden = isTlo;
        form.querySelector('[data-agent-tlo-definition]').hidden = !isTlo;
        form.querySelector('[data-agent-tlo-origin-panel]').hidden = !isTlo;
        if (isTlo) {
            writeField(form, 'tloDefinition', tloDefinition?.text || '');
            form.querySelector('[data-agent-tlo-path]').textContent = tloDefinition?.path || '';
            form.querySelector('[data-agent-tlo-origin]').textContent = tloDefinition?.origin || '';
            form.querySelector('[data-agent-tlo-source]').textContent = tloDefinition?.source === 'private-file'
                ? 'Active private AGENT.md' : tloDefinition?.source === 'legacy-profile'
                    ? 'Existing profile text — save to create private AGENT.md' : 'Starter AGENT.md — save to customize privately';
        }
    }

    function renderManagement() {
        renderTabs();
        renderForm();
    }

    async function loadManagement(force) {
        if ((store && !force) || busy) return;
        busy = true;
        setStatus('Loading private local profiles…', 'busy');
        try {
            const payload = await request(API_PATH);
            store = payload.store;
            const definition = await request(`${API_PATH}/definition`);
            tloDefinition = definition.definition;
            if (!store.agents.some((agent) => agent.id === selectedAgentId)) {
                selectedAgentId = store.agents[0]?.id || '';
            }
            renderManagement();
            setStatus(payload.persisted
                ? `${store.agents.length} local agent profile${store.agents.length === 1 ? '' : 's'} loaded.`
                : 'Using the safe TLO template. Save to create the local Agent Management store.', 'ok');
        } catch (error) {
            setStatus(error?.message || 'Agent Management is unavailable.', 'error');
        } finally {
            busy = false;
        }
    }

    function createDraft() {
        if (!store) store = { schema: 'eveos.agent-management', schemaVersion: 1, agents: [] };
        let suffix = store.agents.length + 1;
        while (store.agents.some((agent) => agent.id === `agent-${suffix}`)) suffix += 1;
        const agent = {
            id: `agent-${suffix}`,
            displayName: `Agent ${suffix}`,
            role: '', identity: '', workingRules: [], allowedTools: [], permissions: [], privateNotes: [],
            providerBinding: { provider: 'unassigned', modelId: '', profile: '' },
            scopes: [{ id: 'default', label: 'Default', instructions: '', context: [], allowedTools: [] }]
        };
        store.agents.push(agent);
        draftAgentIds.add(agent.id);
        selectedAgentId = agent.id;
        renderManagement();
        setStatus('New local draft. Choose a stable ID before saving.', 'idle');
    }

    function agentFromForm(form) {
        const existing = selectedAgent() || {};
        const data = new FormData(form);
        const scope = existing.scopes?.find((item) => item.id === 'default') || {
            id: 'default', label: 'Default', context: [], allowedTools: []
        };
        return {
            ...existing,
            id: String(data.get('id') || '').trim().toLowerCase(),
            displayName: String(data.get('displayName') || '').trim(),
            role: String(data.get('role') || '').trim(),
            identity: String(data.get('identity') || '').trim(),
            workingRules: splitLines(data.get('workingRules')),
            allowedTools: splitLines(data.get('allowedTools')),
            privateNotes: splitLines(data.get('privateNotes')),
            providerBinding: {
                provider: String(data.get('provider') || 'unassigned'),
                modelId: String(data.get('modelId') || '').trim(),
                profile: existing.providerBinding?.profile || ''
            },
            scopes: [{ ...scope, instructions: String(data.get('scopeInstructions') || '').trim() }]
        };
    }

    async function saveCurrent(form) {
        if (busy) return;
        busy = true;
        setStatus('Saving locally…', 'busy');
        try {
            const oldId = selectedAgentId;
            const payload = await request(`${API_PATH}/save`, {
                method: 'POST',
                body: JSON.stringify({ agent: agentFromForm(form) })
            });
            const index = store.agents.findIndex((agent) => agent.id === oldId);
            if (index >= 0) store.agents[index] = payload.agent;
            else store.agents.push(payload.agent);
            selectedAgentId = payload.agent.id;
            draftAgentIds.delete(oldId);
            renderManagement();
            setStatus(`${payload.agent.displayName} saved to the private local store.`, 'ok');
        } catch (error) {
            setStatus(error?.message || 'Agent profile could not be saved.', 'error');
        } finally {
            busy = false;
        }
    }

    async function saveTloDefinition() {
        if (busy || selectedAgentId !== 'tlo') return;
        const text = root?.querySelector('[name="tloDefinition"]')?.value || '';
        busy = true;
        setStatus('Saving TLO definition…', 'busy');
        try {
            const payload = await request(`${API_PATH}/definition`, {
                method: 'POST', body: JSON.stringify({ text })
            });
            tloDefinition = payload.definition;
            renderForm();
            setStatus('TLO definition saved privately. New TLO turns use this file.', 'ok');
        } catch (error) {
            setStatus(error?.message || 'TLO definition could not be saved.', 'error');
        } finally {
            busy = false;
        }
    }

    async function exportPortable() {
        if (busy) return;
        busy = true;
        setPortableStatus('Preparing private export…', 'busy');
        try {
            const payload = await request(`${API_PATH}/portable/export`);
            const blob = new Blob([JSON.stringify(payload.bundle, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `eveos-agent-nexus-${new Date().toISOString().slice(0, 10)}.json`;
            link.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            setPortableStatus('Export downloaded. It contains private conversation text; store it carefully.', 'ok');
        } catch (error) {
            setPortableStatus(error?.message || 'Export failed.', 'error');
        } finally {
            busy = false;
        }
    }

    async function previewPortable() {
        if (busy) return;
        const file = root?.querySelector('[data-agent-portable-file]')?.files?.[0];
        importBundle = null;
        root?.querySelector('[data-agent-management-action="apply"]')?.setAttribute('hidden', '');
        if (!file || file.size > 16 * 1024 * 1024) {
            setPortableStatus('Choose a JSON bundle smaller than 16 MB.', 'error');
            return;
        }
        busy = true;
        setPortableStatus('Validating the entire bundle without changing data…', 'busy');
        try {
            const candidate = JSON.parse(await file.text());
            const payload = await request(`${API_PATH}/portable/preview`, {
                method: 'POST', body: JSON.stringify({ bundle: candidate })
            });
            const plan = payload.plan;
            const conflicts = [...plan.conflictingAgents, ...plan.conflictingRooms];
            const summary = `${plan.incomingAgents} agents, ${plan.incomingRooms} rooms, ${plan.incomingMessages} messages. `
                + `${plan.addedAgents.length} agents and ${plan.addedRooms.length} rooms would be added.`;
            if (plan.canApply) {
                importBundle = candidate;
                root?.querySelector('[data-agent-management-action="apply"]')?.removeAttribute('hidden');
                setPortableStatus(`${summary} Review this preview, then press Apply.`, 'ok');
            } else {
                setPortableStatus(`${summary} Import blocked by conflicting IDs${conflicts.length ? `: ${conflicts.join(', ')}` : ''}`
                    + `${plan.definitionConflict ? '; private TLO definition differs' : ''}.`, 'error');
            }
        } catch (error) {
            setPortableStatus(error?.message || 'Bundle validation failed.', 'error');
        } finally {
            busy = false;
        }
    }

    async function applyPortable() {
        if (busy || !importBundle) return;
        busy = true;
        setPortableStatus('Applying reviewed import with local backup…', 'busy');
        try {
            const payload = await request(`${API_PATH}/portable/apply`, {
                method: 'POST', body: JSON.stringify({ bundle: importBundle })
            });
            importBundle = null;
            root?.querySelector('[data-agent-management-action="apply"]')?.setAttribute('hidden', '');
            store = null;
            busy = false;
            await loadManagement(true);
            setPortableStatus(payload.plan.backupPath
                ? 'Import complete. An ignored local backup was created before changes.'
                : 'This bundle was already present; nothing changed.', 'ok');
        } catch (error) {
            setPortableStatus(error?.message || 'Import failed; local data was not intentionally changed.', 'error');
        } finally {
            busy = false;
        }
    }

    function selectView(view) {
        root?.querySelectorAll('[data-agent-nexus-panel]').forEach((panel) => {
            panel.hidden = panel.dataset.agentNexusPanel !== view;
        });
        root?.querySelectorAll('[data-agent-nexus-view]').forEach((button) => {
            const active = button.dataset.agentNexusView === view;
            button.classList.toggle('is-active', active);
            if (button.getAttribute('role') === 'tab') button.setAttribute('aria-selected', String(active));
        });
        if (view === 'management') { loadManagement(false); window.EveOSAgentDocuments?.activate?.(); }
        if (view === 'tlo') window.EveOSTloChat?.activate?.();
        if (view === 'nexus-browser') window.EveOSNexusBrowser?.activate?.();
    }

    function handleClick(event) {
        const viewButton = event.target.closest('[data-agent-nexus-view]');
        if (viewButton) {
            event.preventDefault();
            selectView(viewButton.dataset.agentNexusView);
            return;
        }
        const agentButton = event.target.closest('[data-agent-management-agent]');
        if (agentButton) {
            selectedAgentId = agentButton.dataset.agentManagementAgent;
            renderManagement();
            return;
        }
        const action = event.target.closest('[data-agent-management-action]')?.dataset.agentManagementAction;
        if (action === 'new') createDraft();
        if (action === 'save-definition') saveTloDefinition();
        if (action === 'export') exportPortable();
        if (action === 'preview') previewPortable();
        if (action === 'apply') applyPortable();
    }

    function bind(container) {
        root = container;
        if (boundRoots.has(container)) return;
        boundRoots.add(container);
        window.EveOSTloChat?.bind?.(container);
        window.EveOSNexusBrowser?.bind?.(container);
        window.EveOSAgentDocuments?.bind?.(container);
        container.addEventListener('click', handleClick);
        container.addEventListener('submit', (event) => {
            if (!event.target.matches('[data-agent-management-form]')) return;
            event.preventDefault();
            saveCurrent(event.target);
        });
    }

    window.EveOSAgentNexus = Object.freeze({ markup, bind, loadManagement, selectView });
})();
