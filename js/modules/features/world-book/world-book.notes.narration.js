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
                meta.textContent = 'Reader connected · using the current Scratchpad text';
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

    ns.notesNarration = Object.freeze({ readAloud });
})(window.EveWorldBook);
