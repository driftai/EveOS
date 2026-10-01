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
                        <nav class="eve-notes-tabs" aria-label="Notes workspaces">
                            <button type="button" data-eve-notes-mode="scratchpad">Scratchpad</button>
                            <button type="button" data-eve-notes-mode="files">Notepad files</button>
                            <button type="button" data-eve-notes-mode="spatial">Spatial Notes</button>
                        </nav>
                        <section class="eve-notes-scratchpad" data-eve-notes-panel="scratchpad">
                            <div class="notes-world-book-notes-heading">
                                <div><span>Scratchpad</span><small data-world-book-notes-meta>Offline-ready</small></div>
                                <div class="notes-world-book-notes-tools">
                                    <button type="button" data-world-book-notes-read
                                        title="Read the current Scratchpad with EveOS Reader; Gemini Link is used directly when the Reader engine is Gemini">Read aloud</button>
                                    <button type="button" data-eve-notes-dictate>Dictate</button>
                                    <button type="button" data-world-book-notes-copy>Copy</button>
                                    <button type="button" data-world-book-notes-download>Download .txt</button>
                                </div>
                            </div>
                            <textarea data-world-book-notes spellcheck="true"
                                placeholder="Write notes, fragments, reminders, and working context here. This scratchpad works without localhost."></textarea>
                        </section>
                        <section class="eve-notes-workspace" data-eve-notes-panel="workspace">
                            <div class="eve-notes-sourcebar">
                                <span class="eve-notes-service-pill" data-notes-service-pill data-state="checking">Notes checking</span>
                                <button type="button" data-notes-service-toggle>Start Notes</button>
                                <button type="button" data-eve-notes-collection="favorites">Favorites</button>
                                <button type="button" data-eve-notes-collection="recent">Recent</button>
                                <select data-eve-notes-root aria-label="Tracked note location"></select>
                                <label class="eve-notes-md-toggle"><input type="checkbox" data-eve-notes-markdown> Show .md</label>
                                <button type="button" data-eve-notes-refresh>Refresh</button>
                                <button type="button" data-eve-notes-untrack>Remove path</button>
                            </div>
                            <div class="eve-notes-trackbar" data-eve-notes-external-only>
                                <input type="text" data-eve-notes-track-path placeholder="C:\\path\\to\\notes or a .txt file">
                                <button type="button" data-eve-notes-track>Track path</button>
                            </div>
                            <div class="eve-notes-spatialbar" data-eve-notes-spatial-only>
                                <button type="button" data-eve-notes-create="file">New note</button>
                                <button type="button" data-eve-notes-create="folder">New folder</button>
                                <button type="button" data-eve-notes-export>Export backup</button>
                                <button type="button" data-eve-notes-import>Import backup</button>
                                <input type="file" data-eve-notes-import-file accept=".zip,application/zip" hidden>
                                <small>Real files under EveOS/data/spatial-notes</small>
                            </div>
                            <div class="eve-notes-browser">
                                <aside class="eve-notes-list-pane">
                                    <div class="eve-notes-pathbar">
                                        <button type="button" data-eve-notes-up title="Parent folder">&#8593;</button>
                                        <span data-eve-notes-path>Workspace root</span>
                                    </div>
                                    <input type="search" data-eve-notes-filter placeholder="Filter this folder">
                                    <button type="button" data-eve-notes-search-all>Search all</button>
                                    <div class="eve-notes-list" data-eve-notes-list></div>
                                </aside>
                                <article class="eve-notes-editor-pane">
                                    <div class="eve-notes-editor-head">
                                        <div><strong data-eve-notes-title>Select a note</strong><small data-eve-notes-meta>Files stay on disk.</small></div>
                                        <div class="eve-notes-editor-actions">
                                            <button type="button" data-eve-notes-favorite disabled>&#9734; Favorite</button>
                                            <button type="button" data-eve-notes-copy-ref disabled>Copy link</button>
                                            <button type="button" data-eve-notes-link disabled>Link note</button>
                                            <button type="button" data-eve-notes-related disabled>Linked</button>
                                            <button type="button" data-eve-notes-rename disabled>Rename</button>
                                            <button type="button" data-eve-notes-move disabled>Move</button>
                                            <button type="button" class="is-danger" data-eve-notes-delete disabled>Delete</button>
                                            <button type="button" data-eve-notes-preview disabled>Preview</button>
                                            <button type="button" data-eve-notes-dictate>Dictate</button>
                                            <button type="button" data-eve-notes-revert disabled>Revert</button>
                                            <button type="button" data-eve-notes-save disabled>Save</button>
                                        </div>
                                    </div>
                                    <div class="eve-notes-formatbar">
                                        <label>Font <select data-eve-notes-font><option value="Georgia">Georgia</option><option value="Arial">Arial</option><option value="Consolas">Consolas</option><option value="system-ui">System</option></select></label>
                                        <label>Size <input type="range" min="12" max="28" value="16" data-eve-notes-font-size><span data-eve-notes-font-size-label>16px</span></label>
                                    </div>
                                    <textarea data-eve-notes-editor disabled spellcheck="true" placeholder="Choose a note from the left."></textarea>
                                    <div class="eve-notes-markdown-preview" data-eve-notes-markdown-preview hidden></div>
                                    <div class="eve-notes-status" data-eve-notes-status>Connect a path or open Spatial Notes.</div>
                                </article>
                            </div>
                        </section>
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
