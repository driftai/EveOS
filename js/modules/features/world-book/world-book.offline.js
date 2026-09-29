window.EveWorldBook = window.EveWorldBook || {};

(function (ns) {
    'use strict';

    function shell(view) {
        const portal = view === 'portal';
        const tabs = portal
            ? ['Portal map', 'Connections', 'Reader routes', 'Canon links']
            : ['Live files', 'World Book', 'Tags', 'Integrity', 'Imports'];
        const actions = portal
            ? ['Open world map', 'Manage portals', 'Connected lore', 'Reader library']
            : ['New folder', 'New text file', 'Smart collection', 'Focus', 'Theme', 'Reader library', 'World Portal', 'Eve Injection', 'Backup & Restore', 'Import JSON'];
        return `
            <div class="notes-world-book-offline-shell" data-world-book-offline-shell="${view}">
                <div class="notes-world-book-offline-brand">
                    <span class="notes-world-book-offline-mark">W</span>
                    <div><strong>${portal ? 'World Portal' : 'World Book'}</strong><small>Offline shell · server-backed actions are visible but unavailable</small></div>
                </div>
                <div class="notes-world-book-offline-workspace">
                    <label>Workspace</label>
                    <input value="Local workspace reconnects when World Book starts" disabled>
                    <button type="button" disabled>Mount path</button>
                    <button type="button" disabled>Refresh</button>
                </div>
                <div class="notes-world-book-offline-actions">
                    ${actions.map(label => `<button type="button" disabled title="Requires the World Book server">${label}</button>`).join('')}
                </div>
                <div class="notes-world-book-offline-tabs">
                    ${tabs.map((label, index) => `<span class="${index === 0 ? 'is-active' : ''}">${label}</span>`).join('')}
                </div>
                <div class="notes-world-book-offline-preview">
                    <aside>
                        <strong>${portal ? 'Portal index' : 'Workspace tree'}</strong>
                        <span>Server-backed files and lore appear here when connected.</span>
                    </aside>
                    <section>
                        <strong>${portal ? 'Portal content is preserved' : 'Your local scratchpad stays available'}</strong>
                        <p>${portal
                            ? 'World Portal needs the World Book runtime for its graph, links, and live file state. The shell stays visible so the feature does not disappear when the server is off.'
                            : 'Notes do not need localhost. Use the Scratchpad now; start World Book only when you need mounted files, tags, links, integrity, imports, or Eve Injection.'}</p>
                        <div class="notes-world-book-offline-cta">
                            <button type="button" data-world-book-offline-start>Start World Book</button>
                            <button type="button" data-world-book-open-notes>Open Scratchpad</button>
                        </div>
                    </section>
                </div>
            </div>`;
    }

    function setServerState(overlay, running) {
        if (!overlay) return;
        overlay.querySelectorAll('[data-world-book-needs-server]').forEach(button => {
            button.disabled = !running;
            button.setAttribute('aria-disabled', running ? 'false' : 'true');
        });
    }

    function updateNotesMeta(overlay, value) {
        if (!overlay) return;
        const text = String(value || '');
        const words = text.trim() ? text.trim().split(/\s+/).length : 0;
        const meta = overlay.querySelector('[data-world-book-notes-meta]');
        if (meta) meta.textContent = `Offline-ready · ${words.toLocaleString()} words · ${text.length.toLocaleString()} characters`;
    }

    async function copyNotes(overlay) {
        const editor = overlay?.querySelector('[data-world-book-notes]');
        if (!editor) return;
        let copied = false;
        try {
            await navigator.clipboard.writeText(editor.value || '');
            copied = true;
        } catch {
            const start = editor.selectionStart, end = editor.selectionEnd;
            try {
                editor.focus({ preventScroll: true });
                editor.select();
                copied = document.execCommand?.('copy') === true;
            } catch {}
            try { editor.setSelectionRange(start, end); } catch {}
        }
        const meta = overlay.querySelector('[data-world-book-notes-meta]');
        if (meta) meta.textContent = copied ? 'Copied to clipboard' : 'Clipboard unavailable — use Download .txt';
    }

    function downloadNotes(overlay) {
        const editor = overlay?.querySelector('[data-world-book-notes]');
        if (!editor) return;
        const blob = new Blob([editor.value || ''], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'EveOS-Scratchpad.txt';
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function bind(overlay, callbacks = {}) {
        if (!overlay || overlay.dataset.worldBookOfflineBound === '1') return;
        overlay.dataset.worldBookOfflineBound = '1';
        overlay.addEventListener('click', event => {
            const target = event.target.closest?.('[data-world-book-open-notes], [data-world-book-notes-copy], [data-world-book-notes-download]');
            if (!target) return;
            if (target.hasAttribute('data-world-book-open-notes')) callbacks.onNotes?.();
            else if (target.hasAttribute('data-world-book-notes-copy')) void copyNotes(overlay);
            else if (target.hasAttribute('data-world-book-notes-download')) downloadNotes(overlay);
        });
    }

    ns.offline = Object.freeze({ shell, setServerState, updateNotesMeta, bind });
})(window.EveWorldBook);
