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

    const observer = new MutationObserver(() => scan());
    const start = () => {
        scan();
        observer.observe(document.documentElement, { childList: true, subtree: true });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }

    Object.assign(ns, { ready: true, ids: IDS, scan, portal });
})(window.EveGeminiAgenticDialogPortal);
