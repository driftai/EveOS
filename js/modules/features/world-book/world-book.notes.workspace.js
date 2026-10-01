window.EveWorldBook = window.EveWorldBook || {};

(function (ns) {
    'use strict';

    const MODE_KEY = 'eveNotesWorkspaceMode';
    const MARKDOWN_KEY = 'eveNotesWorkspaceMarkdown';
    const FONT_KEY = 'eveNotesWorkspaceFont';
    const FONT_SIZE_KEY = 'eveNotesWorkspaceFontSize';
    const ROOT_KEYS = { files: 'eveNotesExternalRoot', spatial: 'eveNotesSpatialRoot' };
    let overlay = null;
    let roots = [];
    let entries = [];
    let mode = 'scratchpad';
    let currentRoot = '';
    let currentPath = '';
    let opened = null;
    let originalContent = '';
    let loading = false;

    function read(key, fallback) {
        try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
    }

    function write(key, value) {
        try { localStorage.setItem(key, String(value)); } catch {}
    }

    function one(selector) { return overlay?.querySelector(selector) || null; }

    function status(message, state = '') {
        const target = one('[data-eve-notes-status]');
        if (!target) return;
        target.textContent = message;
        target.dataset.state = state;
    }

    function isDirty() {
        const editor = one('[data-eve-notes-editor]');
        return !!opened && !!editor && editor.value !== originalContent;
    }

    async function confirmAction(message, options = {}) {
        if (typeof window.showConfirm === 'function') return window.showConfirm(message, options);
        status('Confirmation dialog is unavailable.', 'error');
        return false;
    }

    async function promptValue(message, defaultValue = '') {
        if (typeof window.showPrompt === 'function') return window.showPrompt(message, defaultValue);
        status('Input dialog is unavailable.', 'error');
        return null;
    }

    async function allowDiscard() {
        return !isDirty() || await confirmAction('Discard the unsaved changes to this note?', {
            title: 'Unsaved note',
            confirmLabel: 'Discard'
        });
    }

    function workspaceRoots() {
        return mode === 'spatial'
            ? roots.filter(root => root.id === 'spatial')
            : roots.filter(root => root.id !== 'spatial');
    }

    function applyMode() {
        overlay.dataset.eveNotesMode = mode;
        overlay.querySelectorAll('[data-eve-notes-mode]').forEach(button => {
            const active = button.dataset.eveNotesMode === mode;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }

    function clearEditor(message = 'Choose a note from the left.') {
        opened = null;
        originalContent = '';
        const editor = one('[data-eve-notes-editor]');
        if (editor) {
            editor.value = '';
            editor.disabled = true;
        }
        const title = one('[data-eve-notes-title]');
        const meta = one('[data-eve-notes-meta]');
        if (title) title.textContent = 'Select a note';
        if (meta) meta.textContent = 'Files stay on disk.';
        overlay.querySelectorAll('[data-eve-notes-favorite], [data-eve-notes-copy-ref], [data-eve-notes-link], [data-eve-notes-revert], [data-eve-notes-save]').forEach(button => { button.disabled = true; });
        status(message);
    }

    function renderRoots(preferred) {
        const select = one('[data-eve-notes-root]');
        const available = workspaceRoots();
        if (!select) return;
        select.replaceChildren();
        available.forEach(root => {
            const option = document.createElement('option');
            option.value = root.id;
            option.textContent = `${root.kind === 'folder' ? 'Folder' : 'File'} · ${root.name}${root.available === false ? ' (missing)' : ''}`;
            option.disabled = root.available === false;
            select.appendChild(option);
        });
        const saved = preferred || read(ROOT_KEYS[mode], '');
        const selected = available.find(root => root.id === saved && root.available !== false)
            || available.find(root => root.available !== false);
        currentRoot = selected?.id || '';
        select.value = currentRoot;
        const untrack = one('[data-eve-notes-untrack]');
        if (untrack) untrack.hidden = mode === 'spatial' || !currentRoot;
    }

    function renderEntries() {
        const list = one('[data-eve-notes-list]');
        if (!list) return;
        const query = String(one('[data-eve-notes-filter]')?.value || '').trim().toLowerCase();
        list.replaceChildren();
        const shown = entries.filter(entry => !query || entry.name.toLowerCase().includes(query));
        if (!shown.length) {
            const empty = document.createElement('p');
            empty.className = 'eve-notes-empty';
            empty.textContent = currentRoot ? 'No matching note files in this folder.' : 'Track a notes path to begin.';
            list.appendChild(empty);
            return;
        }
        shown.forEach(entry => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'eve-notes-entry';
            button.dataset.path = entry.path;
            button.dataset.kind = entry.kind;
            if (opened?.path === entry.path && opened?.rootId === currentRoot) button.classList.add('is-active');
            const icon = entry.kind === 'folder' ? '\uD83D\uDCC1' : entry.favorite ? '\u2605' : '\uD83D\uDCC4';
            button.textContent = `${icon} ${entry.name}`;
            const detail = document.createElement('small');
            detail.textContent = entry.kind === 'folder' ? 'Folder' : `${entry.extension.slice(1).toUpperCase()}${entry.linkCount ? ` · ${entry.linkCount} links` : ''}`;
            button.appendChild(detail);
            list.appendChild(button);
        });
    }

    async function loadList(path = currentPath) {
        if (!currentRoot || loading) {
            entries = [];
            renderEntries();
            if (!currentRoot) status(mode === 'files' ? 'Track a .txt, .md, or folder path to begin.' : 'Spatial Notes is unavailable.', mode === 'files' ? '' : 'error');
            return;
        }
        loading = true;
        status('Loading note files…');
        try {
            const includeMarkdown = one('[data-eve-notes-markdown]')?.checked === true;
            const payload = await ns.notesClient.list(currentRoot, path, includeMarkdown);
            currentPath = payload.path || '';
            entries = payload.entries || [];
            const pathLabel = one('[data-eve-notes-path]');
            if (pathLabel) pathLabel.textContent = currentPath ? currentPath.split('/').join(' › ') : 'Workspace root';
            const up = one('[data-eve-notes-up]');
            if (up) up.disabled = !currentPath;
            renderEntries();
            status(`${entries.length} item${entries.length === 1 ? '' : 's'} · changes save to the real file.`);
        } catch (error) {
            entries = [];
            renderEntries();
            status(error.message, 'error');
        } finally {
            loading = false;
        }
    }

    async function refreshWorkspace(options = {}) {
        if (mode === 'scratchpad') return;
        status('Connecting to EveOS Notes…');
        try {
            const payload = await ns.notesClient.workspace();
            roots = payload.roots || [];
            const oldRoot = options.preserve ? currentRoot : '';
            renderRoots(oldRoot);
            if (!options.preserve || oldRoot !== currentRoot) currentPath = '';
            await loadList(currentPath);
        } catch (error) {
            clearEditor(error.message);
            status(error.message, 'error');
        }
    }

    async function setMode(next) {
        if (!['scratchpad', 'files', 'spatial'].includes(next) || (next !== mode && !(await allowDiscard()))) return;
        mode = next;
        write(MODE_KEY, mode);
        applyMode();
        if (mode === 'scratchpad') return;
        clearEditor();
        currentPath = '';
        await refreshWorkspace();
    }

    async function openEntry(path, kind) {
        if (kind === 'folder') {
            if (!(await allowDiscard())) return;
            clearEditor();
            await loadList(path);
            return;
        }
        if (!(await allowDiscard())) return;
        status('Opening note…');
        try {
            const payload = await ns.notesClient.read(currentRoot, path);
            opened = { ...payload.entry, rootId: currentRoot };
            originalContent = payload.content || '';
            const editor = one('[data-eve-notes-editor]');
            editor.disabled = false;
            editor.value = originalContent;
            one('[data-eve-notes-title]').textContent = payload.entry.name;
            one('[data-eve-notes-meta]').textContent = `${payload.entry.extension.slice(1).toUpperCase()} · ${Number(payload.entry.size || 0).toLocaleString()} bytes`;
            overlay.querySelectorAll('[data-eve-notes-favorite], [data-eve-notes-copy-ref], [data-eve-notes-link], [data-eve-notes-revert], [data-eve-notes-save]').forEach(button => { button.disabled = false; });
            const favorite = one('[data-eve-notes-favorite]');
            favorite.textContent = payload.entry.favorite ? '\u2605 Favorited' : '\u2606 Favorite';
            renderEntries();
            status('Ready. Edits are protected against newer on-disk changes.');
        } catch (error) {
            clearEditor(error.message);
            status(error.message, 'error');
        }
    }

    async function saveNote() {
        if (!opened) return;
        status('Saving…');
        try {
            const editor = one('[data-eve-notes-editor]');
            const payload = await ns.notesClient.write(opened.rootId, opened.path, editor.value, opened.revision);
            opened = { ...payload.entry, rootId: opened.rootId };
            originalContent = editor.value;
            status(payload.message || 'Saved.', 'success');
            await loadList(currentPath);
        } catch (error) {
            status(error.payload?.conflict ? error.payload.message : error.message, 'error');
        }
    }

    async function trackPath() {
        const input = one('[data-eve-notes-track-path]');
        const path = String(input?.value || '').trim();
        if (!path) return status('Enter a .txt, .md, or folder path.', 'error');
        try {
            const payload = await ns.notesClient.track(path);
            input.value = '';
            await refreshWorkspace();
            renderRoots(payload.root?.id);
            currentPath = '';
            await loadList('');
            status(payload.message, 'success');
        } catch (error) { status(error.message, 'error'); }
    }

    async function removePath() {
        if (!currentRoot || mode === 'spatial') return;
        if (!(await confirmAction('Stop tracking this location? No files will be deleted.', {
            title: 'Stop tracking notes',
            confirmLabel: 'Stop tracking'
        }))) return;
        try {
            await ns.notesClient.untrack(currentRoot);
            clearEditor('Tracked location removed. No files were deleted.');
            await refreshWorkspace();
        } catch (error) { status(error.message, 'error'); }
    }

    async function createItem(kind) {
        if (!currentRoot) return;
        const label = kind === 'folder' ? 'Folder name' : 'Note name (.txt or .md)';
        const name = await promptValue(label);
        if (!name) return;
        try {
            const payload = await ns.notesClient.create(currentRoot, currentPath, name, kind);
            await loadList(currentPath);
            status(payload.message, 'success');
        } catch (error) { status(error.message, 'error'); }
    }

    async function toggleFavorite() {
        if (!opened) return;
        try {
            const payload = await ns.notesClient.favorite(opened.rootId, opened.path);
            opened.favorite = payload.favorite;
            one('[data-eve-notes-favorite]').textContent = payload.favorite ? '\u2605 Favorited' : '\u2606 Favorite';
            await loadList(currentPath);
        } catch (error) { status(error.message, 'error'); }
    }

    async function copyReference() {
        if (!opened?.noteRef) return;
        try {
            await navigator.clipboard.writeText(opened.noteRef);
            status('EveOS note link copied.', 'success');
        } catch { status(`Note link: ${opened.noteRef}`); }
    }

    async function linkNote() {
        if (!opened?.noteRef) return;
        const target = await promptValue('Paste another EveOS note link to connect it:', '');
        if (!target) return;
        try {
            const payload = await ns.notesClient.link(opened.noteRef, target.trim());
            status(`Linked to ${payload.links.length} note${payload.links.length === 1 ? '' : 's'}.`, 'success');
            await loadList(currentPath);
        } catch (error) { status(error.message, 'error'); }
    }

    function downloadBackup(payload) {
        const raw = atob(payload.base64 || '');
        const bytes = new Uint8Array(raw.length);
        for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = payload.filename || 'EveOS-Spatial-Notes.zip';
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function exportBackup() {
        try {
            status('Building Spatial Notes backup…');
            downloadBackup(await ns.notesClient.exportSpatial());
            status('Spatial Notes backup exported.', 'success');
        } catch (error) { status(error.message, 'error'); }
    }

    async function importBackup(file) {
        if (!file) return;
        try {
            status('Importing Spatial Notes backup…');
            const bytes = new Uint8Array(await file.arrayBuffer());
            let binary = '';
            for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
            const payload = await ns.notesClient.importSpatial(btoa(binary));
            await loadList(currentPath);
            status(payload.message, 'success');
        } catch (error) { status(error.message, 'error'); }
    }

    function applyFont() {
        const editor = one('[data-eve-notes-editor]');
        const font = one('[data-eve-notes-font]')?.value || 'Georgia';
        const size = Number(one('[data-eve-notes-font-size]')?.value || 16);
        if (editor) {
            editor.style.fontFamily = font;
            editor.style.fontSize = `${size}px`;
        }
        one('[data-eve-notes-font-size-label]').textContent = `${size}px`;
        write(FONT_KEY, font);
        write(FONT_SIZE_KEY, size);
    }

    function bind(target) {
        overlay = target;
        if (!overlay || overlay.dataset.eveNotesBound === '1') return;
        overlay.dataset.eveNotesBound = '1';
        mode = read(MODE_KEY, 'scratchpad');
        one('[data-eve-notes-markdown]').checked = read(MARKDOWN_KEY, '0') === '1';
        one('[data-eve-notes-font]').value = read(FONT_KEY, 'Georgia');
        one('[data-eve-notes-font-size]').value = read(FONT_SIZE_KEY, '16');
        applyFont();
        applyMode();
        overlay.addEventListener('click', event => {
            const modeButton = event.target.closest?.('[data-eve-notes-mode]');
            const entry = event.target.closest?.('[data-eve-notes-list] [data-path]');
            const create = event.target.closest?.('[data-eve-notes-create]');
            if (modeButton) void setMode(modeButton.dataset.eveNotesMode);
            else if (entry) void openEntry(entry.dataset.path, entry.dataset.kind);
            else if (event.target.closest?.('[data-eve-notes-refresh]')) void refreshWorkspace({ preserve: true });
            else if (event.target.closest?.('[data-eve-notes-track]')) void trackPath();
            else if (event.target.closest?.('[data-eve-notes-untrack]')) void removePath();
            else if (event.target.closest?.('[data-eve-notes-up]')) void loadList(currentPath.split('/').slice(0, -1).join('/'));
            else if (create) void createItem(create.dataset.eveNotesCreate);
            else if (event.target.closest?.('[data-eve-notes-save]')) void saveNote();
            else if (event.target.closest?.('[data-eve-notes-revert]')) void openEntry(opened?.path || '', 'file');
            else if (event.target.closest?.('[data-eve-notes-favorite]')) void toggleFavorite();
            else if (event.target.closest?.('[data-eve-notes-copy-ref]')) void copyReference();
            else if (event.target.closest?.('[data-eve-notes-link]')) void linkNote();
            else if (event.target.closest?.('[data-eve-notes-export]')) void exportBackup();
            else if (event.target.closest?.('[data-eve-notes-import]')) one('[data-eve-notes-import-file]').click();
        });
        one('[data-eve-notes-root]').addEventListener('change', async event => {
            if (!(await allowDiscard())) return renderRoots(currentRoot);
            currentRoot = event.target.value;
            write(ROOT_KEYS[mode], currentRoot);
            currentPath = '';
            clearEditor();
            void loadList('');
        });
        one('[data-eve-notes-markdown]').addEventListener('change', event => { write(MARKDOWN_KEY, event.target.checked ? '1' : '0'); void loadList(currentPath); });
        one('[data-eve-notes-filter]').addEventListener('input', renderEntries);
        one('[data-eve-notes-editor]').addEventListener('input', () => status(isDirty() ? 'Unsaved changes.' : 'Ready.'));
        one('[data-eve-notes-font]').addEventListener('change', applyFont);
        one('[data-eve-notes-font-size]').addEventListener('input', applyFont);
        one('[data-eve-notes-import-file]').addEventListener('change', event => { void importBackup(event.target.files?.[0]); event.target.value = ''; });
    }

    async function activate(target) {
        if (target) bind(target);
        applyMode();
        if (mode !== 'scratchpad' && !loading) await refreshWorkspace({ preserve: true });
    }

    async function resume() {
        ns.notesClient?.resetConnection?.();
        if (overlay?.classList.contains('is-open') && mode !== 'scratchpad' && !isDirty()) await refreshWorkspace({ preserve: true });
    }

    ns.notesWorkspace = Object.freeze({ bind, activate, resume });
})(window.EveWorldBook);
