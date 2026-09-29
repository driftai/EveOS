window.EveWorldBook = window.EveWorldBook || {};

(function (ns) {
    'use strict';

    function markup() {
        return `
            <section class="notes-world-book-shell">
                <header class="notes-world-book-header">
                    <div class="notes-world-book-identity">
                        <span class="notes-world-book-sigil" aria-hidden="true">W</span>
                        <div>
                            <strong id="notes-world-book-title">Notes &amp; World Books</strong>
                            <span data-world-book-status>Local writing and knowledge workspace</span>
                        </div>
                    </div>
                    <nav class="notes-world-book-tabs" aria-label="Notes, World Book, and World Portal views">
                        <button type="button" data-world-book-view="notes">Notes</button>
                        <button type="button" data-world-book-view="world">World Book</button>
                        <button type="button" data-world-book-view="portal">World Portal</button>
                    </nav>
                    <div class="notes-world-book-actions">
                        <span class="notes-world-book-status-pill" data-world-book-status-pill data-state="checking">Checking</span>
                        <button type="button" data-world-book-server-toggle>Start World Book</button>
                        <button type="button" data-world-book-reader-controls title="Open compact Reader controls">Reader controls</button>
                        <button type="button" data-world-book-reload data-world-book-needs-server title="Reload the active World Book view">&#8635;</button>
                        <span class="notes-world-book-detach-state" data-world-book-detach-state data-state="attached">Attached</span>
                        <button type="button" class="notes-world-book-detach"
                            data-world-book-detach data-world-book-needs-server aria-label="Detach the active view into a window"
                            title="Detach the active view into a window">
                            <span aria-hidden="true">&#8599;</span>
                            <span class="notes-world-book-detach-label">Detach</span>
                        </button>
                        <button type="button" data-world-book-fullscreen aria-pressed="false" title="Use full screen">&#x26F6;</button>
                        <button type="button" data-world-book-header-toggle title="Hide header">&#9650;</button>
                        <button type="button" data-world-book-close class="is-close">Close &times;</button>
                    </div>
                </header>
                <main class="notes-world-book-stage">
                    <button type="button" class="notes-world-book-header-restore"
                        data-world-book-header-restore title="Show header">&#9660;</button>
                    <section class="notes-world-book-notes-view" data-world-book-panel="notes">
                        <div class="notes-world-book-notes-heading">
                            <div><span>Scratchpad</span><small data-world-book-notes-meta>Offline-ready</small></div>
                            <div class="notes-world-book-notes-tools">
                                <button type="button" data-world-book-notes-read
                                    title="Read the current Scratchpad with EveOS Reader; Gemini Link is used directly when the Reader engine is Gemini">Read aloud</button>
                                <button type="button" data-world-book-notes-copy>Copy</button>
                                <button type="button" data-world-book-notes-download>Download .txt</button>
                            </div>
                        </div>
                        <textarea data-world-book-notes spellcheck="true"
                            placeholder="Write notes, fragments, reminders, and working context here. This scratchpad works without localhost."></textarea>
                    </section>
                    <section class="notes-world-book-world-view" data-world-book-panel="world">
                        <iframe data-world-book-frame src="about:blank"
                            title="World Book" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
                        <div class="notes-world-book-offline">
                            ${ns.offline?.shell?.('world') || '<button type="button" data-world-book-offline-start>Start World Book</button>'}
                        </div>
                    </section>
                    <section class="notes-world-book-portal-view" data-world-book-panel="portal">
                        <iframe data-world-portal-frame src="about:blank"
                            title="World Portal" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
                        <div class="notes-world-book-offline">
                            ${ns.offline?.shell?.('portal') || '<button type="button" data-world-book-offline-start>Start World Book</button>'}
                        </div>
                    </section>
                </main>
            </section>`;
    }

    ns.overlayTemplate = Object.freeze({ markup });
})(window.EveWorldBook);
