window.EveWorldBook = window.EveWorldBook || {};

(function (ns) {
    'use strict';

    async function readAloud(overlay) {
        const editor = overlay?.querySelector('[data-world-book-notes]');
        const button = overlay?.querySelector('[data-world-book-notes-read]');
        const meta = overlay?.querySelector('[data-world-book-notes-meta]');
        const text = String(editor?.value || '');
        if (!text.trim()) {
            if (meta) meta.textContent = 'Nothing to read yet · type something in Scratchpad first';
            editor?.focus?.({ preventScroll: true });
            return;
        }

        // Prime WebAudio synchronously from the user's click before any network/generation await.
        const runtime = window.EveWorldBookNarrationRuntime;
        runtime?.setSourceProvider?.(() => ({
            id: 'eveos:scratchpad',
            title: 'EveOS Scratchpad',
            text: String(editor?.value || ''),
            kind: 'scratchpad',
            locator: 'EveOS / Notes / Scratchpad'
        }));
        const primePromise = runtime?.primeAudio?.();
        const priorLabel = button?.textContent || 'Read aloud';
        if (button) {
            button.disabled = true;
            button.textContent = 'Connecting...';
        }
        try {
            if (!runtime?.ready) throw new Error('The EveOS Reader runtime is unavailable.');
            const accepted = window.EveWorldBookNarrationBridge?.readSource?.({
                id: 'eveos:scratchpad',
                title: 'EveOS Scratchpad',
                text,
                kind: 'scratchpad',
                locator: 'EveOS / Notes / Scratchpad'
            }, {
                autoplay: true,
                openCompanion: true,
                local: true,
                primePromise
            });
            if (!accepted) throw new Error('The Reader bridge is unavailable.');
            const primed = await Promise.resolve(primePromise);
            if (primed && primed.ok === false && meta) {
                meta.textContent = 'Reader ready · Tap Play to enable audio';
            } else if (meta) {
                meta.textContent = 'Reader requested · preparing the current Scratchpad text';
            }
        } catch (error) {
            if (meta) meta.textContent = `Reader unavailable · ${error?.message || String(error)}`;
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = priorLabel;
            }
        }
    }

    function notifyChanged(text) {
        const runtime = window.EveWorldBookNarrationRuntime;
        const state = runtime?.getState?.();
        if (state?.source?.id !== 'eveos:scratchpad') return;
        runtime.previewSource?.(String(text || ''));
    }

    window.addEventListener('eve:world-book-narration-state', event => {
        const state = event.detail;
        if (state?.source?.id !== 'eveos:scratchpad') return;
        const meta = document.querySelector('#notes-world-book-overlay [data-world-book-notes-meta]');
        if (!meta) return;
        const route = state.output === 'native-default'
            ? 'Windows default output'
            : state.output === 'audioflix' ? 'Audioflix output' : 'browser output';
        if (state.status === 'generating') meta.textContent = `Reader generating · ${route}`;
        else if (state.status === 'playing') meta.textContent = `Reader playing · ${route}`;
        else if (state.status === 'complete') meta.textContent = `Reader finished · ${route}`;
        else if (state.status === 'blocked') meta.textContent = `Reader blocked · ${state.error || 'enable audio'}`;
        else if (state.status === 'error') meta.textContent = `Reader error · ${state.error || 'playback failed'}`;
    });

    ns.notesNarration = Object.freeze({ readAloud, notifyChanged });
})(window.EveWorldBook);
