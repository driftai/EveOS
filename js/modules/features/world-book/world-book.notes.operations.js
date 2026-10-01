window.EveWorldBook = window.EveWorldBook || {};

(function (ns) {
    'use strict';

    let overlay = null;
    const workspace = () => ns.notesWorkspace;
    const context = () => workspace()?.context?.() || {};

    async function requestText(message, value = '') {
        return typeof window.showPrompt === 'function' ? window.showPrompt(message, value) : null;
    }

    async function searchAll() {
        const query = String(overlay.querySelector('[data-eve-notes-filter]')?.value || '').trim();
        if (!query) return workspace().status('Enter a search query first.', 'error');
        const { rootId } = context();
        try {
            workspace().status('Searching this Notes root…');
            const payload = await ns.notesClient.search(rootId, query);
            workspace().showEntries(payload.entries, `${payload.entries.length} result${payload.entries.length === 1 ? '' : 's'} across this root${payload.truncated ? ' (limited)' : ''}.`);
        } catch (error) { workspace().status(error.message, 'error'); }
    }

    async function showCollection(kind) {
        try {
            const payload = await ns.notesClient.collection(kind);
            workspace().showEntries(payload.entries, `${payload.entries.length} ${kind} note${payload.entries.length === 1 ? '' : 's'}.`);
        } catch (error) { workspace().status(error.message, 'error'); }
    }

    function closeRelated() { overlay.querySelector('[data-eve-notes-related-panel]')?.remove(); }

    async function showRelated() {
        const { opened } = context();
        if (!opened?.noteRef) return;
        try {
            const payload = await ns.notesClient.related(opened.noteRef);
            closeRelated();
            const panel = document.createElement('section');
            panel.className = 'eve-notes-related-panel';
            panel.dataset.eveNotesRelatedPanel = '1';
            const heading = document.createElement('strong');
            heading.textContent = 'Linked notes & backlinks';
            const close = document.createElement('button');
            close.type = 'button'; close.textContent = 'Close'; close.addEventListener('click', closeRelated);
            panel.append(heading, close);
            if (!payload.entries.length) panel.append(document.createTextNode(' No linked notes yet.'));
            payload.entries.forEach(entry => {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = entry.broken ? `Broken · ${entry.noteRef}` : entry.name;
                button.disabled = entry.broken === true;
                button.addEventListener('click', async () => {
                    if (entry.rootId !== context().rootId) {
                        await navigator.clipboard?.writeText?.(entry.noteRef);
                        workspace().status('Cross-root link copied. Switch roots to open it.', 'success');
                    } else await workspace().openEntry(entry.path, 'file');
                    closeRelated();
                });
                panel.append(button);
            });
            overlay.querySelector('.eve-notes-editor-pane')?.append(panel);
        } catch (error) { workspace().status(error.message, 'error'); }
    }

    async function renameEntry() {
        const { opened } = context();
        if (!opened || !(await workspace().canLeave())) return;
        const name = await requestText('New note name:', opened.name);
        if (!name || name === opened.name) return;
        try {
            const payload = await ns.notesClient.rename(opened.rootId, opened.path, name, opened.revision);
            workspace().clearEditor(payload.message);
            await workspace().refreshList();
        } catch (error) { workspace().status(error.message, 'error'); }
    }

    async function moveEntry() {
        const { opened } = context();
        if (!opened || !(await workspace().canLeave())) return;
        const destination = await requestText('Move into which folder path? Use blank for the root:', '');
        if (destination == null) return;
        try {
            const payload = await ns.notesClient.move(opened.rootId, opened.path, destination, opened.revision);
            workspace().clearEditor(payload.message);
            await workspace().refreshList();
        } catch (error) { workspace().status(error.message, 'error'); }
    }

    async function deleteEntry() {
        const { opened } = context();
        if (!opened || !(await workspace().canLeave())) return;
        const confirmation = await requestText(`Type "${opened.name}" to delete it. EveOS creates a recovery copy first:`, '');
        if (confirmation == null) return;
        try {
            const payload = await ns.notesClient.delete(opened.rootId, opened.path, confirmation, opened.revision);
            workspace().clearEditor(payload.message);
            await workspace().refreshList();
        } catch (error) { workspace().status(error.message, 'error'); }
    }

    function bind(target) {
        overlay = target;
        if (!overlay || overlay.dataset.notesOperationsBound === '1') return;
        overlay.dataset.notesOperationsBound = '1';
        overlay.addEventListener('click', event => {
            if (event.target.closest?.('[data-eve-notes-search-all]')) void searchAll();
            else if (event.target.closest?.('[data-eve-notes-collection]')) void showCollection(event.target.closest('[data-eve-notes-collection]').dataset.eveNotesCollection);
            else if (event.target.closest?.('[data-eve-notes-related]')) void showRelated();
            else if (event.target.closest?.('[data-eve-notes-rename]')) void renameEntry();
            else if (event.target.closest?.('[data-eve-notes-move]')) void moveEntry();
            else if (event.target.closest?.('[data-eve-notes-delete]')) void deleteEntry();
        });
    }

    ns.notesOperations = Object.freeze({ bind });
})(window.EveWorldBook);
