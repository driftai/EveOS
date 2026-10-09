window.EveWorldBook = window.EveWorldBook || {};

(function (ns) {
    'use strict';

    const MODE_KEY = 'eveNotesWorkspaceMode';
    const MARKDOWN_KEY = 'eveNotesWorkspaceMarkdown';
    const FONT_KEY = 'eveNotesWorkspaceFont';
    const FONT_SIZE_KEY = 'eveNotesWorkspaceFontSize';
    const ROOT_KEYS = { files: 'eveNotesExternalRoot', spatial: 'eveNotesSpatialRoot' };
    const WORKSPACE_REFRESH_TTL_MS = 2500;
    let overlay = null;
    let roots = [];
    let entries = [];
    let mode = 'scratchpad';
    let currentRoot = '';
    let currentPath = '';
    let opened = null;
    let originalContent = '';
    let loading = false;
    let saveBusy = false;
    let requestGeneration = 0;
    let workspaceGeneration = 0;
    let workspaceRefreshPromise = null;
    let lastWorkspaceAt = 0;
    let statusToastTimer = 0;
    let trackBusy = false;
    let createBusy = false;

    function read(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
    function write(key, value) { try { localStorage.setItem(key, String(value)); } catch {} }
    function one(selector) { return overlay?.querySelector(selector) || null; }
    function isDirty() { const editor = one('[data-eve-notes-editor]'); return !!opened && !!editor && editor.value !== originalContent; }

    function ensureStatusToast() {
        if (!overlay) return null;
        let toast = overlay.querySelector('[data-eve-notes-status-toast]');
        if (toast) return toast;
        toast = document.createElement('div');
        toast.className = 'eve-notes-status-toast';
        toast.dataset.eveNotesStatusToast = '';
        toast.hidden = true;
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        overlay.querySelector('.notes-world-book-shell')?.appendChild(toast);
        return toast;
    }

    function status(message, state = '') {
        const target = one('[data-eve-notes-status]');
        if (target) { target.textContent = message; target.dataset.state = state; }
        const toast = ensureStatusToast();
        if (toast && (state === 'error' || state === 'success')) {
            toast.textContent = message; toast.dataset.state = state; toast.hidden = false;
            window.clearTimeout(statusToastTimer);
            statusToastTimer = window.setTimeout(() => { toast.hidden = true; }, state === 'error' ? 5000 : 2600);
        }
        overlay?.classList.toggle('has-unsaved-notes', isDirty());
    }

    async function confirmAction(message, options = {}) {
        if (typeof window.showConfirm === 'function') return window.showConfirm(message, options);
        status('Confirmation dialog is unavailable.', 'error'); return false;
    }
    async function promptValue(message, defaultValue = '') {
        if (typeof window.showPrompt === 'function') return window.showPrompt(message, defaultValue);
        status('Input dialog is unavailable.', 'error'); return null;
    }
    async function allowDiscard() {
        return !isDirty() || await confirmAction('Discard the unsaved changes to this note?', { title: 'Unsaved note', confirmLabel: 'Discard' });
    }

    function workspaceRoots() { return mode === 'spatial' ? roots.filter(root => root.id === 'spatial') : roots.filter(root => root.id !== 'spatial'); }
    function applyMode() {
        if (!overlay) return;
        overlay.dataset.eveNotesMode = mode;
        overlay.querySelectorAll('[data-eve-notes-mode]').forEach(button => {
            const active = button.dataset.eveNotesMode === mode;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }

    function setEditorButtons(disabled) { overlay?.querySelectorAll('.eve-notes-editor-actions button').forEach(button => { button.disabled = disabled; }); }
    function clearEditor(message = 'Choose a note from the left.') {
        opened = null; originalContent = '';
        const editor = one('[data-eve-notes-editor]');
        if (editor) { editor.value = ''; editor.disabled = true; }
        if (one('[data-eve-notes-title]')) one('[data-eve-notes-title]').textContent = 'Select a note';
        if (one('[data-eve-notes-meta]')) one('[data-eve-notes-meta]').textContent = 'Files stay on disk.';
        setEditorButtons(true); status(message);
    }

    function renderRoots(preferred) {
        const select = one('[data-eve-notes-root]');
        const available = workspaceRoots();
        if (!select) return;
        select.replaceChildren();
        available.forEach(root => {
            const option = document.createElement('option'); option.value = root.id;
            option.textContent = `${root.kind === 'folder' ? 'Folder' : 'File'} · ${root.name}${root.available === false ? ' (missing)' : ''}`;
            option.disabled = root.available === false; select.appendChild(option);
        });
        const saved = preferred || read(ROOT_KEYS[mode], '');
        const selected = available.find(root => root.id === saved && root.available !== false) || available.find(root => root.available !== false);
        currentRoot = selected?.id || ''; select.value = currentRoot;
        const untrack = one('[data-eve-notes-untrack]'); if (untrack) untrack.hidden = mode === 'spatial' || !currentRoot;
    }

    function renderEntries() {
        const list = one('[data-eve-notes-list]'); if (!list) return;
        const query = String(one('[data-eve-notes-filter]')?.value || '').trim().toLowerCase();
        list.replaceChildren();
        const shown = entries.filter(entry => !query || entry.name.toLowerCase().includes(query));
        if (!shown.length) {
            const empty = document.createElement('p'); empty.className = 'eve-notes-empty';
            empty.textContent = currentRoot ? 'No matching note files in this folder.' : mode === 'files' ? 'Track a notes path to begin.' : 'Spatial Notes is unavailable.';
            list.appendChild(empty); return;
        }
        shown.forEach(entry => {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'eve-notes-entry';
            Object.assign(button.dataset, { path: entry.path, kind: entry.kind, rootId: entry.rootId || currentRoot });
            button.addEventListener('click', event => { event.stopPropagation(); void (button.dataset.rootId !== currentRoot ? openReference(button.dataset.rootId, button.dataset.path) : openEntry(button.dataset.path, button.dataset.kind)); });
            if (opened?.path === entry.path && opened?.rootId === currentRoot) button.classList.add('is-active');
            button.textContent = `${entry.kind === 'folder' ? '📁' : entry.favorite ? '★' : '📄'} ${entry.name}`;
            const detail = document.createElement('small');
            detail.textContent = entry.kind === 'folder' ? 'Folder' : `${entry.extension.slice(1).toUpperCase()}${entry.linkCount ? ` · ${entry.linkCount} links` : ''}`;
            button.appendChild(detail); list.appendChild(button);
        });
    }

    async function ensureWorkspaceService({ userInitiated = false } = {}) {
        const client = ns.notesClient;
        if (!client) throw new Error('EveOS Notes client is unavailable.');
        let snapshot = await client.refresh();
        if (!snapshot.running && userInitiated) snapshot = await client.start();
        if (!snapshot.running) throw new Error(snapshot.message || 'Start Notes to use Notepad files and Spatial Notes.');
        return snapshot;
    }

    async function loadList(path = currentPath) {
        if (!currentRoot) { entries = []; renderEntries(); status(mode === 'files' ? 'Track a .txt, .md, or folder path to begin.' : 'Spatial Notes is unavailable.', mode === 'files' ? '' : 'error'); return; }
        const generation = ++requestGeneration, requestedRoot = currentRoot; loading = true; status('Loading note files…');
        try {
            const payload = await ns.notesClient.list(currentRoot, path, one('[data-eve-notes-markdown]')?.checked === true);
            if (generation !== requestGeneration || requestedRoot !== currentRoot) return;
            currentPath = payload.path || ''; entries = payload.entries || [];
            if (one('[data-eve-notes-path]')) one('[data-eve-notes-path]').textContent = currentPath ? currentPath.split('/').join(' › ') : 'Workspace root';
            if (one('[data-eve-notes-up]')) one('[data-eve-notes-up]').disabled = !currentPath;
            renderEntries(); status(`${entries.length} item${entries.length === 1 ? '' : 's'} · changes save to the real file.`);
        } catch (error) { entries = []; renderEntries(); status(error.message, 'error'); }
        finally { if (generation === requestGeneration) loading = false; }
    }

    async function runWorkspaceRefresh(options = {}) {
        const generation = ++workspaceGeneration, previousRoot = currentRoot;
        const preferredRoot = options.preferredRootId || (options.preserve ? currentRoot : '');
        status('Connecting to EveOS Notes…');
        try {
            const payload = await ns.notesClient.workspace(); if (generation !== workspaceGeneration) return;
            roots = payload.roots || []; lastWorkspaceAt = Date.now(); renderRoots(preferredRoot);
            if (!options.preserve || previousRoot !== currentRoot) currentPath = '';
            await loadList(currentPath);
        } catch (error) { clearEditor(error.message); status(error.message, 'error'); }
    }

    function refreshWorkspace(options = {}) {
        if (mode === 'scratchpad') return Promise.resolve();
        const force = options.force === true, fresh = lastWorkspaceAt > 0 && (Date.now() - lastWorkspaceAt) < WORKSPACE_REFRESH_TTL_MS;
        if (!force && workspaceRefreshPromise) return workspaceRefreshPromise;
        if (!force && fresh && roots.length) { const previousRoot = currentRoot; renderRoots(options.preferredRootId || (options.preserve ? currentRoot : '')); if (!options.preserve || previousRoot !== currentRoot) currentPath = ''; return loadList(currentPath); }
        workspaceRefreshPromise = runWorkspaceRefresh(options).finally(() => { workspaceRefreshPromise = null; }); return workspaceRefreshPromise;
    }

    async function setMode(next) {
        if (!['scratchpad', 'files', 'spatial'].includes(next) || (next !== mode && !(await allowDiscard()))) return;
        mode = next; write(MODE_KEY, mode); applyMode();
        if (mode === 'scratchpad') return;
        clearEditor(); currentPath = '';
        try { await ensureWorkspaceService({ userInitiated: true }); await refreshWorkspace({ force: true }); }
        catch (error) { status(error.message, 'error'); }
    }

    async function openEntry(path, kind) {
        if (kind === 'folder') { if (!(await allowDiscard())) return; clearEditor(); await loadList(path); return; }
        if (!(await allowDiscard())) return;
        const generation = ++requestGeneration, requestedRoot = currentRoot; status('Opening note…');
        try {
            const payload = await ns.notesClient.read(currentRoot, path); if (generation !== requestGeneration || requestedRoot !== currentRoot) return;
            opened = { ...payload.entry, rootId: currentRoot }; originalContent = payload.content || '';
            const editor = one('[data-eve-notes-editor]'); if (!editor) return;
            editor.disabled = false; editor.value = originalContent;
            one('[data-eve-notes-title]').textContent = payload.entry.name;
            one('[data-eve-notes-meta]').textContent = `${payload.entry.extension.slice(1).toUpperCase()} · ${Number(payload.entry.size || 0).toLocaleString()} bytes`;
            setEditorButtons(false);
            const favorite = one('[data-eve-notes-favorite]'); if (favorite) favorite.textContent = payload.entry.favorite ? '★ Favorited' : '☆ Favorite';
            renderEntries(); status('Ready. Edits are protected against newer on-disk changes.');
        } catch (error) { clearEditor(error.message); status(error.message, 'error'); }
    }

    async function openReference(rootId, path) {
        if (!(await allowDiscard())) return;
        mode = rootId === 'spatial' ? 'spatial' : 'files'; write(MODE_KEY, mode); applyMode(); renderRoots(rootId);
        currentPath = String(path || '').split('/').slice(0, -1).join('/'); await loadList(currentPath); await openEntry(path, 'file');
    }

    async function saveNote() {
        if (!opened || saveBusy) return;
        const editor = one('[data-eve-notes-editor]'); if (!editor) return;
        const draft = editor.value; saveBusy = true;
        const saveButton = one('[data-eve-notes-save]'); if (saveButton) saveButton.disabled = true;
        status('Saving…');
        try {
            const payload = await ns.notesClient.write(opened.rootId, opened.path, draft, opened.revision);
            opened = { ...payload.entry, rootId: opened.rootId }; originalContent = draft;
            status(payload.message || 'Saved.', 'success');
            // Refreshing the browser is secondary. A post-save refresh failure must never turn a
            // successful disk write into a false "save failed" result or discard the saved revision.
            try { await loadList(currentPath); } catch (_error) {}
        } catch (error) {
            if (error.payload?.conflict) {
                status('Disk changed. Your draft is preserved; reload only if you choose.', 'error');
                if (await confirmAction('This note changed on disk. Reload the disk version and discard your draft?', { title: 'Revision conflict', confirmLabel: 'Reload disk version' })) await openEntry(opened.path, 'file');
            } else status(error.message, 'error');
        } finally {
            saveBusy = false;
            if (saveButton) saveButton.disabled = !opened;
        }
    }

    function normalizeTrackedPath(value) {
        let path = String(value || '').trim();
        if (path.length >= 2 && ((path[0] === '"' && path.at(-1) === '"') || (path[0] === "'" && path.at(-1) === "'"))) path = path.slice(1, -1).trim();
        return path;
    }

    async function trackPath() {
        if (trackBusy) return;
        const input = one('[data-eve-notes-track-path]'), button = one('[data-eve-notes-track]'), path = normalizeTrackedPath(input?.value);
        if (!path) { status('Enter a .txt, .md, or folder path first.', 'error'); input?.focus?.(); return; }
        trackBusy = true; if (button) button.disabled = true; status('Tracking path…');
        try {
            await ensureWorkspaceService({ userInitiated: true });
            const payload = await ns.notesClient.track(path), rootId = String(payload.root?.id || ''); if (!rootId) throw new Error('Notes did not return the tracked location.');
            if (input) input.value = ''; mode = 'files'; write(MODE_KEY, mode); write(ROOT_KEYS.files, rootId); currentRoot = rootId; currentPath = ''; clearEditor(); lastWorkspaceAt = 0;
            await refreshWorkspace({ force: true, preferredRootId: rootId, preserve: true }); status(payload.message || 'Path tracked.', 'success');
        } catch (error) { status(error.message, 'error'); }
        finally { trackBusy = false; if (button) button.disabled = false; }
    }

    async function removePath() {
        if (!currentRoot || mode === 'spatial') return;
        if (!(await confirmAction('Stop tracking this location? No files will be deleted.', { title: 'Stop tracking notes', confirmLabel: 'Stop tracking' }))) return;
        try { await ns.notesClient.untrack(currentRoot); write(ROOT_KEYS.files, ''); currentRoot = ''; currentPath = ''; lastWorkspaceAt = 0; clearEditor('Tracked location removed. No files were deleted.'); await refreshWorkspace({ force: true }); }
        catch (error) { status(error.message, 'error'); }
    }

    async function createItem(kind) {
        if (createBusy) return;
        if (!currentRoot) { status(mode === 'spatial' ? 'Spatial Notes root is unavailable. Refresh Notes.' : 'Choose a tracked notes location first.', 'error'); return; }
        const requested = await promptValue(kind === 'folder' ? 'Folder name' : 'Note name (.txt or .md)'); const name = String(requested ?? '').trim(); if (!name) return;
        createBusy = true; const buttons = Array.from(overlay?.querySelectorAll('[data-eve-notes-create]') || []); buttons.forEach(button => { button.disabled = true; });
        status(kind === 'folder' ? 'Creating folder…' : 'Creating note…');
        try { const payload = await ns.notesClient.create(currentRoot, currentPath, name, kind); await loadList(currentPath); status(payload.message || (kind === 'folder' ? 'Folder created.' : 'Note created.'), 'success'); }
        catch (error) { status(error.message, 'error'); }
        finally { createBusy = false; buttons.forEach(button => { button.disabled = false; }); }
    }

    async function toggleFavorite() { if (!opened) return; try { const payload = await ns.notesClient.favorite(opened.rootId, opened.path); opened.favorite = payload.favorite; const button = one('[data-eve-notes-favorite]'); if (button) button.textContent = payload.favorite ? '★ Favorited' : '☆ Favorite'; await loadList(currentPath); } catch (error) { status(error.message, 'error'); } }
    async function copyReference() { if (!opened?.noteRef) return; try { await navigator.clipboard.writeText(opened.noteRef); status('EveOS note link copied.', 'success'); } catch { status(`Note link: ${opened.noteRef}`); } }
    async function linkNote() { if (!opened?.noteRef) return; const target = await promptValue('Paste another EveOS note link to connect it:', ''); if (!target) return; try { const payload = await ns.notesClient.link(opened.noteRef, target.trim()); status(`Linked to ${payload.links.length} note${payload.links.length === 1 ? '' : 's'}.`, 'success'); await loadList(currentPath); } catch (error) { status(error.message, 'error'); } }
    async function exportBackup() { try { status('Building Spatial Notes backup…'); status(await ns.notesBackup.exportSpatial(), 'success'); } catch (error) { status(error.message, 'error'); } }
    async function importBackup(file) { if (!file) return; try { status('Importing Spatial Notes backup…'); const payload = await ns.notesBackup.importSpatial(file); lastWorkspaceAt = 0; await loadList(currentPath); status(payload.message, 'success'); } catch (error) { status(error.message, 'error'); } }

    function applyFont() {
        const editor = one('[data-eve-notes-editor]'), font = one('[data-eve-notes-font]')?.value || 'Georgia', size = Number(one('[data-eve-notes-font-size]')?.value || 16);
        if (editor) { editor.style.fontFamily = font; editor.style.fontSize = `${size}px`; }
        if (one('[data-eve-notes-font-size-label]')) one('[data-eve-notes-font-size-label]').textContent = `${size}px`;
        write(FONT_KEY, font); write(FONT_SIZE_KEY, size);
    }

    function bindCriticalControls() {
        const direct = (selector, handler) => {
            const button = one(selector); if (!button || button.dataset.eveDirectBound === '1') return;
            button.dataset.eveDirectBound = '1'; button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void handler(event); });
        };
        direct('[data-eve-notes-track]', trackPath);
        direct('[data-eve-notes-save]', saveNote);
        overlay?.querySelectorAll('[data-eve-notes-create]').forEach(button => {
            if (button.dataset.eveDirectBound === '1') return; button.dataset.eveDirectBound = '1';
            button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void createItem(button.dataset.eveNotesCreate); });
        });
    }

    function bind(target) {
        overlay = target; bindCriticalControls();
        if (!overlay || overlay.dataset.eveNotesBound === '1') return;
        overlay.dataset.eveNotesBound = '1'; mode = read(MODE_KEY, 'scratchpad');
        one('[data-eve-notes-markdown]').checked = read(MARKDOWN_KEY, '0') === '1'; one('[data-eve-notes-font]').value = read(FONT_KEY, 'Georgia'); one('[data-eve-notes-font-size]').value = read(FONT_SIZE_KEY, '16');
        applyFont(); applyMode(); ensureStatusToast();
        overlay.addEventListener('click', event => {
            const modeButton = event.target.closest?.('[data-eve-notes-mode]');
            if (modeButton) void setMode(modeButton.dataset.eveNotesMode);
            else if (event.target.closest?.('[data-eve-notes-refresh]')) void refreshWorkspace({ preserve: true, force: true });
            else if (event.target.closest?.('[data-eve-notes-untrack]')) void removePath();
            else if (event.target.closest?.('[data-eve-notes-up]')) void loadList(currentPath.split('/').slice(0, -1).join('/'));
            else if (event.target.closest?.('[data-eve-notes-revert]')) void openEntry(opened?.path || '', 'file');
            else if (event.target.closest?.('[data-eve-notes-favorite]')) void toggleFavorite();
            else if (event.target.closest?.('[data-eve-notes-copy-ref]')) void copyReference();
            else if (event.target.closest?.('[data-eve-notes-link]')) void linkNote();
            else if (event.target.closest?.('[data-eve-notes-export]')) void exportBackup();
            else if (event.target.closest?.('[data-eve-notes-import]')) one('[data-eve-notes-import-file]')?.click();
        });
        one('[data-eve-notes-root]').addEventListener('change', async event => { if (!(await allowDiscard())) return renderRoots(currentRoot); currentRoot = event.target.value; write(ROOT_KEYS[mode], currentRoot); currentPath = ''; clearEditor(); void loadList(''); });
        one('[data-eve-notes-markdown]').addEventListener('change', event => { write(MARKDOWN_KEY, event.target.checked ? '1' : '0'); void loadList(currentPath); });
        one('[data-eve-notes-filter]').addEventListener('input', renderEntries);
        one('[data-eve-notes-track-path]')?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void trackPath(); } });
        one('[data-eve-notes-editor]').addEventListener('input', () => status(isDirty() ? 'Unsaved changes.' : 'Ready.'));
        overlay.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && mode !== 'scratchpad') { event.preventDefault(); void saveNote(); } });
        one('[data-eve-notes-font]').addEventListener('change', applyFont); one('[data-eve-notes-font-size]').addEventListener('input', applyFont);
        one('[data-eve-notes-import-file]').addEventListener('change', event => { void importBackup(event.target.files?.[0]); event.target.value = ''; });
    }

    async function activate(target) { if (target) bind(target); applyMode(); if (mode !== 'scratchpad' && !loading) { try { await ensureWorkspaceService(); await refreshWorkspace({ preserve: true }); } catch (error) { status(error.message, 'error'); } } }
    async function resume() { ns.notesClient?.resetConnection?.(); lastWorkspaceAt = 0; workspaceRefreshPromise = null; if (overlay?.classList.contains('is-open') && mode !== 'scratchpad' && !isDirty()) { try { await ensureWorkspaceService(); await refreshWorkspace({ preserve: true, force: true }); } catch (error) { status(error.message, 'error'); } } }
    window.addEventListener('beforeunload', event => { if (isDirty()) { event.preventDefault(); event.returnValue = ''; } });

    ns.notesWorkspace = Object.freeze({
        bind, activate, resume, isDirty, canLeave: allowDiscard, openEntry, openReference,
        context: () => ({ opened: opened ? { ...opened } : null, rootId: currentRoot, path: currentPath, mode }),
        showEntries(next, message) { entries = Array.isArray(next) ? next : []; renderEntries(); status(message); },
        refreshList: () => loadList(currentPath), clearEditor, status,
        focusActive() { one(mode === 'scratchpad' ? '[data-world-book-notes]' : '[data-eve-notes-editor]')?.focus(); }
    });
})(window.EveWorldBook);
