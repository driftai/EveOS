(function () {
    'use strict';

    if (window.__eveWatchFusionFrameCapabilitiesReady) return;
    window.__eveWatchFusionFrameCapabilitiesReady = true;

    const REQUIRED = ['autoplay', 'encrypted-media', 'fullscreen', 'picture-in-picture', 'web-share', 'webgpu'];
    const READY_TIMEOUT_MS = 6500;
    let activeFrame = null;
    let frameObserver = null;
    let readyTimer = 0;
    let reloadAttempts = 0;

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
            surface.querySelector('[data-wf-frame-retry]')?.addEventListener('click', () => reloadFrame(frame, true));
            wrap.append(surface);
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
        clearReadyTimer();
        if (!frame || frame.hidden || !/^https?:/i.test(frame.src || '')) return;
        readyTimer = window.setTimeout(async () => {
            readyTimer = 0;
            if (frame !== activeFrame || frame.hidden) return;
            const direct = await window.EveWatchFusionRuntimeSensor?.probe?.(frame.src);
            if (direct && reloadAttempts < 2) {
                reloadAttempts += 1;
                setFrameState(frame, 'loading', `The runtime is online. Retrying the embedded view (${reloadAttempts}/2)…`);
                reloadFrame(frame);
                return;
            }
            setFrameState(frame, 'error', direct
                ? 'The embedded view did not finish loading. Retry it here; detached WatchFusion remains available.'
                : 'Waiting for the WatchFusion runtime. The view will stay dark instead of showing a blank page.');
        }, READY_TIMEOUT_MS);
    }

    function reloadFrame(frame, manual = false) {
        if (!frame || frame.hidden) return;
        if (manual) reloadAttempts = 0;
        let url;
        try { url = new URL(frame.src); } catch { return; }
        if (!/^https?:$/.test(url.protocol)) return;
        url.searchParams.set('_wfReload', String(Date.now()));
        setFrameState(frame, 'loading', 'Reloading the embedded WatchFusion workspace…');
        frame.src = url.href;
        scheduleReadyCheck(frame);
    }

    function bindFrame(frame) {
        if (frame === activeFrame) return;
        frameObserver?.disconnect();
        activeFrame = frame;
        reloadAttempts = 0;
        ensureLoadingSurface(frame);
        frame.addEventListener('load', () => scheduleReadyCheck(frame));
        frame.addEventListener('error', () => setFrameState(frame, 'error', 'The embedded view could not load.'));
        frameObserver = new MutationObserver(() => patchFrame());
        frameObserver.observe(frame, { attributes: true, attributeFilter: ['hidden', 'src'] });
    }

    function patchFrame() {
        const frame = document.querySelector('#watchfusion-overlay .watchfusion-frame');
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
        frame.setAttribute('allow', values.join('; '));
        if (!frame.hidden && /^https?:/i.test(frame.src || '')) {
            const wrap = frame.closest('.watchfusion-frame-wrap');
            if (wrap?.dataset.frameState !== 'ready') {
                setFrameState(frame, 'loading');
                scheduleReadyCheck(frame);
            }
        }
        return true;
    }

    window.addEventListener('eve:watchfusion-presence', (event) => {
        if (!activeFrame) return;
        if (event.detail?.embedded === true) {
            reloadAttempts = 0;
            clearReadyTimer();
            setFrameState(activeFrame, 'ready');
            return;
        }
        const wrap = activeFrame.closest('.watchfusion-frame-wrap');
        if (!activeFrame.hidden && wrap?.dataset.frameState === 'ready') {
            setFrameState(activeFrame, 'loading', 'The embedded workspace stopped responding. Reconnecting…');
            scheduleReadyCheck(activeFrame);
        }
    });

    const observer = new MutationObserver(() => patchFrame());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    patchFrame();
})();
