(function () {
    'use strict';

    const STATUS_URL = 'http://127.0.0.1:9084/status';
    const WS_FALLBACK = 'ws://127.0.0.1:9083';
    const MAX_TRAFFIC_EVENTS = 64;
    const INSPECTOR_TOGGLE_SELECTOR = '[data-gemini-server-inspector-toggle]';
    let refreshTimer = 0;
    let watchTimer = 0;
    let initialized = false;
    const traffic = [];

    function wsLabel(code) {
        return ['Connecting', 'Open', 'Closing', 'Closed'][Number(code)] || 'Unknown';
    }

    function shortJson(value) {
        try {
            return JSON.stringify(value || {}, null, 2).slice(0, 700);
        } catch (error) {
            return String(value || '').slice(0, 700);
        }
    }

    function shortText(value, max) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    }

    function parsePayload(raw) {
        if (typeof raw !== 'string') return raw;
        try {
            return JSON.parse(raw);
        } catch (error) {
            return raw;
        }
    }

    function summarizeChunks(chunks) {
        if (!Array.isArray(chunks)) return '';
        return chunks.slice(0, 5).map(function (chunk) {
            const mime = chunk?.mime_type || chunk?.mimeType || 'unknown';
            if (/image/i.test(mime)) return `${mime}:image`;
            if (/audio/i.test(mime)) return `${mime}:audio`;
            const text = chunk?.data && mime === 'text/plain' ? shortText(chunk.data, 60) : 'data';
            return `${mime}:${text}`;
        }).join(', ') + (chunks.length > 5 ? `, +${chunks.length - 5}` : '');
    }

    function summarizePayload(raw) {
        const payload = parsePayload(raw);
        if (typeof payload === 'string') {
            return { title: 'Text payload', detail: shortText(payload, 180), kind: 'text' };
        }
        if (!payload || typeof payload !== 'object') {
            return { title: 'Unknown payload', detail: String(payload || ''), kind: 'unknown' };
        }
        if (payload.setup) {
            const hasInstruction = !!payload.setup.systemInstruction;
            return {
                title: 'Session setup',
                detail: `model=${payload.model || 'server-default'} voice=${payload.setup?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName || 'n/a'} instruction=${hasInstruction ? 'yes' : 'no'} apiKey=${payload.apiKey ? '[redacted]' : 'vault/default'}`,
                kind: 'setup'
            };
        }
        if (payload.realtime_input?.media_chunks) {
            const isSilent = !!(payload.silentResponseRequested || payload.silent_response || payload.screen_share?.silent);
            return {
                title: isSilent ? 'Silent screen/context input' : 'Realtime input',
                detail: summarizeChunks(payload.realtime_input.media_chunks),
                kind: isSilent ? 'silent' : 'input'
            };
        }
        if (payload.command) {
            return {
                title: `Command: ${payload.command}`,
                detail: shortJson(Object.assign({}, payload, { apiKey: payload.apiKey ? '[redacted]' : undefined })),
                kind: 'command'
            };
        }
        if (payload.text) {
            return { title: payload.is_system_message ? 'System text' : 'User text', detail: shortText(payload.text, 180), kind: 'text' };
        }
        if (payload.is_system_message || payload.message) {
            return { title: 'Server message', detail: shortText(payload.message || payload.text || shortJson(payload), 180), kind: 'message' };
        }
        if (payload.type || payload.event) {
            return { title: `Event: ${payload.type || payload.event}`, detail: shortJson(payload), kind: 'event' };
        }
        return { title: 'JSON payload', detail: shortJson(payload), kind: 'json' };
    }

    function renderTraffic() {
        const list = document.querySelector('[data-gemini-server-inspector-traffic]');
        if (!list) return;
        if (!traffic.length) {
            list.innerHTML = '<div class="gemini-server-inspector-empty">No websocket traffic observed yet.</div>';
            return;
        }
        list.innerHTML = traffic.slice(-24).reverse().map(function (entry) {
            const direction = entry.direction === 'out' ? 'Outbound' : 'Inbound';
            return `
                <article class="gemini-server-inspector-event is-${entry.direction} is-${entry.kind}">
                    <div class="gemini-server-inspector-event-head">
                        <span>${direction}</span>
                        <time>${entry.time}</time>
                    </div>
                    <strong>${entry.title}</strong>
                    <p>${entry.detail || 'No detail'}</p>
                </article>
            `;
        }).join('');
    }

    function record(direction, payload, meta) {
        const summary = summarizePayload(payload);
        traffic.push(Object.assign({
            direction: direction === 'in' ? 'in' : 'out',
            at: Date.now(),
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        }, summary, meta || {}));
        while (traffic.length > MAX_TRAFFIC_EVENTS) traffic.shift();
        renderTraffic();
    }

    function watchSocket() {
        const socket = window.webSocket;
        if (!socket || socket.__geminiInspectorObserved === '1') return;
        socket.__geminiInspectorObserved = '1';
        const originalSend = socket.send?.bind(socket);
        if (originalSend && socket.__geminiInspectorSendWrapped !== '1') {
            socket.send = function (payload) {
                record('out', payload);
                return originalSend(payload);
            };
            socket.__geminiInspectorSendWrapped = '1';
        }
        if (typeof socket.addEventListener === 'function') {
            socket.addEventListener('message', function (event) {
                record('in', event?.data);
            });
            socket.addEventListener('open', function () {
                record('in', { event: 'websocket-open', url: window.SocketGlobalState?.WS_URL || WS_FALLBACK });
            });
            socket.addEventListener('close', function () {
                record('in', { event: 'websocket-close' });
            });
            socket.addEventListener('error', function () {
                record('in', { event: 'websocket-error' });
            });
        }
    }

    function ensurePanel() {
        let panel = document.getElementById('geminiServerInspectorPanel');
        if (panel) return panel;

        panel = document.createElement('div');
        panel.id = 'geminiServerInspectorPanel';
        panel.className = 'gemini-server-inspector-panel';
        panel.hidden = true;
        panel.innerHTML = `
            <div class="gemini-server-inspector-head">
                <div>
                    <div class="gemini-server-inspector-kicker">Runtime Ports</div>
                    <h4>EveOS Runtime Monitor</h4>
                </div>
                <div class="gemini-server-inspector-actions">
                    <button type="button" data-gemini-server-inspector-copy title="Copy server monitor report">
                        <i class="material-icons" aria-hidden="true">content_copy</i>
                    </button>
                    <button type="button" data-gemini-server-inspector-clear title="Clear traffic log">
                        <i class="material-icons" aria-hidden="true">playlist_remove</i>
                    </button>
                    <button type="button" data-gemini-server-inspector-refresh title="Refresh server status">
                        <i class="material-icons" aria-hidden="true">refresh</i>
                    </button>
                    <button type="button" data-gemini-server-inspector-close title="Close server monitor">
                        <i class="material-icons" aria-hidden="true">close</i>
                    </button>
                </div>
            </div>
            <div class="gemini-server-inspector-grid" data-gemini-server-inspector-grid></div>
            <section class="gemini-server-inspector-traffic">
                <div class="gemini-server-inspector-traffic-head">
                    <span>Live Traffic</span>
                    <small>redacted, last ${MAX_TRAFFIC_EVENTS}</small>
                </div>
                <div class="gemini-server-inspector-traffic-list" data-gemini-server-inspector-traffic></div>
            </section>
        `;

        const root = document.getElementById('gemini-ui-root') || document.body;
        root.appendChild(panel);
        panel.querySelector('[data-gemini-server-inspector-close]')?.addEventListener('click', closePanel);
        panel.querySelector('[data-gemini-server-inspector-refresh]')?.addEventListener('click', refreshPanel);
        panel.querySelector('[data-gemini-server-inspector-copy]')?.addEventListener('click', copyReport);
        panel.querySelector('[data-gemini-server-inspector-clear]')?.addEventListener('click', function () {
            traffic.length = 0;
            renderTraffic();
        });
        renderTraffic();
        return panel;
    }

    function statusClass(ok) {
        if (ok === true) return 'is-online';
        if (ok === false) return 'is-offline';
        return 'is-checking';
    }

    function card(title, status, detail, ok) {
        return `
            <section class="gemini-server-inspector-card ${statusClass(ok)}">
                <div class="gemini-server-inspector-card-head">
                    <span>${title}</span>
                    <strong>${status}</strong>
                </div>
                <pre>${detail}</pre>
            </section>
        `;
    }

    async function fetchStatusServer() {
        try {
            const payload = await window.GeminiServerNetwork.fetchJson(STATUS_URL, null, 900);
            return { ok: true, payload };
        } catch (error) {
            return { ok: false, error: error?.message || 'Unavailable' };
        }
    }

    async function buildCards() {
        const controlPlane = window.EveOSControlPlane?.getState?.() || {};
        const gemini = window.GeminiServerControl?.getState?.() || {};
        const worldBook = window.EveWorldBook?.client?.state || {};
        const ws = window.webSocket || null;
        const socketState = ws ? wsLabel(ws.readyState) : 'Not created';
        const status = await fetchStatusServer();
        const bases = window.GeminiServerNetwork?.localCandidateBases?.() || [];
        const currentOrigin = /^https?:$/i.test(window.location.protocol)
            ? window.location.origin
            : window.location.href.split(/[?#]/)[0];

        return [
            card('EveOS Page', /^https?:$/i.test(window.location.protocol) ? 'Served' : 'Local file', `Current: ${currentOrigin}\nCandidates:\n${bases.join('\n') || 'None'}`, /^https?:$/i.test(window.location.protocol)),
            card('Local Control Plane', controlPlane.controllerAvailable ? 'Ready' : 'Unavailable', `Base: ${controlPlane.helperBaseUrl || 'not found'}\nEveOS localhost: ${controlPlane.webRunning ? 'online' : 'off'}\nDesired: ${controlPlane.desiredRunning ? 'on' : 'off'}\n${controlPlane.message || ''}`, !!controlPlane.controllerAvailable),
            card('Gemini Backend', gemini.serverState || 'Unknown', `Base: ${gemini.baseUrl || 'not found'}\nRunning: ${gemini.running ? 'yes' : 'no'}\nPhase: ${gemini.connectionPhase || 'n/a'}\n${gemini.message || ''}`, !!gemini.running),
            card('World Book', worldBook.serverState || 'Unknown', `Controller: ${worldBook.baseUrl || 'standalone/not found'}\nRunning: ${worldBook.running ? 'yes' : 'no'}\nDesired: ${worldBook.desiredRunning ? 'on' : 'off'}\n${worldBook.message || ''}`, !!worldBook.running),
            card('Gemini WebSocket', socketState, `URL: ${window.SocketGlobalState?.WS_URL || WS_FALLBACK}\nAPI ready: ${window.SocketGlobalState?.geminiApiReady ? 'yes' : 'no'}\nAuto reconnect: ${window.SocketGlobalState?.autoReconnectEnabled === false ? 'off' : 'on'}`, ws?.readyState === window.WebSocket?.OPEN),
            card('Gemini Status Server', status.ok ? 'Online' : 'Offline', status.ok ? shortJson(status.payload) : status.error, status.ok)
        ].join('');
    }

    async function buildReport() {
        const controlPlane = window.EveOSControlPlane?.getState?.() || {};
        const gemini = window.GeminiServerControl?.getState?.() || {};
        const worldBook = window.EveWorldBook?.client?.state || {};
        const ws = window.webSocket || null;
        const status = await fetchStatusServer();
        const bases = window.GeminiServerNetwork?.localCandidateBases?.() || [];
        const currentOrigin = /^https?:$/i.test(window.location.protocol)
            ? window.location.origin
            : window.location.href.split(/[?#]/)[0];
        const recent = traffic.slice(-16).map(function (entry) {
            return `- ${entry.time} ${entry.direction.toUpperCase()} ${entry.title}: ${entry.detail}`;
        }).join('\n') || '- no websocket traffic observed';
        return [
            'EveOS Runtime Monitor',
            `Generated: ${new Date().toISOString()}`,
            '',
            `[EveOS Page]\nCurrent: ${currentOrigin}\nCandidates:\n${bases.join('\n') || 'None'}`,
            '',
            `[Local Control Plane]\nState: ${controlPlane.serverState || 'Unknown'}\nBase: ${controlPlane.helperBaseUrl || 'not found'}\nController ready: ${controlPlane.controllerAvailable ? 'yes' : 'no'}\nEveOS localhost: ${controlPlane.webRunning ? 'online' : 'off'}\nDesired: ${controlPlane.desiredRunning ? 'on' : 'off'}\nMessage: ${controlPlane.message || ''}`,
            '',
            `[Gemini Backend]\nState: ${gemini.serverState || 'Unknown'}\nBase: ${gemini.baseUrl || 'not found'}\nRunning: ${gemini.running ? 'yes' : 'no'}\nPhase: ${gemini.connectionPhase || 'n/a'}\nMessage: ${gemini.message || ''}`,
            '',
            `[World Book]\nState: ${worldBook.serverState || 'Unknown'}\nBase: ${worldBook.baseUrl || 'standalone/not found'}\nRunning: ${worldBook.running ? 'yes' : 'no'}\nDesired: ${worldBook.desiredRunning ? 'on' : 'off'}\nMessage: ${worldBook.message || ''}`,
            '',
            `[Gemini WebSocket]\nState: ${ws ? wsLabel(ws.readyState) : 'Not created'}\nURL: ${window.SocketGlobalState?.WS_URL || WS_FALLBACK}\nAPI ready: ${window.SocketGlobalState?.geminiApiReady ? 'yes' : 'no'}\nAuto reconnect: ${window.SocketGlobalState?.autoReconnectEnabled === false ? 'off' : 'on'}`,
            '',
            `[Gemini Status Server]\n${status.ok ? shortJson(status.payload).replace(/"apiKey"\s*:\s*"[^"]+"/g, '"apiKey":"[redacted]"') : status.error}`,
            '',
            `[Recent Traffic]\n${recent}`
        ].join('\n');
    }

    async function copyText(value) {
        if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
        return true;
    }

    async function copyReport() {
        const report = await buildReport();
        await copyText(report);
        if (typeof window.displayMessage === 'function') {
            window.displayMessage('System Message: EveOS runtime monitor report copied.', true);
        }
    }

    async function refreshPanel() {
        watchSocket();
        const panel = ensurePanel();
        const grid = panel.querySelector('[data-gemini-server-inspector-grid]');
        if (!grid) return;
        grid.innerHTML = card('Refreshing', 'Checking', 'Polling local ports...', null);
        grid.innerHTML = await buildCards();
        renderTraffic();
    }

    function openPanel() {
        const panel = ensurePanel();
        panel.hidden = false;
        panel.classList.add('is-open');
        refreshPanel();
        if (!refreshTimer) {
            refreshTimer = window.setInterval(function () {
                if (!panel.hidden && document.visibilityState === 'visible') refreshPanel();
            }, 5000);
        }
    }

    function closePanel() {
        const panel = ensurePanel();
        panel.hidden = true;
        panel.classList.remove('is-open');
        if (refreshTimer) {
            window.clearInterval(refreshTimer);
            refreshTimer = 0;
        }
    }

    function handleInspectorToggleClick(event) {
        const target = event?.target;
        const button = target?.closest?.(INSPECTOR_TOGGLE_SELECTOR);
        if (!button) return;
        const panel = ensurePanel();
        if (panel.hidden) openPanel();
        else closePanel();
    }

    function initialize() {
        if (initialized) return;
        initialized = true;

        // The inspector toggle can be injected dynamically. Event delegation keeps
        // that support without a document-wide MutationObserver that rescans the
        // entire EveOS DOM on every child mutation during workspace startup.
        document.addEventListener('click', handleInspectorToggleClick);
        watchSocket();
        if (!watchTimer) {
            watchTimer = window.setInterval(function () {
                if (document.visibilityState === 'visible') watchSocket();
            }, 1000);
        }
        window.addEventListener('eve:gemini-server-status', function () {
            const panel = document.getElementById('geminiServerInspectorPanel');
            if (panel && !panel.hidden) refreshPanel();
        });
        window.addEventListener('eve:eveos-control-plane-status', function () {
            const panel = document.getElementById('geminiServerInspectorPanel');
            if (panel && !panel.hidden) refreshPanel();
        });
        window.addEventListener('eve:world-book-status', function () {
            const panel = document.getElementById('geminiServerInspectorPanel');
            if (panel && !panel.hidden) refreshPanel();
        });
    }

    window.GeminiServerInspector = {
        open: openPanel,
        close: closePanel,
        refresh: refreshPanel,
        copyReport,
        record,
        getTraffic: function () { return traffic.slice(); }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
