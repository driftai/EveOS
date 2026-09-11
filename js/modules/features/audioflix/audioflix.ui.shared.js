window.EveAudioflixUiShared = window.EveAudioflixUiShared || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixUiShared;
    if (ns.ready) return;

    const hotkeyModifiers = ['ctrl', 'control', 'alt', 'shift', 'win', 'meta', 'cmd', 'super'];

    function shuffleQueue(ids) {
        const output = [...ids];
        for (let index = output.length - 1; index > 0; index -= 1) {
            const swapIndex = Math.floor(Math.random() * (index + 1));
            [output[index], output[swapIndex]] = [output[swapIndex], output[index]];
        }
        return output;
    }

    function hotkeyComboIssue(combo) {
        const parts = String(combo || '').split('+').map((part) => part.trim().toLowerCase()).filter(Boolean);
        if (!parts.length) return null;
        const mainKeys = parts.filter((part) => !hotkeyModifiers.includes(part));
        if (mainKeys.length > 1) {
            return { invalid: true, msg: 'Two plain keys (like y+t) cannot be one hotkey - add a modifier, e.g. ctrl+y.' };
        }
        if (mainKeys.length === 0) {
            return { invalid: true, msg: 'Add a non-modifier key, e.g. ctrl+y.' };
        }
        return parts.length === 1
            ? { invalid: false, msg: 'Heads up: a lone key is grabbed globally, so a modifier combo like ctrl+y is safer.' }
            : null;
    }

    Object.assign(ns, {
        ready: true,
        shuffleQueue,
        hotkeyComboIssue,
        playSvg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
        closeSvg: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
        stopSvg: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
        layerPlaySvg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M4 4v16l10-8z"/><path d="M12 4v16l10-8z"/></svg>',
        viewSvg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/></svg>',
        cogSvg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 3.6 3.6 3.6-1.62 3.6-3.6-3.6z"/></svg>'
    });

    const base = 'js/modules/features/audioflix/';
    const load = (name, callback) => {
        const script = document.createElement('script');
        script.src = `${base}${name}`;
        script.async = false;
        if (callback) script.onload = callback;
        document.head.appendChild(script);
    };
    if (!window.EveAudioflixLibraryNext) {
        load('audioflix.library.next.js?v=4349dc649460', () => {
            window.EveAudioflixLibraryNext?.boot?.();
            load('audioflix.library.next.ui.js?v=c7e58e7f8529', () => window.EveAudioflixLibraryNextUi?.boot?.());
        });
    } else {
        window.EveAudioflixLibraryNext.boot?.();
        load('audioflix.library.next.ui.js?v=c7e58e7f8529', () => window.EveAudioflixLibraryNextUi?.boot?.());
    }
})();
