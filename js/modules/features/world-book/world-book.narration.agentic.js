window.EveWorldBookNarrationAgentic = window.EveWorldBookNarrationAgentic || {};

(function (ns) {
    'use strict';
    if (ns.ready) return;

    const FIELD = 'browserVoice';
    let observer = null;

    function bridge() {
        return window.EveWorldBookNarrationBridge;
    }

    function voices() {
        return window.speechSynthesis?.getVoices?.() || [];
    }

    function fill(select) {
        if (!select) return;
        const selected = bridge()?.settings?.().browserVoice || '';
        select.replaceChildren(new Option('Browser default', ''));
        voices().forEach(voice => select.append(new Option(`${voice.name} (${voice.lang})`, voice.voiceURI)));
        select.value = selected;
        if (select.value !== selected && select.options.length) select.selectedIndex = 0;
    }

    function attach(dialog) {
        if (!dialog || dialog.dataset.browserTtsVoiceBound === '1') return false;
        const grid = dialog.querySelector('.gemini-narration-settings-grid');
        if (!grid) return false;

        const label = document.createElement('label');
        const title = document.createElement('span');
        const select = document.createElement('select');
        title.textContent = 'Browser TTS voice (shared)';
        select.dataset.narrationField = FIELD;
        select.dataset.narrationBrowserVoice = '';
        select.setAttribute('aria-label', 'Shared Browser TTS voice');
        label.append(title, select);
        const geminiVoice = grid.querySelector('[data-narration-field="geminiVoice"]')?.closest('label');
        if (geminiVoice) grid.insertBefore(label, geminiVoice);
        else grid.append(label);
        fill(select);
        select.addEventListener('change', () => bridge()?.saveSettings?.({ browserVoice: select.value }));
        dialog.dataset.browserTtsVoiceBound = '1';
        return true;
    }

    function sync() {
        const dialog = document.getElementById('world-book-narration-settings-dialog');
        if (!dialog) return false;
        attach(dialog);
        fill(dialog.querySelector('[data-narration-browser-voice]'));
        return true;
    }

    function start() {
        if (sync() || observer) return;
        observer = new MutationObserver(() => {
            if (sync()) {
                observer.disconnect();
                observer = null;
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    window.speechSynthesis?.addEventListener?.('voiceschanged', sync);
    window.addEventListener('eve:world-book-narration-settings', sync);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();

    Object.assign(ns, { ready: true, attach, sync });
})(window.EveWorldBookNarrationAgentic);
