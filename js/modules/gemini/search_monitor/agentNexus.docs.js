/* Agent Nexus document workspace: safe read of tracked Markdown, private edits only. */
(() => {
    'use strict';
    const API = '/api/eve-state/modular/agent-management';
    const TLO = '/api/eve-state/modular/tlo/status?scopeId=default';
    const bound = new WeakSet();
    let root = null;
    let catalog = [];
    let current = null;
    let loading = false;
    let loaded = false;

    function markup() {
        return [
            '<details class="eveos-agent-docs" data-agent-docs>',
            '<summary>Agent files & EveOS knowledge library</summary>',
            '<p class="eveos-agent-doc-note">Browse tracked Markdown by folder. Edits are private local overrides; repository files remain unchanged. Only TLO AGENT.md and NEXUS.md are included in new TLO turns.</p>',
            '<div class="eveos-agent-doc-status" data-agent-live-state>Checking TLO…</div>',
            '<div class="eveos-agent-doc-actions"><input type="search" data-agent-doc-search placeholder="Find a Markdown file or folder" aria-label="Find a Markdown document">',
            '<button type="button" data-agent-doc-action="refresh">Refresh library & TLO</button></div>',
            '<div class="eveos-agent-doc-layout">',
            '<nav class="eveos-agent-doc-tree" data-agent-doc-list aria-label="Repository Markdown folders"></nav>',
            '<div class="eveos-agent-doc-editor">',
            '<strong data-agent-doc-title>Select a document</strong>',
            '<small data-agent-doc-origin>Tracked files are read-only until you save a private override.</small>',
            '<textarea data-agent-doc-text rows="16" disabled aria-label="Document Markdown editor"></textarea>',
            '<div class="eveos-agent-doc-actions"><button type="button" data-agent-doc-action="save" disabled>Save private revision</button>',
            '<span data-agent-doc-feedback role="status">No file selected.</span></div>',
            '</div></div></details>'
        ].join('');
    }

    function bases() {
        const network = window.GeminiServerNetwork?.localCandidateBases?.() || [];
        const port = window.EveOSPortRegistry?.url?.('EVEOS_WEB_PORT');
        const local = /^https?:$/.test(window.location?.protocol || '') ? window.location.origin : '';
        return [...new Set([local, port, 'http://127.0.0.1:8765', ...network].filter(Boolean))];
    }

    async function request(path, options) {
        let problem;
        for (const base of bases()) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            try {
                const response = await fetch(base + path, {
                    cache: 'no-store',
                    headers: { 'Content-Type': 'application/json' },
                    ...options, signal: controller.signal
                });
                const data = await response.json().catch(() => ({}));
                if (response.status === 404) { problem = Error('EveOS document endpoint not found.'); continue; }
                if (!response.ok || data.ok !== true) throw Error(data.error || 'EveOS request failed (' + response.status + ').');
                return data;
            } catch (error) {
                problem = error;
                if (!/fetch|network|abort|not found/i.test(String(error?.message || ''))) throw error;
            } finally {
                clearTimeout(timer);
            }
        }
        throw problem || Error('Local EveOS server is unavailable.');
    }

    function node(selector) { return root?.querySelector(selector); }
    function feedback(message, bad = false) {
        const target = node('[data-agent-doc-feedback]');
        if (target) {
            target.textContent = message;
            target.dataset.state = bad ? 'error' : 'ok';
        }
    }

    function renderTree() {
        const list = node('[data-agent-doc-list]');
        if (!list) return;
        list.replaceChildren();
        const needle = String(node('[data-agent-doc-search]')?.value || '').trim().toLowerCase();
        let group = '';
        let shown = 0;
        for (const doc of catalog) {
            if (needle && !(doc.path || '').toLowerCase().includes(needle)) continue;
            if (group !== doc.group) {
                group = doc.group;
                const header = document.createElement('div');
                header.className = 'eveos-agent-doc-group';
                header.textContent = group;
                list.append(header);
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.agentDocPath = doc.path;
            button.textContent = doc.path.split('/').at(-1) + (doc.hasOverride ? ' · edited' : '');
            button.className = 'eveos-agent-doc-item';
            button.classList.toggle('is-active', current?.path === doc.path);
            list.append(button);
            shown++;
        }
        if (!shown) {
            const empty = document.createElement('p');
            empty.className = 'eveos-agent-doc-note';
            empty.textContent = 'No matching Markdown files.';
            list.append(empty);
        }
    }

    function showDocument() {
        node('[data-agent-doc-title]').textContent = current?.path || 'Select a document';
        node('[data-agent-doc-origin]').textContent = !current
            ? 'Choose a file from the organized library.'
            : (current.source === 'tracked' || current.source === 'starter-file'
                ? 'Tracked source · saving creates a private override.'
                : current.source + ' · revision ' + current.revision);
        const editor = node('[data-agent-doc-text]');
        editor.disabled = !current;
        editor.value = current?.text || '';
        node('[data-agent-doc-action="save"]').disabled = !current;
        renderTree();
    }

    async function select(path) {
        if (loading) return;
        loading = true;
        feedback('Opening document…');
        try {
            const response = await request(API + '/documents/file?path=' + encodeURIComponent(path));
            current = response.document;
            showDocument();
            feedback('Opened. Changes are not saved until you press Save.');
        } catch (error) {
            feedback(error.message || 'Document cannot be opened.', true);
        } finally {
            loading = false;
        }
    }

    async function refresh() {
        if (loading) return;
        loading = true;
        feedback('Loading Markdown catalog and TLO runtime status…');
        try {
            const [docs, status] = await Promise.all([
                request(API + '/documents'), request(TLO)
            ]);
            catalog = docs.documents || [];
            loaded = true;
            renderTree();
            const model = status.agent?.activeModelId || 'none';
            const revision = status.agent?.nexusGuideRevision || 'unavailable';
            const live = node('[data-agent-live-state]');
            live.dataset.state = status.canChat === true ? 'ready' : 'offline';
            live.textContent = 'TLO: ' + (status.canChat ? 'Ready to chat' : (status.message || status.state || 'Unavailable'))
                + ' · model: ' + model + ' · Nexus guide: ' + revision;
            feedback(catalog.length + ' tracked Markdown documents available. Private changes are not published to Git.');
        } catch (error) {
            feedback(error.message || 'Could not load Agent Management documents.', true);
        } finally {
            loading = false;
        }
    }

    async function save() {
        if (loading || !current) return;
        loading = true;
        feedback('Saving an exact private revision…');
        try {
            const response = await request(API + '/documents/file', {
                method: 'POST',
                body: JSON.stringify({
                    path: current.path,
                    text: node('[data-agent-doc-text]').value,
                    expectedRevision: current.revision
                })
            });
            current = response.document;
            const item = catalog.find((doc) => doc.path === current.path);
            if (item) item.hasOverride = true;
            showDocument();
            feedback('Saved privately. New TLO turns use an updated AGENT.md or NEXUS.md.');
            if (current.path === 'config/agents/tlo/AGENT.md') {
                window.EveOSAgentNexus?.loadManagement?.(true);
            }
        } catch (error) {
            feedback(error.message || 'Could not save private document.', true);
        } finally {
            loading = false;
        }
    }

    function bind(container) {
        root = container;
        if (bound.has(container)) return;
        bound.add(container);
        container.addEventListener('click', (event) => {
            const target = event.target.closest('[data-agent-doc-path]');
            if (target) { select(target.dataset.agentDocPath); return; }
            const action = event.target.closest('[data-agent-doc-action]')?.dataset.agentDocAction;
            if (action === 'refresh') refresh();
            else if (action === 'save') save();
        });
        container.addEventListener('input', (event) => {
            if (event.target.matches('[data-agent-doc-search]')) renderTree();
        });
    }

    function activate() { if (!loaded) refresh(); }
    window.EveOSAgentDocuments = Object.freeze({ markup, bind, activate });
})();
