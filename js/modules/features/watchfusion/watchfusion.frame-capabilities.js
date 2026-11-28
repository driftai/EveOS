(function () {
    'use strict';

    if (window.__eveWatchFusionFrameCapabilitiesReady) return;
    window.__eveWatchFusionFrameCapabilitiesReady = true;

    const REQUIRED = ['autoplay', 'encrypted-media', 'fullscreen', 'picture-in-picture', 'web-share', 'webgpu'];
    const LOCAL_READY_TIMEOUT_MS = 6500;
    function exposureMode() {
        return String(window.EveWatchFusion?.getState?.()?.exposureMode || 'local').toLowerCase();
    }
    function readyTimeoutMs() {
        return exposureMode() === 'cloudflare' ? 22000 : exposureMode() === 'lan' ? 10000 : LOCAL_READY_TIMEOUT_MS;
    }
    function autoReloadLimit() {
        return exposureMode() === 'cloudflare' ? 0 : exposureMode() === 'lan' ? 1 : 2;
    }
    let activeFrame = null;
    let frameObserver = null;
    let readyTimer = 0;
    let reloadAttempts = 0;
    const HEARTBEAT_TTL_MS = 4500;
    let scope = null, lastHeartbeat = 0, reloadSequence = 0;

    // A heartbeat is evidence of a usable document, not a lease to keep it alive.
    // Once established, only an explicit navigation/reload may replace the document.
    function connectivity(frame, degraded) {
        const wrap = frame?.closest('.watchfusion-frame-wrap');
        if (wrap) wrap.dataset.frameConnectivity = degraded ? 'degraded' : 'healthy';
        const head = document.querySelector('#watchfusion-overlay .watchfusion-head-actions');
        if (!head) return;
        let note = head.querySelector('[data-wf-frame-connectivity]');
        if (degraded && !note) {
            note = document.createElement('span');
            note.dataset.wfFrameConnectivity = '1';
            note.className = 'watchfusion-status';
            note.setAttribute('role', 'status');
            note.textContent = 'Connection delayed';
            head.prepend(note);
        }
        if (note) note.hidden = !degraded;
    }

    function syncScope(frame, preserveBudget = false) {
        const src = frame?.src || '';
        if (!frame || frame !== activeFrame || frame.hidden || !/^https?:/i.test(src)) {
            if (scope) { clearReadyTimer(); scope = null; lastHeartbeat = 0; connectivity(frame, false); }
            return null;
        }
        if (!scope || scope.frame !== frame || scope.src !== src) {
            clearReadyTimer();
            if (!preserveBudget) reloadAttempts = 0;
            scope = { frame, src, since: Date.now(), established: false, probing: false, finished: false };
            lastHeartbeat = 0;
            connectivity(frame, false);
            setFrameState(frame, 'loading', 'Waiting for the embedded workspace to finish loading.');
        }
        return scope;
    }

    function currentScope(expected) {
        return expected && scope === expected && expected.frame === activeFrame && !expected.frame.hidden && expected.frame.src === expected.src;
    }

    function ensureLoadingSurface(frame) {
        const wrap = frame?.closest('.watchfusion-frame-wrap');
        if (!wrap) return null;
        let surface = wrap.querySelector('.watchfusion-frame-loading');
        if (!surface) {
            surface = document.createElement('div');
            surface.className = 'watchfusion-frame-loading';
            surface.setAttribute('role', 'status');
            surface.setAttribute('aria-live', 'polite');
            surface.innerHTML = '<span class="watchfusion-frame-loading-mark">WF</span><strong>Loading WatchFusion…</strong><span data-wf-frame-detail>Waiting for the embedded workspace to finish loading.</span><button type="button" data-wf-frame-retry>Retry</button>';
            wrap.append(surface);
        }
        if (surface.dataset.retryBound !== '1') {
            surface.querySelector('[data-wf-frame-retry]')?.addEventListener('click', () => reloadFrame(frame, true));
            surface.dataset.retryBound = '1';
        }
        return surface;
    }

    function setFrameState(frame, state, detail = '') {
        const wrap = frame?.closest('.watchfusion-frame-wrap');
        const surface = ensureLoadingSurface(frame);
        if (!wrap || !surface) return;
        wrap.dataset.frameState = state;
        const copy = surface.querySelector('[data-wf-frame-detail]');
        if (copy && detail) copy.textContent = detail;
        const retry = surface.querySelector('[data-wf-frame-retry]');
        if (retry) retry.hidden = state !== 'error';
    }

    function clearReadyTimer() {
        if (readyTimer) window.clearTimeout(readyTimer);
        readyTimer = 0;
    }

    function scheduleReadyCheck(frame) {
        const expected = syncScope(frame);
        if (!expected || expected.established || expected.finished || expected.probing || readyTimer) return;
        readyTimer = window.setTimeout(async () => {
            readyTimer = 0;
            if (!currentScope(expected) || expected.established) return;
            expected.probing = true;
            let direct = null;
            try { direct = await window.EveWatchFusionRuntimeSensor?.probe?.(expected.src); }
            catch { /* an unavailable probe never authorizes a reload */ }
            finally { expected.probing = false; }
            if (!currentScope(expected) || expected.established) return;
            const reloadLimit = autoReloadLimit();
            if (direct && reloadAttempts < reloadLimit) {
                reloadAttempts += 1;
                reloadFrame(frame);
                return;
            }
            expected.finished = true;
            const remote = exposureMode() === 'cloudflare';
            setFrameState(frame, 'error', direct
                ? (remote
                    ? 'Remote WatchFusion is online but still loading through the tunnel. The view was left intact; wait or press Retry manually.'
                    : 'The embedded view did not finish loading. Retry it here; detached WatchFusion remains available.')
                : 'Waiting for the WatchFusion runtime. The view will stay dark instead of showing a blank page.');
        }, readyTimeoutMs());
    }

    function reloadFrame(frame, manual = false) {
        const prior = syncScope(frame);
        if (!prior || (!manual && prior.established)) return false;
        let url;
        try { url = new URL(frame.src); } catch { return false; }
        if (!/^https?:$/.test(url.protocol)) return false;
        if (manual) reloadAttempts = 0;
        url.searchParams.set('_wfReload', `${Date.now()}-${++reloadSequence}`);
        clearReadyTimer();
        scope = null;
        frame.src = url.href;
        syncScope(frame, true);
        scheduleReadyCheck(frame);
        return true;
    }

    function bindFrame(frame) {
        if (frame === activeFrame) return;
        frameObserver?.disconnect();
        clearReadyTimer(); scope = null; lastHeartbeat = 0;
        activeFrame = frame;
        reloadAttempts = 0;
        ensureLoadingSurface(frame);
        frame.addEventListener('load', () => { if (frame === activeFrame) scheduleReadyCheck(frame); });
        frame.addEventListener('error', () => {
            if (frame !== activeFrame) return;
            const current = syncScope(frame);
            if (current?.established) connectivity(frame, true);
            else if (current) { clearReadyTimer(); current.finished = true; setFrameState(frame, 'error', 'The embedded view could not load.'); }
        });
        frameObserver = new MutationObserver(() => { if (frame === activeFrame) patchFrame(frame); });
        frameObserver.observe(frame, { attributes: true, attributeFilter: ['hidden', 'src'] });
    }

    function patchFrame(candidate = null) {
        const frame = candidate?.matches?.('#watchfusion-overlay .watchfusion-frame')
            ? candidate
            : document.querySelector('#watchfusion-overlay .watchfusion-frame');
        if (!frame) return false;
        bindFrame(frame);
        const values = (frame.getAttribute('allow') || '')
            .split(';')
            .map(value => value.trim())
            .filter(Boolean);
        const seen = new Set(values.map(value => value.toLowerCase()));
        for (const feature of REQUIRED) {
            if (!seen.has(feature)) values.push(feature);
        }
        const allow = values.join('; ');
        if (frame.getAttribute('allow') !== allow) frame.setAttribute('allow', allow);
        const current = syncScope(frame);
        if (current?.established) {
            setFrameState(frame, 'ready');
            connectivity(frame, Date.now() - lastHeartbeat > HEARTBEAT_TTL_MS);
        } else if (current) scheduleReadyCheck(frame);
        return true;
    }

    // Consume the actual message from this iframe, never a cached global presence
    // event (which may refer to a previous navigation or another window).
    window.addEventListener('message', event => {
        const data = event.data, frame = activeFrame;
        if (!frame || !event.source || event.source !== frame.contentWindow || data?.source !== 'WatchFusion' || data.version !== 1 || data.type !== 'watchfusion:embedded-presence') return;
        const current = syncScope(frame), now = Date.now();
        if (!current || !Number.isFinite(data.time) || data.time < current.since || data.time > now + 1000 || now - data.time > HEARTBEAT_TTL_MS) return;
        try {
            const expected = new URL(current.src), actual = new URL(data.url);
            if (event.origin !== expected.origin || actual.origin !== expected.origin || actual.searchParams.get('_wfReload') !== expected.searchParams.get('_wfReload') || !window.EveWatchFusionRuntimeSensor?.isCandidateOrigin?.(event.origin)) return;
        } catch { return; }
        current.established = true;
        lastHeartbeat = now;
        clearReadyTimer();
        setFrameState(frame, 'ready');
        connectivity(frame, false);
    });

    window.addEventListener('eve:watchfusion-presence', () => {
        const current = syncScope(activeFrame);
        if (current?.established) {
            setFrameState(activeFrame, 'ready');
            connectivity(activeFrame, Date.now() - lastHeartbeat > HEARTBEAT_TTL_MS);
        }
    });

    // WatchFusion already emits this after ensureOverlay()/renderStatus(). Binding on that
    // lifecycle edge avoids watching the entire EveOS document while Gemini or other workspaces
    // mount. Custom DOM events work identically from http(s) and file:// EveOS pages.
    window.addEventListener('eve:watchfusion-status', () => patchFrame());

    // LAN/remote transport is never filesystem authority. Only the known host view
    // may ask the existing local control plane to open a fixed extension package.
    window.addEventListener('message', async event => {
        const data = event.data;
        if (data?.type !== 'watchfusion:extension-folder') return;
        const embedded = document.querySelector('#watchfusion-overlay .watchfusion-frame')?.contentWindow;
        const detached = window.EveWatchFusion?.getDetachedWindow?.();
        if (!event.source || (event.source !== embedded && event.source !== detached)
            || !window.EveWatchFusionRuntimeSensor?.isCandidateOrigin?.(event.origin)
            || !['official', 'watchfusion'].includes(data.package) || typeof data.requestId !== 'string') return;
        let result;
        try {
            const base = window.EveOSLocalControl?.baseUrl?.()
                || `http://127.0.0.1:${window.EveOSPortRegistry.get('GEMINI_CONTROL_PORT')}`;
            const response = await fetch(`${base}/api/watchfusion/extension`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ package: data.package }), signal: AbortSignal.timeout(18000)
            });
            result = await response.json();
            if (!response.ok) throw new Error(result.message || 'Could not open extension folder.');
        } catch (error) { result = { ok: false, message: error.message }; }
        event.source.postMessage({ type: 'watchfusion:extension-folder-result', requestId: data.requestId, ...result }, event.origin);
    });

    window.EveWatchFusionFrameCapabilities = Object.freeze({
        established() { return Boolean(currentScope(scope) && scope.established); },
        reload(manual = true) {
            if (!activeFrame || activeFrame.hidden || !/^https?:/i.test(activeFrame.src || '')) return false;
            return reloadFrame(activeFrame, manual);
        },
        refresh() {
            return patchFrame();
        }
    });

    // Covers the opposite load order (WatchFusion overlay already exists before this companion).
    // Otherwise eve:watchfusion-status binds it when WatchFusion is opened/refreshed.
    patchFrame();
})();
