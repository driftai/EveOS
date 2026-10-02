/* Nexus Browser: EveOS-owned lifecycle shell around the isolated headed-browser runtime. */
(function () {
    'use strict';

    if (window.EveOSNexusBrowser) return;

    const STATUS_PATH = '/api/nexus-browser/status';
    const ACTION_PATHS = Object.freeze({
        start: '/api/nexus-browser/start',
        stop: '/api/nexus-browser/stop',
        setup: '/api/nexus-browser/setup',
        extension: '/api/nexus-browser/extension'
    });
    const boundRoots = new WeakSet();
    const DETACHED_WINDOW_NAME = 'eveos-nexus-browser-detached';
    const DETACHED_HEARTBEAT_MS = 4500;
    const WORKSPACE_CONTROL_TYPE = 'eveos:nexus-workspace-control';
    let root = null;
    let status = null;
    let busy = false;
    let detachedWindow = null;
    let detachedSeenAt = 0;

    function markup() {
        return `
            <article class="eveos-agent-card eveos-nexus-browser-identity" data-agent-tool-id="nexus-browser">
                <span class="eveos-agent-avatar eveos-agent-avatar--browser">N</span>
                <span><strong>Nexus Browser</strong><small>Headed AI targeting, exact-once routing, Dex rooms, and local-agent transport.</small></span>
                <span class="eveos-ai-provider-pill" data-nexus-browser-state>Checking</span>
            </article>
            <div class="eveos-nexus-browser-facts" aria-label="Nexus Browser runtime status">
                <span><small>Extension</small><strong data-nexus-browser-extension>Checking…</strong></span>
                <span><small>Targets</small><strong data-nexus-browser-targets>—</strong></span>
                <span><small>Dex rooms</small><strong data-nexus-browser-rooms>—</strong></span>
                <span><small>Port</small><strong data-nexus-browser-port>Registry</strong></span>
                <span><small>Detached</small><strong data-nexus-browser-detached>Closed</strong></span>
            </div>
            <p class="eveos-ai-provider-message" data-nexus-browser-message>
                Checking the runtime without starting it…
            </p>
            <div class="eveos-nexus-browser-actions">
                <button type="button" data-nexus-browser-action="setup">Install runtime</button>
                <button type="button" data-nexus-browser-action="start">Start</button>
                <button type="button" data-nexus-browser-action="stop">Stop</button>
                <button type="button" data-nexus-browser-action="refresh">Refresh</button>
                <button type="button" data-nexus-browser-action="extension">Extension folder</button>
                <button type="button" data-nexus-browser-action="detached">Open detached</button>
            </div>
            <p class="eveos-nexus-browser-note">
                The unpacked extension lives inside EveOS. Load it once from the Extension folder; runtime start/stop stays under EveOS and Global Stop.
            </p>
            <section class="eveos-nexus-browser-inline" data-nexus-browser-inline hidden aria-label="Nexus Browser workspace">
                <div class="eveos-nexus-browser-inline-head">
                    <span><strong>Browser transport & Dex</strong><small>Embedded EveOS workspace</small></span>
                    <span class="eveos-ai-provider-pill">Headed</span>
                </div>
                <iframe data-nexus-browser-frame title="Nexus Browser workspace"
                    sandbox="allow-forms allow-scripts allow-same-origin allow-popups"
                    allow="clipboard-read; clipboard-write" referrerpolicy="no-referrer"></iframe>
            </section>
        `;
    }

    function text(selector, value) {
        const node = root?.querySelector(selector);
        if (node) node.textContent = value;
    }

    function runtimeUrl(snapshot = status) {
        return snapshot?.url || window.EveOSPortRegistry?.url?.('NEXUS_BROWSER_PORT') || '';
    }

    function canonicalUrl(value) {
        if (!value) return '';
        try { return new URL(value, window.location.href).href; }
        catch { return String(value); }
    }

    function stateLabel(value) {
        const labels = { running: 'Online', stopped: 'Stopped', starting: 'Starting', blocked: 'Port blocked', external: 'External', error: 'Error' };
        return labels[value] || String(value || 'Unavailable').replace(/_/g, ' ');
    }

    function detachedOpen() {
        if (detachedWindow?.closed) return false;
        return detachedSeenAt > 0 && Date.now() - detachedSeenAt < DETACHED_HEARTBEAT_MS;
    }

    function detachedUrl() {
        const raw = runtimeUrl();
        if (!raw) return '';
        try {
            const url = new URL(raw);
            url.searchParams.set('eveosDetached', '1');
            return url.toString();
        } catch {
            return raw;
        }
    }

    function workspaceControlFor(container, action, reason = '', extra = {}) {
        const frame = container?.querySelector?.('[data-nexus-browser-frame]');
        const target = runtimeUrl();
        if (!frame?.contentWindow || !target) return false;
        try {
            frame.contentWindow.postMessage({
                type: WORKSPACE_CONTROL_TYPE, action, reason, at: Date.now(), ...extra
            }, new URL(target).origin);
            return true;
        } catch { return false; }
    }

    function workspaceControl(action, reason = '', extra = {}) {
        return workspaceControlFor(root, action, reason, extra);
    }

    function renderDetached() {
        const open = detachedOpen();
        text('[data-nexus-browser-detached]', open ? 'Open' : 'Closed');
        const button = root?.querySelector('[data-nexus-browser-action="detached"]');
        if (button) button.textContent = open ? 'Focus detached' : 'Open detached';
        const inline = root?.querySelector('[data-nexus-browser-inline]');
        if (inline && status?.running === true) inline.hidden = open;
    }

    function openDetached() {
        if (detachedOpen() && detachedWindow && !detachedWindow.closed) {
            try { detachedWindow.focus(); } catch {}
            return;
        }
        const url = detachedUrl();
        if (!url) return;
        workspaceControl('snapshot', 'detach');
        detachedWindow = window.open(
            url,
            DETACHED_WINDOW_NAME,
            'popup=yes,width=1280,height=900,resizable=yes,scrollbars=yes'
        );
        if (!detachedWindow) {
            render(status, 'Browser blocked the Nexus detached window. Allow popups for EveOS, then retry.');
            return;
        }
        detachedSeenAt = Date.now();
        try { detachedWindow.focus(); } catch {}
        renderDetached();
    }

    function closeDetached() {
        if (detachedWindow && !detachedWindow.closed) {
            try { detachedWindow.close(); } catch {}
        }
        detachedWindow = null;
        detachedSeenAt = 0;
        renderDetached();
    }

    function detachedMessage(event) {
        if (event?.data?.type !== 'eveos:nexus-detached-state') return;
        try {
            const expected = new URL(runtimeUrl()).origin;
            if (event.origin !== expected) return;
        } catch { return; }
        if (event.data.state === 'reattach') {
            detachedSeenAt = 0;
            detachedWindow = null;
            if (event.data.snapshot) {
                workspaceControl('restore-and-claim', 'reattach', { snapshot: event.data.snapshot });
            } else {
                workspaceControl('claim', 'reattach');
            }
            try { window.focus(); } catch {}
            try { root?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch {}
        } else if (event.data.state === 'closed') {
            detachedSeenAt = 0;
            if (detachedWindow?.closed) detachedWindow = null;
            workspaceControl('claim', 'detached-closed');
        } else {
            detachedSeenAt = Date.now();
            if (!detachedWindow && event.source) detachedWindow = event.source;
        }
        renderDetached();
    }

    window.addEventListener?.('message', detachedMessage);
    window.setInterval?.(() => {
        if (detachedWindow?.closed) {
            detachedWindow = null;
            detachedSeenAt = 0;
            workspaceControl('claim', 'detached-window-gone');
        }
        renderDetached();
    }, 1000);

    function render(snapshot, overrideMessage) {
        status = snapshot || null;
        const running = snapshot?.running === true;
        const extension = snapshot?.extensionConnected ? 'Connected' : snapshot?.extensionReady ? 'Ready · offline' : 'Missing';
        text('[data-nexus-browser-state]', busy ? 'Working' : stateLabel(snapshot?.state));
        text('[data-nexus-browser-extension]', extension);
        text('[data-nexus-browser-targets]', `${Number(snapshot?.onlineTargets || 0)} online · ${Number(snapshot?.localTargets || 0)} local · ${Number(snapshot?.appTargets || 0)} app`);
        text('[data-nexus-browser-rooms]', String(Number(snapshot?.dexRooms || 0)));
        text('[data-nexus-browser-port]', String(snapshot?.port || window.EveOSPortRegistry?.get?.('NEXUS_BROWSER_PORT') || 'Registry'));
        text('[data-nexus-browser-message]', overrideMessage || snapshot?.message || 'Nexus Browser status is unavailable.');
        for (const button of root?.querySelectorAll('[data-nexus-browser-action]') || []) {
            const action = button.dataset.nexusBrowserAction;
            button.disabled = busy
                || (action === 'start' && (running || snapshot?.dependenciesReady !== true))
                || (action === 'stop' && !running)
                || (action === 'setup' && (running || snapshot?.setupAvailable !== true))
                || (action === 'extension' && snapshot?.extensionReady !== true)
                || (action === 'detached' && !running);
        }
        if (!running && detachedWindow && !detachedWindow.closed) closeDetached();
        else renderDetached();
        const inline = root?.querySelector('[data-nexus-browser-inline]');
        const frame = root?.querySelector('[data-nexus-browser-frame]');
        if (inline) inline.hidden = !running || detachedOpen();
        if (frame) {
            if (running) {
                const next = canonicalUrl(runtimeUrl(snapshot));
                const current = canonicalUrl(frame.getAttribute('src') || '');
                if (next && current !== next) frame.setAttribute('src', next);
            } else if (frame.getAttribute('src') && frame.getAttribute('src') !== 'about:blank') {
                frame.setAttribute('src', 'about:blank');
            }
        }
    }

    async function controlRequest(path, options, timeoutMs) {
        const control = window.EveOSLocalControl;
        if (!control) throw new Error('EveOS Local Control is unavailable.');
        const payload = await control.fetchJson(`${control.baseUrl()}${path}`, options, timeoutMs);
        return payload?.payload || payload;
    }

    async function refresh() {
        try {
            const snapshot = await controlRequest(STATUS_PATH, null, 5000);
            render(snapshot);
            return snapshot;
        } catch (error) {
            const control = window.EveOSControlPlane?.getState?.() || {};
            const message = control.controllerAvailable
                ? 'Local Control is online, but Nexus Browser status is temporarily unreachable. Keeping the current workspace while Search Monitor retries.'
                : (error?.message || 'Local Control is offline.');
            if (status?.running === true) render(status, message);
            else render({ state: 'unavailable', running: false, extensionReady: true }, message);
            return null;
        }
    }

    async function invoke(action) {
        if (busy || !ACTION_PATHS[action]) return null;
        busy = true;
        render(status || { state: 'stopped', running: false }, `${action === 'setup' ? 'Installing' : `${action}ing`} Nexus Browser…`);
        try {
            await window.EveOSLocalControl?.ensure?.({ timeoutMs: 45000, userInitiated: true });
            const timeout = action === 'setup' ? 10 * 60 * 1000 : action === 'stop' ? 30000 : 15000;
            const snapshot = await controlRequest(ACTION_PATHS[action], { method: 'POST' }, timeout);
            render(snapshot);
            if (action === 'stop' && snapshot?.running !== true) closeDetached();
            return snapshot;
        } catch (error) {
            render(status || { state: 'error', running: false }, error?.message || `Nexus Browser ${action} failed.`);
            return null;
        } finally {
            busy = false;
            render(status);
        }
    }

    function handleClick(event) {
        const button = event.target.closest('[data-nexus-browser-action]');
        if (!button) return;
        event.preventDefault();
        const action = button.dataset.nexusBrowserAction;
        if (action === 'refresh') refresh();
        else if (action === 'detached') openDetached();
        else invoke(action);
    }

    function bind(container) {
        const previous = root;
        if (previous && previous !== container) {
            workspaceControlFor(previous, 'standby', 'host-root-replaced');
            const oldInline = previous.querySelector?.('[data-nexus-browser-inline]');
            if (oldInline) oldInline.hidden = true;
        }
        root = container;
        if (boundRoots.has(container)) {
            if (status?.running === true && !detachedOpen()) workspaceControl('claim', 'host-rebind');
            return;
        }
        boundRoots.add(container);
        container.addEventListener('click', handleClick);
        const frame = container.querySelector?.('[data-nexus-browser-frame]');
        frame?.addEventListener('load', () => {
            if (root === container && status?.running === true && !detachedOpen()) {
                workspaceControlFor(container, 'claim-fresh', 'host-frame-load');
            }
        });
    }

    async function activate() {
        const snapshot = await refresh();
        if (snapshot?.running === true && !detachedOpen()) workspaceControl('claim', 'host-activate');
        return snapshot;
    }

    window.EveOSNexusBrowser = Object.freeze({ markup, bind, activate, refresh });
})();
