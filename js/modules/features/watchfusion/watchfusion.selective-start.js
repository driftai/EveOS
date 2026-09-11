(function () {
    'use strict';

    if (window.__eveWatchFusionSelectiveStartReady) return;
    window.__eveWatchFusionSelectiveStartReady = true;

    let selecting = false;
    let pollTimer = 0;
    let pollDeadline = 0;

    function controlBase() {
        if (window.EveOSLocalControl?.baseUrl) return window.EveOSLocalControl.baseUrl();
        const port = Number(window.config?.bridges?.localControlPort
            || window.config?.bridges?.geminiControlPort) || 9082;
        return `http://127.0.0.1:${port}`;
    }

    function patchUi(message) {
        const overlay = document.getElementById('watchfusion-overlay');
        if (!overlay) return;
        const text = overlay.querySelector('[data-wf-message]');
        if (text && message) text.textContent = message;
        overlay.querySelectorAll('[data-wf-action="start"]').forEach((button) => {
            button.disabled = selecting;
            if (selecting) {
                if (!button.dataset.eveStartLabel) button.dataset.eveStartLabel = button.textContent || 'Start WatchFusion';
                button.textContent = 'Choose mode in terminal…';
            } else if (button.dataset.eveStartLabel) {
                button.textContent = button.dataset.eveStartLabel;
                delete button.dataset.eveStartLabel;
            }
        });
    }

    async function json(url, options, timeoutMs = 8000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { cache: 'no-store', ...options, signal: controller.signal });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.message || payload.error || `WatchFusion request failed (${response.status})`);
            return payload;
        } finally {
            clearTimeout(timer);
        }
    }

    function stopPolling() {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = 0;
    }

    async function poll() {
        stopPolling();
        if (!selecting) return;
        try {
            const status = await json(`${controlBase()}/api/watchfusion/status`, null, 2500);
            if (status.running === true) {
                selecting = false;
                patchUi(status.message || `WatchFusion is online in ${status.exposureMode || 'local'} mode.`);
                await window.EveWatchFusion?.refresh?.();
                return;
            }
        } catch (_) {}
        if (Date.now() >= pollDeadline) {
            selecting = false;
            patchUi('No WatchFusion runtime was detected yet. Press Start again when you are ready to choose a mode.');
            return;
        }
        pollTimer = setTimeout(poll, 900);
    }

    async function launch() {
        if (selecting) return;
        selecting = true;
        pollDeadline = Date.now() + 90_000;
        patchUi('Opening WatchFusion selective boot… choose Localhost, LAN, or Cloudflare Remote in the terminal.');
        try {
            await window.EveOSLocalControl?.ensure?.({ timeoutMs: 45_000 });
            const payload = await json(`${controlBase()}/api/watchfusion/launch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
            }, 10_000);
            patchUi(payload.message || 'Choose WatchFusion exposure mode in the opened terminal.');
            void poll();
        } catch (error) {
            selecting = false;
            patchUi(error?.message || 'WatchFusion selective boot could not be opened.');
        }
    }

    document.addEventListener('click', (event) => {
        const button = event.target?.closest?.('#watchfusion-overlay [data-wf-action="start"]');
        if (!button) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void launch();
    }, true);
})();
