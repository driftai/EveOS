/* TLO chat: scoped Agent Management context streamed through Local MoE. */
(function () {
    'use strict';

    if (window.EveOSTloChat) return;

    const STATUS_PATH = '/api/eve-state/modular/tlo/status?scopeId=default';
    const STREAM_PATH = '/api/eve-state/modular/tlo/chat/stream';
    const CANCEL_PATH = '/api/eve-state/modular/tlo/chat/cancel';
    const boundRoots = new WeakSet();
    let root = null;
    let apiBase = '';
    let status = null;
    let active = null;
    let conversation = [];

    function markup() {
        return `
            <article class="eveos-agent-card eveos-tlo-identity" data-agent-id="tlo">
                <span class="eveos-agent-avatar">T</span>
                <span><strong data-tlo-name>TLO</strong><small data-tlo-role>Local agent identity above the generic Local MoE provider.</small></span>
                <span class="eveos-ai-provider-pill" data-tlo-state>Checking</span>
            </article>
            <div class="eveos-tlo-facts" aria-label="TLO provider status">
                <span><small>Provider</small><strong data-tlo-provider>Local MoE</strong></span>
                <span><small>Model</small><strong data-tlo-model>Checking…</strong></span>
                <span><small>Scope</small><strong data-tlo-scope>default</strong></span>
            </div>
            <p class="eveos-ai-provider-message eveos-tlo-status" data-tlo-message>
                Checking TLO without starting Local MoE…
            </p>
            <div class="eveos-tlo-actions">
                <button type="button" data-tlo-action="local-moe">Local MoE controls</button>
                <button type="button" data-agent-nexus-view="management">Agent Management</button>
                <button type="button" data-tlo-action="refresh">Refresh</button>
                <button type="button" data-tlo-action="clear">New conversation</button>
            </div>
            <div class="eveos-tlo-transcript" data-tlo-transcript role="log" aria-live="polite" aria-label="TLO conversation">
                <p class="eveos-tlo-empty" data-tlo-empty>Start Local MoE explicitly, then chat with TLO here.</p>
            </div>
            <form class="eveos-tlo-composer" data-tlo-form>
                <label for="eveos-tlo-prompt">Message TLO</label>
                <textarea id="eveos-tlo-prompt" data-tlo-input rows="3" maxlength="16000"
                    placeholder="Ask TLO…" disabled></textarea>
                <div>
                    <span data-tlo-composer-hint>Waiting for Local MoE.</span>
                    <button type="button" data-tlo-action="cancel" hidden>Stop</button>
                    <button type="submit" data-tlo-send disabled>Send</button>
                </div>
            </form>
        `;
    }

    function candidateBases() {
        const network = window.GeminiServerNetwork?.localCandidateBases?.() || [];
        const registry = window.EveOSPortRegistry?.url?.('EVEOS_WEB_PORT');
        const current = /^https?:$/.test(window.location?.protocol || '') ? window.location.origin : '';
        return Array.from(new Set([current, registry, 'http://127.0.0.1:8765', ...network].filter(Boolean)));
    }

    async function jsonResponse(response) {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok !== true) {
            const error = new Error(payload.error || `TLO request failed (${response.status}).`);
            error.state = payload.state || 'request_failed';
            throw error;
        }
        return payload;
    }

    async function refreshStatus() {
        let lastError = null;
        for (const base of candidateBases()) {
            const controller = new AbortController();
            const timer = window.setTimeout(() => controller.abort(), 6000);
            try {
                const response = await fetch(`${base}${STATUS_PATH}`, { cache: 'no-store', signal: controller.signal });
                const payload = await jsonResponse(response);
                apiBase = base;
                status = payload;
                renderStatus(payload);
                return payload;
            } catch (error) {
                lastError = error;
            } finally {
                window.clearTimeout(timer);
            }
        }
        apiBase = '';
        status = null;
        const control = window.EveOSControlPlane?.getState?.() || {};
        const webOnline = control.webRunning === true;
        renderStatus({
            state: webOnline ? 'api_unreachable' : 'eveos_offline',
            canChat: false,
            message: webOnline
                ? 'EveOS localhost is online, but the TLO API is unreachable from this page. Search Monitor will retry automatically.'
                : (lastError?.message || 'EveOS localhost is unavailable.'),
            agent: { displayName: 'TLO', role: 'Local EveOS agent', scopeId: 'default', provider: 'local-moe' }
        });
        return null;
    }

    function text(selector, value) {
        const node = root?.querySelector(selector);
        if (node) node.textContent = value;
    }

    function stateLabel(value) {
        const labels = {
            ready: 'Ready', stopped: 'Stopped', harness_stopped: 'Stopped', starting: 'Starting',
            harness_starting: 'Starting', runtime_starting: 'Loading', runtime_offline: 'Runtime offline',
            model_switching: 'Switching', model_mismatch: 'Model mismatch', model_untrusted: 'Model blocked',
            stream_interrupted: 'Interrupted', eveos_offline: 'EveOS offline', api_unreachable: 'API unreachable',
            profile_invalid: 'Profile error'
        };
        return labels[value] || String(value || 'Unavailable').replace(/_/g, ' ');
    }

    function renderStatus(payload) {
        const agent = payload?.agent || {};
        text('[data-tlo-name]', agent.displayName || 'TLO');
        text('[data-tlo-role]', agent.role || 'Local EveOS agent');
        text('[data-tlo-state]', stateLabel(payload?.state));
        text('[data-tlo-provider]', agent.provider === 'local-moe' ? 'Local MoE' : (agent.provider || 'Unavailable'));
        text('[data-tlo-model]', agent.activeModelId || agent.configuredModelId || 'Harness selection');
        text('[data-tlo-scope]', agent.scopeId || 'default');
        text('[data-tlo-message]', payload?.message || 'TLO status is unavailable.');
        const enabled = payload?.canChat === true && !active;
        const input = root?.querySelector('[data-tlo-input]');
        const send = root?.querySelector('[data-tlo-send]');
        if (input) input.disabled = !enabled;
        if (send) send.disabled = !enabled;
        text('[data-tlo-composer-hint]', enabled ? 'Scoped to TLO / default.' : 'Start or repair Local MoE through its existing controls.');
    }

    function setBusy(value) {
        const input = root?.querySelector('[data-tlo-input]');
        const send = root?.querySelector('[data-tlo-send]');
        const cancelButton = root?.querySelector('[data-tlo-action="cancel"]');
        if (input) input.disabled = value || status?.canChat !== true;
        if (send) send.disabled = value || status?.canChat !== true;
        if (cancelButton) cancelButton.hidden = !value;
        text('[data-tlo-composer-hint]', value ? 'TLO is generating locally…' :
            (status?.canChat ? 'Scoped to TLO / default.' : 'Start or repair Local MoE through its existing controls.'));
    }

    function bubble(role, value) {
        const transcript = root?.querySelector('[data-tlo-transcript]');
        if (!transcript) return null;
        root.querySelector('[data-tlo-empty]')?.remove();
        const article = document.createElement('article');
        article.className = `eveos-tlo-turn is-${role}`;
        const label = document.createElement('strong');
        label.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'TLO' : 'Status';
        const content = document.createElement('p');
        content.textContent = value || '';
        article.append(label, content);
        transcript.appendChild(article);
        transcript.scrollTop = transcript.scrollHeight;
        return { article, content };
    }

    function requestId() {
        if (window.crypto?.randomUUID) return `tlo-${window.crypto.randomUUID()}`;
        const values = new Uint32Array(3);
        window.crypto?.getRandomValues?.(values);
        return `tlo-${Date.now().toString(36)}-${Array.from(values).join('-')}`;
    }

    async function consumeSseResponse(response, handlers) {
        if (!response.body?.getReader) throw new Error('Streaming is unavailable in this browser.');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalized = false;

        function accept(line) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) return false;
            const raw = trimmed.slice(5).trimStart();
            if (raw === '[DONE]') {
                if (!finalized) handlers.onDone?.();
                finalized = true;
                return true;
            }
            let chunk;
            try { chunk = JSON.parse(raw); } catch (_) { return false; }
            if (chunk.error) {
                const error = new Error(chunk.error.message || 'TLO inference failed.');
                error.state = chunk.error.state || 'inference_failure';
                throw error;
            }
            const piece = chunk.choices?.[0]?.delta?.content;
            if (typeof piece === 'string' && piece) handlers.onDelta?.(piece);
            return false;
        }

        while (!finalized) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) if (accept(line)) break;
        }
        buffer += decoder.decode();
        if (!finalized && buffer.trim()) accept(buffer);
        if (!finalized) throw new Error('The TLO stream ended before completion.');
    }

    async function sendMessage(form, options = {}) {
        const external = options.external === true;
        if (active) {
            if (external) {
                const error = new Error('TLO is already generating in the Search Monitor conversation.');
                error.code = 'TLO_WORKSPACE_BUSY';
                throw error;
            }
            return null;
        }
        const input = form?.querySelector('[data-tlo-input]');
        const message = String(options.message != null ? options.message : (input?.value || '')).trim();
        if (!message) {
            if (external) throw new Error('TLO workspace prompt is empty.');
            return null;
        }
        if (!apiBase || status?.canChat !== true) await refreshStatus();
        if (!apiBase || status?.canChat !== true) {
            if (external) {
                const error = new Error(status?.message || 'TLO is not ready in Search Monitor.');
                error.code = status?.state || 'TLO_WORKSPACE_UNAVAILABLE';
                throw error;
            }
            return null;
        }

        const priorHistory = conversation.slice(-40);
        conversation.push({ role: 'user', content: message });
        bubble('user', message);
        if (!external && input) input.value = '';
        const assistant = bubble('assistant', '');
        const run = {
            id: String(options.requestId || requestId()),
            controller: new AbortController(),
            text: '',
            cancelled: false,
            source: external ? 'nexus' : 'search-monitor'
        };
        active = run;
        setBusy(true);
        try {
            const response = await fetch(`${apiBase}${STREAM_PATH}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requestId: run.id, scopeId: 'default', message, history: priorHistory }),
                signal: run.controller.signal
            });
            if (!response.ok) await jsonResponse(response);
            await consumeSseResponse(response, {
                onDelta(piece) {
                    run.text += piece;
                    if (assistant?.content) assistant.content.textContent = run.text;
                    options.onPartial?.(run.text);
                },
                onDone() {
                    if (!run.text && assistant?.content) assistant.content.textContent = 'TLO completed without a visible response.';
                }
            });
            const finalText = run.text || 'TLO completed without a visible response.';
            if (!run.cancelled) conversation.push({ role: 'assistant', content: finalText });
            return finalText;
        } catch (error) {
            if (run.cancelled || error?.name === 'AbortError') {
                if (assistant?.content) assistant.content.textContent = run.text ? `${run.text}\n\n[Stopped]` : '[Stopped]';
                const stopped = new Error('TLO Search Monitor turn was stopped.');
                stopped.code = 'TLO_WORKSPACE_INTERRUPTED';
                if (external) throw stopped;
            } else {
                assistant?.article?.remove();
                bubble('status', error?.message || 'TLO inference failed.');
                status = { ...(status || {}), state: error?.state || 'inference_failure', canChat: false,
                    message: error?.message || 'TLO inference failed.' };
                renderStatus(status);
                if (external) throw error;
            }
            return null;
        } finally {
            if (active === run) active = null;
            setBusy(false);
        }
    }

    async function sendWorkspaceMessage(message, options = {}) {
        const form = root?.querySelector('[data-tlo-form]');
        if (!root || !form) {
            const error = new Error('The TLO Search Monitor workspace is not mounted.');
            error.code = 'TLO_WORKSPACE_UNAVAILABLE';
            throw error;
        }
        return sendMessage(form, {
            external: true,
            message,
            requestId: options.requestId,
            onPartial: options.onPartial
        });
    }

    function workspaceSnapshot() {
        return {
            bound: !!root?.querySelector('[data-tlo-form]'),
            busy: !!active,
            canChat: status?.canChat === true,
            state: status?.state || 'unknown',
            historyMessages: conversation.length,
            activeRequestId: active?.id || null
        };
    }

    async function cancel() {
        const run = active;
        if (!run || run.cancelled) return;
        run.cancelled = true;
        run.controller.abort();
        if (apiBase) {
            fetch(`${apiBase}${CANCEL_PATH}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requestId: run.id })
            }).catch(() => {});
        }
    }

    function clearConversation() {
        if (active) cancel();
        conversation = [];
        const transcript = root?.querySelector('[data-tlo-transcript]');
        if (!transcript) return;
        transcript.replaceChildren();
        const empty = document.createElement('p');
        empty.className = 'eveos-tlo-empty';
        empty.dataset.tloEmpty = '';
        empty.textContent = 'New private in-memory conversation. Agent configuration is unchanged.';
        transcript.appendChild(empty);
    }

    function openLocalMoe() {
        const provider = root?.querySelector('[data-ai-provider="local-moe"]');
        if (provider) {
            provider.open = true;
            provider.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
        }
        window.EveOSSearchMonitorAiHome?.refreshLocalMoe?.();
    }

    function handleClick(event) {
        const action = event.target.closest('[data-tlo-action]')?.dataset.tloAction;
        if (!action) return;
        event.preventDefault();
        if (action === 'cancel') cancel();
        else if (action === 'clear') clearConversation();
        else if (action === 'refresh') refreshStatus();
        else if (action === 'local-moe') openLocalMoe();
    }

    function bind(container) {
        root = container;
        if (boundRoots.has(container)) return;
        boundRoots.add(container);
        container.addEventListener('click', handleClick);
        container.addEventListener('submit', (event) => {
            if (!event.target.matches('[data-tlo-form]')) return;
            event.preventDefault();
            sendMessage(event.target).catch((error) => console.debug('TLO send failed:', error?.message || error));
        });
    }

    function activate() {
        refreshStatus();
    }

    window.EveOSTloChat = Object.freeze({
        markup,
        bind,
        activate,
        refreshStatus,
        consumeSseResponse,
        cancel,
        clearConversation,
        sendWorkspaceMessage,
        workspaceSnapshot
    });
})();
