window.EveGeminiAgenticDialogPortal = window.EveGeminiAgenticDialogPortal || {};

(function (ns) {
    'use strict';
    if (ns.ready) return;

    const IDS = Object.freeze([
        'audioSettingsDialog',
        'selfTalkSettingsDialog',
        'screenCaptureSettingsDialog',
        'sessionControlsDialog'
    ]);

    function portal(dialog) {
        if (!dialog || dialog.parentElement === document.body) return false;
        document.body.appendChild(dialog);
        return true;
    }

    function scan(root = document) {
        let moved = 0;
        IDS.forEach(id => {
            const dialog = root.getElementById?.(id) || document.getElementById(id);
            if (portal(dialog)) moved++;
        });
        return moved;
    }

    function start() {
        scan();
    }

    // Gemini HTML components are mounted asynchronously. Scan at explicit component
    // lifecycle boundaries rather than rescanning the entire EveOS document for every
    // unrelated subtree mutation during workspace startup.
    window.addEventListener('eve:gemini-workspace-ready', scan);
    window.addEventListener('eve:gemini-agentic-ui-refresh', scan);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }

    Object.assign(ns, { ready: true, ids: IDS, scan, portal });
})(window.EveGeminiAgenticDialogPortal);