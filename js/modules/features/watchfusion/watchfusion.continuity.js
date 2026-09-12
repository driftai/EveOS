(function () {
    'use strict';

    if (window.__eveWatchFusionContinuityReady) return;
    window.__eveWatchFusionContinuityReady = true;

    const SESSION_ID = (() => {
        try {
            if (window.crypto?.randomUUID) return window.crypto.randomUUID();
            const bytes = new Uint8Array(16);
            window.crypto?.getRandomValues?.(bytes);
            if (bytes.some(Boolean)) return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
        } catch {}
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    })();

    const RELAY_TYPES = new Set([
        'watchfusion:continuity-request',
        'watchfusion:continuity-handoff',
        'watchfusion:continuity-applied',
        'watchfusion:continuity-failed'
    ]);
    let embeddedWindow = null;
    let embeddedOrigin = '';
    let detachedWindow = null;
    let detachedOrigin = '';
    let ownerRole = 'embedded';

    function frameWindow() {
        return document.querySelector('#watchfusion-overlay .watchfusion-frame')?.contentWindow || null;
    }

    function trustedOrigin(origin) {
        return window.EveWatchFusionRuntimeSensor?.isCandidateOrigin?.(origin) === true;
    }

    function post(target, origin, payload) {
        if (!target || !origin) return false;
        try {
            target.postMessage({
                ...payload,
                source: 'EveOS',
                version: 1,
                sessionId: SESSION_ID
            }, origin);
            return true;
        } catch {
            return false;
        }
    }

    function configure(role) {
        if (role === 'embedded') {
            post(embeddedWindow, embeddedOrigin, { type: 'watchfusion:continuity-config', role });
        } else if (role === 'detached') {
            post(detachedWindow, detachedOrigin, { type: 'watchfusion:continuity-config', role });
        }
    }

    function registerPresence(event, data) {
        if (data.type === 'watchfusion:embedded-presence') {
            const expected = frameWindow();
            if (!expected || event.source !== expected || data.embedded !== true) return false;
            embeddedWindow = event.source;
            embeddedOrigin = event.origin;
            configure('embedded');
            return true;
        }

        if (data.type === 'watchfusion:detached-presence') {
            if (data.detached !== true || data.windowName !== 'eveWatchFusionWindow') return false;
            detachedWindow = event.source;
            detachedOrigin = event.origin;
            configure('detached');
            return true;
        }
        return false;
    }

    function sourceRoleForEvent(event, data) {
        if (data.role === 'embedded' && embeddedWindow && event.source === embeddedWindow) return 'embedded';
        if (data.role === 'detached' && detachedWindow && event.source === detachedWindow) return 'detached';
        return '';
    }

    function relay(data, sourceRole) {
        let destinationRole = '';
        if (data.type === 'watchfusion:continuity-request') {
            destinationRole = sourceRole === 'embedded' ? 'detached' : 'embedded';
        } else if (data.type === 'watchfusion:continuity-handoff') {
            destinationRole = String(data.targetRole || '');
        } else if (
            data.type === 'watchfusion:continuity-applied'
            || data.type === 'watchfusion:continuity-failed'
        ) {
            destinationRole = String(data.sourceRole || '');
        }
        if (destinationRole !== 'embedded' && destinationRole !== 'detached') return false;
        if (destinationRole === sourceRole) return false;
        const target = destinationRole === 'embedded' ? embeddedWindow : detachedWindow;
        const origin = destinationRole === 'embedded' ? embeddedOrigin : detachedOrigin;
        if (!target || !origin) return false;
        return post(target, origin, {
            ...data,
            role: sourceRole
        });
    }

    function handleProtocol(event) {
        const data = event?.data;
        if (!data || data.source !== 'WatchFusion') return;
        if (!trustedOrigin(event.origin)) return;

        if (data.version === 1 && registerPresence(event, data)) return;
        if (data.version !== 2 || data.sessionId !== SESSION_ID) return;

        const sourceRole = sourceRoleForEvent(event, data);
        if (!sourceRole) return;

        if (data.type === 'watchfusion:reattach-request' && sourceRole === 'detached') {
            ownerRole = 'embedded';
            window.EveWatchFusion?.open?.();
            return;
        }

        if (!RELAY_TYPES.has(data.type)) return;
        if (!relay(data, sourceRole)) return;

        if (data.type === 'watchfusion:continuity-applied') ownerRole = String(data.targetRole || ownerRole);
        if (data.type === 'watchfusion:continuity-failed') ownerRole = String(data.sourceRole || ownerRole);
    }

    window.addEventListener('message', handleProtocol);

    document.addEventListener('click', (event) => {
        const button = event.target.closest?.('.topbar-watchfusion-btn');
        if (!button || ownerRole !== 'detached' || !detachedWindow || detachedWindow.closed) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        try { detachedWindow.focus(); } catch {}
    }, true);

    window.EveWatchFusionContinuity = Object.freeze({
        sessionId: () => SESSION_ID,
        ownerRole: () => ownerRole,
        detachedWindow: () => detachedWindow,
        embeddedWindow: () => embeddedWindow
    });
})();
