(function () {
    'use strict';
    if (window.__eveWatchFusionModeSelectReady) return;
    window.__eveWatchFusionModeSelectReady = true;

    const labels = Object.freeze({ local: 'Local', lan: 'LAN', cloudflare: 'Remote' });
    let switching = false;
    let targetMode = '';
    let pollTimer = 0;
    let pollDeadline = 0;

    function controlBase() {
        if (window.EveOSLocalControl?.baseUrl) return window.EveOSLocalControl.baseUrl();
        const port = Number(window.config?.bridges?.localControlPort
            || window.config?.bridges?.geminiControlPort) || 9082;
        return `http://127.0.0.1:${port}`;
    }

    async function json(path, options = {}, timeoutMs = 10000) {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(`${controlBase()}${path}`, {
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
                ...options,
                signal: controller.signal
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.message || payload.error || `WatchFusion request failed (${response.status})`);
            return payload;
        } finally {
            window.clearTimeout(timer);
        }
    }

    function ensureSelect() {
        const actions = document.querySelector('#watchfusion-overlay .watchfusion-head-actions');
        if (!actions) return null;
        let select = actions.querySelector('[data-wf-mode]');
        if (select) return select;
        select = document.createElement('select');
        select.className = 'watchfusion-status';
        select.dataset.wfMode = '1';
        select.setAttribute('aria-label', 'WatchFusion exposure mode');
        for (const [value, label] of Object.entries(labels)) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            select.append(option);
        }
        select.addEventListener('change', () => void switchMode(select.value));
        const badge = actions.querySelector('[data-wf-status]');
        actions.insertBefore(select, badge || actions.firstChild);
        return select;
    }

    function sync(snapshot = {}) {
        const select = ensureSelect();
        if (!select) return;
        const desired = snapshot.exposurePending
            ? snapshot.requestedExposureMode
            : snapshot.exposureMode;
        if (labels[desired] && document.activeElement !== select) select.value = desired;
        select.disabled = switching || snapshot.controlPortCurrent === false || snapshot.setupRequired === true;
        const chosen = labels[targetMode || desired || select.value] || 'selected';
        select.title = switching
            ? `Restarting WatchFusion in ${chosen} mode…`
            : 'Change exposure mode · WatchFusion restarts in the selected mode';
    }

    function patchMessage(message) {
        const text = document.querySelector('#watchfusion-overlay [data-wf-message]');
        if (text && message) text.textContent = message;
    }

    function stopPolling() {
        if (pollTimer) window.clearTimeout(pollTimer);
        pollTimer = 0;
    }

    async function poll() {
        stopPolling();
        if (!switching) return;
        try {
            const snapshot = await json('/api/watchfusion/status', {}, 3000);
            sync(snapshot);
            if (snapshot.running === true && snapshot.exposureMode === targetMode) {
                switching = false;
                const reached = targetMode;
                targetMode = '';
                sync(snapshot);
                patchMessage(snapshot.message || `WatchFusion is online in ${labels[reached]} mode.`);
                await window.EveWatchFusion?.refresh?.();
                return;
            }
        } catch (_) {}
        if (Date.now() >= pollDeadline) {
            switching = false;
            patchMessage('WatchFusion mode switch is still starting. Status will keep refreshing automatically.');
            sync(window.EveWatchFusion?.getState?.() || {});
            return;
        }
        pollTimer = window.setTimeout(poll, 1000);
    }

    async function switchMode(mode) {
        mode = String(mode || '').toLowerCase();
        if (switching || !labels[mode]) return;
        switching = true;
        targetMode = mode;
        pollDeadline = Date.now() + 150000;
        sync(window.EveWatchFusion?.getState?.() || {});
        patchMessage(`Restarting WatchFusion in ${labels[mode]} mode…`);
        try {
            await window.EveOSLocalControl?.ensure?.({ timeoutMs: 45000 });
            const payload = await json('/api/watchfusion/mode', {
                method: 'POST',
                body: JSON.stringify({ mode })
            }, 15000);
            sync(payload);
            patchMessage(payload.message);
            void poll();
        } catch (error) {
            switching = false;
            targetMode = '';
            patchMessage(error?.message || 'WatchFusion mode switch failed.');
            sync(window.EveWatchFusion?.getState?.() || {});
        }
    }

    window.addEventListener('eve:watchfusion-status', event => sync(event.detail || {}));
    window.addEventListener('beforeunload', stopPolling);
})();
