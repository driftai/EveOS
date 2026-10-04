/* Search Monitor service-chat host: ports the existing TLO and Local MoE conversations into Nexus. */
(function () {
    'use strict';

    if (window.EveOSServiceChatBridge) return;

    const TARGETS = Object.freeze([
        'local:local-moe-chat:default',
        'local:tlo-chat:default'
    ]);
    const LOCAL_MOE_TARGET = 'local:local-moe-chat:default';
    const TLO_TARGET = 'local:tlo-chat:default';
    const HEARTBEAT_MS = 15000;
    const RECONNECT_MS = 2500;
    const LOCAL_MOE_MESSAGE_TYPE = 'eveos:local-moe-workspace-event';
    const workspaceId = window.crypto?.randomUUID?.()
        ? `search-monitor-${window.crypto.randomUUID()}`
        : `search-monitor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    let socket = null;
    let registered = false;
    let stopped = false;
    let reconnectTimer = null;
    let heartbeatTimer = null;
    const localMoePending = new Map();

    function nexusBase() {
        const registry = window.EveOSPortRegistry?.url?.('NEXUS_BROWSER_PORT');
        if (registry) return registry;
        const frame = document.querySelector?.('[data-nexus-browser-frame]');
        const src = frame?.getAttribute?.('src') || '';
        return src && src !== 'about:blank' ? src : 'http://127.0.0.1:8768';
    }

    function websocketUrl() {
        try {
            const url = new URL(nexusBase(), window.location.href);
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            url.pathname = '/ws';
            url.search = '';
            url.hash = '';
            return url.toString();
        } catch {
            return '';
        }
    }

    function send(payload) {
        if (!socket || socket.readyState !== WebSocket.OPEN) return false;
        try {
            socket.send(JSON.stringify(payload));
            return true;
        } catch {
            return false;
        }
    }

    function serviceEvent(type, targetId, requestId, detail = {}) {
        send({
            type,
            workspaceId,
            targetId,
            requestId,
            ...detail
        });
    }

    function failRequest(targetId, requestId, error, code = 'SEARCH_MONITOR_WORKSPACE_ERROR') {
        serviceEvent('service_workspace_error', targetId, requestId, {
            code: error?.code || code,
            error: error?.message || String(error || 'Search Monitor workspace request failed.')
        });
    }

    function localMoeFrame() {
        return document.querySelector?.('[data-local-moe-frame]') || null;
    }

    function localMoeOrigin(frame) {
        try {
            const src = frame?.getAttribute?.('src') || frame?.src || '';
            return new URL(src, window.location.href).origin;
        } catch {
            return '';
        }
    }

    function sendLocalMoeRequest(message) {
        const requestId = String(message.requestId || '');
        const frame = localMoeFrame();
        const origin = localMoeOrigin(frame);
        if (!frame?.contentWindow || !origin || frame.getAttribute('src') === 'about:blank') {
            const error = new Error('The Local MoE Chat Sandbox is not mounted in Search Monitor.');
            error.code = 'LOCAL_MOE_WORKSPACE_UNAVAILABLE';
            throw error;
        }
        if (localMoePending.has(requestId)) {
            const error = new Error('That Local MoE workspace request is already active.');
            error.code = 'LOCAL_MOE_WORKSPACE_BUSY';
            throw error;
        }
        localMoePending.set(requestId, { frame, origin, targetId: LOCAL_MOE_TARGET });
        frame.contentWindow.postMessage({
            type: 'eveos:local-moe-workspace-request',
            workspaceId,
            requestId,
            text: String(message.text || '')
        }, origin);
    }

    async function sendTloRequest(message) {
        const requestId = String(message.requestId || '');
        const tlo = window.EveOSTloChat;
        if (!tlo?.sendWorkspaceMessage) {
            const error = new Error('The TLO Search Monitor workspace is not mounted.');
            error.code = 'TLO_WORKSPACE_UNAVAILABLE';
            throw error;
        }
        const finalText = await tlo.sendWorkspaceMessage(String(message.text || ''), {
            requestId,
            onPartial(text) {
                serviceEvent('service_workspace_partial', TLO_TARGET, requestId, { text: String(text || '') });
            }
        });
        serviceEvent('service_workspace_final', TLO_TARGET, requestId, { text: String(finalText || '') });
    }

    async function handleWorkspaceRequest(message) {
        if (String(message.workspaceId || '') !== workspaceId) return;
        const targetId = String(message.targetId || '');
        const requestId = String(message.requestId || '');
        if (!requestId || !String(message.text || '').trim()) {
            failRequest(targetId, requestId, new Error('Search Monitor received an empty workspace prompt.'), 'WORKSPACE_PROMPT_EMPTY');
            return;
        }
        try {
            if (targetId === TLO_TARGET) {
                await sendTloRequest(message);
                return;
            }
            if (targetId === LOCAL_MOE_TARGET) {
                sendLocalMoeRequest(message);
                return;
            }
            const error = new Error(`Search Monitor does not own workspace target ${targetId}.`);
            error.code = 'WORKSPACE_TARGET_UNSUPPORTED';
            throw error;
        } catch (error) {
            failRequest(targetId, requestId, error);
        }
    }

    function handleSocketMessage(event) {
        let message;
        try { message = JSON.parse(String(event.data || '')); }
        catch { return; }
        if (message.type === 'qualification_hello') {
            send({
                type: 'service_workspace_register',
                workspaceId,
                targets: TARGETS,
                href: String(window.location.href || '')
            });
            return;
        }
        if (message.type === 'service_workspace_host_ready') {
            registered = true;
            return;
        }
        if (message.type === 'service_workspace_request') {
            handleWorkspaceRequest(message);
        }
    }

    function clearTimers() {
        if (reconnectTimer) window.clearTimeout(reconnectTimer);
        if (heartbeatTimer) window.clearInterval(heartbeatTimer);
        reconnectTimer = null;
        heartbeatTimer = null;
    }

    function scheduleReconnect() {
        if (stopped || reconnectTimer) return;
        reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            ensureConnected();
        }, RECONNECT_MS);
    }

    function ensureConnected() {
        stopped = false;
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return true;
        const url = websocketUrl();
        if (!url) return false;
        try {
            socket = new WebSocket(url);
        } catch {
            socket = null;
            scheduleReconnect();
            return false;
        }
        socket.addEventListener('open', () => {
            registered = false;
            send({ type: 'hello', role: 'qualification' });
            if (heartbeatTimer) window.clearInterval(heartbeatTimer);
            heartbeatTimer = window.setInterval(() => {
                if (registered) send({ type: 'service_workspace_heartbeat', workspaceId });
            }, HEARTBEAT_MS);
        });
        socket.addEventListener('message', handleSocketMessage);
        socket.addEventListener('close', () => {
            registered = false;
            socket = null;
            if (heartbeatTimer) window.clearInterval(heartbeatTimer);
            heartbeatTimer = null;
            scheduleReconnect();
        });
        socket.addEventListener('error', () => {});
        return true;
    }

    function disconnect() {
        stopped = true;
        clearTimers();
        registered = false;
        for (const [requestId] of localMoePending) {
            localMoePending.delete(requestId);
        }
        try { socket?.close?.(1000, 'Search Monitor workspace host stopped'); } catch {}
        socket = null;
    }

    function handleLocalMoeMessage(event) {
        const data = event?.data;
        if (data?.type !== LOCAL_MOE_MESSAGE_TYPE) return;
        const requestId = String(data.requestId || '');
        const pending = localMoePending.get(requestId);
        if (!pending || event.source !== pending.frame.contentWindow || event.origin !== pending.origin) return;
        const kind = String(data.event || '');
        if (kind === 'partial') {
            serviceEvent('service_workspace_partial', LOCAL_MOE_TARGET, requestId, { text: String(data.text || '') });
            return;
        }
        localMoePending.delete(requestId);
        if (kind === 'final') {
            serviceEvent('service_workspace_final', LOCAL_MOE_TARGET, requestId, { text: String(data.text || '') });
            return;
        }
        if (kind === 'error' || kind === 'interrupted') {
            serviceEvent('service_workspace_error', LOCAL_MOE_TARGET, requestId, {
                code: String(data.code || (kind === 'interrupted' ? 'LOCAL_MOE_WORKSPACE_INTERRUPTED' : 'LOCAL_MOE_WORKSPACE_ERROR')),
                error: String(data.error || data.message || 'Local MoE workspace request failed.')
            });
        }
    }

    window.addEventListener?.('message', handleLocalMoeMessage);
    window.addEventListener?.('beforeunload', disconnect, { once: true });

    window.EveOSServiceChatBridge = Object.freeze({
        workspaceId,
        targets: TARGETS,
        ensureConnected,
        disconnect,
        isRegistered: () => registered
    });

    // This only attaches to Nexus if/when its localhost service is already online; it never starts it.
    window.setTimeout(ensureConnected, 0);
})();
