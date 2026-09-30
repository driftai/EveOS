window.EveWorldBook = window.EveWorldBook || {};

(function (ns) {
    'use strict';

    const OVERLAY_ID = 'notes-world-book-overlay';
    const NOTES_KEY = 'eveV22Notes';
    const VIEW_KEY = 'eveNotesWorldBookView';
    const HEADER_KEY = 'eveNotesWorldBookHeaderHidden';
    let previousFocus = null;
    let previousBodyOverflow = '';
    let statusTimer = 0;
    let notesSaveTimer = 0;
    let lastRunningState = false;
    let lastInstanceId = '';

    function readPreference(key, fallback) {
        try {
            return localStorage.getItem(key) || fallback;
        } catch (error) {
            return fallback;
        }
    }

    function writePreference(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (error) {
            // The current visual state still works without persistent storage.
        }
    }

    function isOpen() {
        return document.getElementById(OVERLAY_ID)?.classList.contains('is-open') || false;
    }

    function currentView() {
        return document.getElementById(OVERLAY_ID)?.dataset.view || 'notes';
    }

    function setOverlayStatus(message) {
        const status = document.querySelector(`#${OVERLAY_ID} [data-world-book-status]`);
        if (status) status.textContent = message;
    }

    async function readNotes() {
        if (window.EveCoreStorage?.loadText) {
            const stored = await window.EveCoreStorage.loadText(NOTES_KEY, '', { localFallbackKey: NOTES_KEY });
            if (stored != null) return String(stored);
        }
        const original = document.getElementById('notes-area');
        if (original) return original.value;
        return readPreference(NOTES_KEY, '');
    }

    function persistNotes(value) {
        const original = document.getElementById('notes-area');
        if (original && original.value !== value) original.value = value;
        window.clearTimeout(notesSaveTimer);
        notesSaveTimer = window.setTimeout(function () {
            if (window.EveCoreStorage?.saveText) {
                void window.EveCoreStorage.saveText(NOTES_KEY, value, { localFallbackKey: NOTES_KEY });
            } else {
                writePreference(NOTES_KEY, value);
            }
        }, 220);
    }

    async function hydrateNotes() {
        const editor = document.querySelector(`#${OVERLAY_ID} [data-world-book-notes]`);
        if (!editor || editor === document.activeElement) return;
        editor.value = await readNotes() || '';
        ns.offline?.updateNotesMeta?.(document.getElementById(OVERLAY_ID), editor.value);
    }

    function setHeaderHidden(hidden) {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) return;
        overlay.classList.toggle('is-header-hidden', !!hidden);
        writePreference(HEADER_KEY, hidden ? '1' : '0');
    }

    function setFullscreen(enabled) {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) return;
        overlay.classList.toggle('is-fullscreen', !!enabled);
        const button = overlay.querySelector('[data-world-book-fullscreen]');
        if (button) {
            button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
            button.title = enabled ? 'Exit full screen' : 'Use full screen';
        }
    }

    function navigateFrame(frame, source, force) {
        if (!frame) return;
        const targetSource = String(source || 'about:blank');
        const sameTarget = frame.dataset.worldBookTarget === targetSource;
        const frameState = frame.dataset.worldBookFrameState || '';
        if (!force && sameTarget && ['loading', 'ready'].includes(frameState)) return;
        frame.dataset.worldBookTarget = targetSource;
        frame.dataset.worldBookFrameState = targetSource === 'about:blank' ? 'idle' : 'loading';
        const target = frame.contentWindow;
        if (target) {
            window.dispatchEvent(new CustomEvent('eve:world-book-frame-loading', { detail: { target } }));
        }
        if (force && targetSource !== 'about:blank') {
            frame.src = 'about:blank';
            window.requestAnimationFrame(() => {
                if (frame.dataset.worldBookTarget === targetSource) frame.src = targetSource;
            });
            return;
        }
        frame.src = targetSource;
    }

    function activeFrameUrl(snapshot, view) {
        const base = String(snapshot?.url || '').replace(/\/$/, '');
        if (!base) return 'about:blank';
        return view === 'portal'
            ? `${base}/?view=world-portal&embedded=1`
            : `${base}/?embedded=eveos`;
    }

    async function reloadActiveFrame() {
        const overlay = ensureOverlay();
        const view = currentView();
        if (!['world', 'portal'].includes(view)) return;
        const snapshot = await ns.client.refresh();
        renderStatus(snapshot);
        if (!snapshot.running) return;
        const frame = overlay.querySelector(view === 'portal' ? '[data-world-portal-frame]' : '[data-world-book-frame]');
        navigateFrame(frame, activeFrameUrl(snapshot, view), true);
        setOverlayStatus(`Reloading ${view === 'portal' ? 'World Portal' : 'World Book'}...`);
    }

    function renderDetachState(detail) {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) return;
        const open = detail?.open === true;
        const sensor = overlay.querySelector('[data-world-book-detach-state]');
        const button = overlay.querySelector('[data-world-book-detach]');
        if (sensor) {
            sensor.dataset.state = open ? 'detached' : 'attached';
            sensor.textContent = open ? 'Detached' : 'Attached';
        }
        if (button) {
            button.classList.toggle('is-detached', open);
            button.title = open ? 'Focus the detached World Book window' : 'Detach the active view into a window';
        }
    }

    function syncViewButtons(overlay, view) {
        overlay?.querySelectorAll('[data-world-book-view]').forEach(function (button) {
            const active = button.dataset.worldBookView === view;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }

    function renderStatus(snapshot) {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) return;
        const status = overlay.querySelector('[data-world-book-status]');
        const pill = overlay.querySelector('[data-world-book-status-pill]');
        const toggle = overlay.querySelector('[data-world-book-server-toggle]');
        const offlineStart = overlay.querySelector('[data-world-book-offline-start]');
        const messages = overlay.querySelectorAll('[data-world-book-offline-message]');
        const worldFrame = overlay.querySelector('[data-world-book-frame]');
        const portalFrame = overlay.querySelector('[data-world-portal-frame]');
        const running = snapshot.running === true;
        const controllable = snapshot.controllerAvailable === true;
        const canBootstrap = snapshot.installed !== false;

        if (status) status.textContent = snapshot.message || (running ? 'World Book online' : 'World Book stopped');
        if (pill) {
            pill.dataset.state = snapshot.serverState || 'stopped';
            pill.textContent = running
                ? controllable ? 'Online' : 'Standalone Online'
                : !controllable
                    ? snapshot.serverState === 'enabling' ? 'Enabling Control' : 'Control Ready'
                    : snapshot.serverState === 'starting'
                        ? 'Starting'
                        : snapshot.serverState === 'stopping'
                            ? 'Stopping'
                            : 'Stopped';
        }
        if (toggle) {
            toggle.disabled = snapshot.busy === true || !canBootstrap;
            toggle.textContent = running ? 'Stop World Book' : 'Start World Book';
            toggle.dataset.action = running ? 'stop' : 'start';
            toggle.title = running
                ? controllable
                    ? 'Stop the World Book server'
                    : 'Connect local control and stop this standalone World Book server'
                : controllable
                    ? 'Start the World Book server'
                    : 'Start local control and World Book';
        }
        if (offlineStart) {
            offlineStart.disabled = snapshot.busy === true || !canBootstrap;
            offlineStart.textContent = 'Start World Book';
            offlineStart.title = controllable
                ? 'Start the World Book server'
                : 'Start local control and World Book';
        }
        messages.forEach((message) => { message.textContent = snapshot.message || ''; });
        ns.offline?.setServerState?.(overlay, running);

        const becameOnline = running && !lastRunningState;
        const instanceId = String(snapshot.instanceId || '');
        const serverReplaced = running && !!instanceId && !!lastInstanceId && instanceId !== lastInstanceId;
        lastRunningState = running;
        if (instanceId) lastInstanceId = instanceId;
        overlay.classList.toggle('is-world-online', running);
        if (!['world', 'portal'].includes(currentView())) return;
        if (running) {
            const active = currentView();
            const force = becameOnline || serverReplaced;
            navigateFrame(worldFrame, active === 'world' ? activeFrameUrl(snapshot, 'world') : 'about:blank', force && active === 'world');
            navigateFrame(portalFrame, active === 'portal' ? activeFrameUrl(snapshot, 'portal') : 'about:blank', force && active === 'portal');
            if (serverReplaced) setOverlayStatus('World Book restarted — refreshing the embedded view...');
        } else {
            navigateFrame(worldFrame, 'about:blank');
            navigateFrame(portalFrame, 'about:blank');
        }
    }

    async function refreshStatus() {
        const snapshot = await ns.client.refresh();
        renderStatus(snapshot);
        return snapshot;
    }

    async function setView(view) {
        const overlay = ensureOverlay();
        const next = ['world', 'portal'].includes(view) ? view : 'notes';
        overlay.dataset.view = next;
        writePreference(VIEW_KEY, next);
        syncViewButtons(overlay, next);
        if (next === 'notes') {
            await hydrateNotes();
            await ns.notesWorkspace?.activate?.(overlay);
            requestAnimationFrame(() => overlay.querySelector('[data-world-book-notes]')?.focus());
        } else {
            await refreshStatus();
        }
    }

    async function toggleServer() {
        const snapshot = ns.client.state.running ? await ns.client.stop() : await ns.client.start();
        renderStatus(snapshot);
    }

    function createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.className = 'notes-world-book-overlay';
        overlay.dataset.view = readPreference(VIEW_KEY, 'notes');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'notes-world-book-title');
        overlay.setAttribute('aria-hidden', 'true');
        overlay.innerHTML = ns.overlayTemplate?.markup?.() || '';


        overlay.addEventListener('click', function (event) {
            if (event.target === overlay) ns.close();
        });
        overlay.querySelector('[data-world-book-close]').addEventListener('click', ns.close);
        overlay.querySelector('[data-world-book-server-toggle]').addEventListener('click', toggleServer);
        overlay.querySelectorAll('[data-world-book-offline-start]').forEach(button => {
            button.addEventListener('click', toggleServer);
        });
        overlay.querySelector('[data-world-book-reader-controls]').addEventListener('click', () => {
            window.EveWorldBookNarrationBridge?.openCompanion?.();
        });
        overlay.querySelector('[data-world-book-notes-read]').addEventListener('click', () => {
            void ns.notesNarration?.readAloud?.(overlay);
        });
        overlay.querySelector('[data-world-book-reload]').addEventListener('click', () => void reloadActiveFrame());
        overlay.querySelector('[data-world-book-detach]').addEventListener('click', ns.detach);
        overlay.querySelectorAll('[data-world-book-frame], [data-world-portal-frame]').forEach(frame => {
            frame.addEventListener('load', () => {
                frame.dataset.worldBookFrameState = frame.getAttribute('src') === 'about:blank' ? 'idle' : 'ready';
            });
            frame.addEventListener('error', () => {
                frame.dataset.worldBookFrameState = 'error';
                setOverlayStatus('Embedded view failed to load. Use Reload to retry.');
            });
        });
        overlay.querySelector('[data-world-book-header-toggle]').addEventListener('click', () => setHeaderHidden(true));
        overlay.querySelector('[data-world-book-header-restore]').addEventListener('click', () => setHeaderHidden(false));
        overlay.querySelector('[data-world-book-fullscreen]').addEventListener('click', function () {
            setFullscreen(!overlay.classList.contains('is-fullscreen'));
        });
        overlay.querySelectorAll('[data-world-book-view]').forEach(function (button) {
            button.addEventListener('click', () => void setView(button.dataset.worldBookView));
        });
        overlay.querySelector('[data-world-book-notes]').addEventListener('input', function (event) {
            persistNotes(event.currentTarget.value);
            ns.offline?.updateNotesMeta?.(overlay, event.currentTarget.value); ns.notesNarration?.notifyChanged?.(event.currentTarget.value);
        });
        ns.offline?.bind?.(overlay, { onNotes: () => void setView('notes') });
        document.body.appendChild(overlay);
        ns.notesWorkspace?.bind?.(overlay);
        syncViewButtons(overlay, overlay.dataset.view || 'notes');
        setHeaderHidden(readPreference(HEADER_KEY, '0') === '1');
        return overlay;
    }

    function ensureOverlay() {
        const existing = document.getElementById(OVERLAY_ID);
        if (existing?.querySelector('.notes-world-book-shell') && existing.querySelector('[data-world-book-close]')) return existing;
        const restoreOpen = existing?.classList.contains('is-open') || document.body.classList.contains('notes-world-book-open');
        existing?.remove();
        const repaired = createOverlay();
        if (restoreOpen) {
            repaired.classList.add('is-open');
            repaired.setAttribute('aria-hidden', 'false');
            document.body.classList.add('notes-world-book-open');
            document.querySelector('.topbar-notes-world-book-btn')?.setAttribute('aria-expanded', 'true');
        }
        return repaired;
    }

    ns.open = async function openNotesWorldBook(view) {
        const overlay = ensureOverlay();
        if (!isOpen()) {
            previousFocus = document.activeElement;
            previousBodyOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            document.body.classList.add('notes-world-book-open');
            overlay.classList.add('is-open');
            overlay.setAttribute('aria-hidden', 'false');
            document.querySelector('.topbar-notes-world-book-btn')?.setAttribute('aria-expanded', 'true');
        }
        renderDetachState(ns.detached?.state?.() || { open: false });
        const snapshot = await ns.client.refresh();
        renderStatus(snapshot);
        let targetView = view || overlay.dataset.view;
        if (!view && !snapshot.running && ['world', 'portal'].includes(targetView)) targetView = 'notes';
        await setView(targetView);
        window.clearInterval(statusTimer);
        statusTimer = window.setInterval(refreshStatus, 5000);
    };

    ns.close = function closeNotesWorldBook() {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay || !isOpen()) return;
        overlay.classList.remove('is-open');
        overlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('notes-world-book-open');
        document.body.style.overflow = previousBodyOverflow;
        document.querySelector('.topbar-notes-world-book-btn')?.setAttribute('aria-expanded', 'false');
        overlay.querySelectorAll('[data-world-book-frame], [data-world-portal-frame]').forEach(frame => {
            navigateFrame(frame, 'about:blank');
        });
        window.clearInterval(statusTimer);
        statusTimer = 0;
        previousFocus?.focus?.();
        previousFocus = null;
    };

    ns.detach = function detachWorldBook() {
        return ns.detached.open({
            view: currentView(),
            onSnapshot: renderStatus,
            onMessage: setOverlayStatus,
            onReady: ns.close
        });
    };

    ns.setView = setView;
    ns.isOpen = isOpen;
    ns.getDetachedWindow = function getDetachedWindow() {
        return ns.detached.getWindow();
    };
    ns.rehydrate = async function rehydrateNotesWorldBook() {
        const overlay = ensureOverlay();
        await ns.notesWorkspace?.resume?.();
        if (overlay.classList.contains('is-open')) {
            renderDetachState(ns.detached?.state?.() || { open: false });
            renderStatus(await ns.client.refresh());
            await setView(overlay.dataset.view || 'notes');
        }
    };

    document.addEventListener('input', function (event) {
        if (event.target?.id !== 'notes-area') return;
        const editor = document.querySelector(`#${OVERLAY_ID} [data-world-book-notes]`);
        if (editor && editor !== document.activeElement) editor.value = event.target.value;
    });
    window.addEventListener('eve:world-book-status', (event) => renderStatus(event.detail));
    window.addEventListener('eve:world-book-detached-state', (event) => renderDetachState(event.detail));
    window.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape' || !isOpen()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        ns.close();
    }, true);

    window.dispatchEvent(new CustomEvent('eve:world-book-ready'));
    window.EveOSResume?.register?.('worldBook', { open: ns.open, resume: ns.rehydrate });
    if (window.__eveWorldBookOpenPending) {
        window.__eveWorldBookOpenPending = false;
        window.setTimeout(ns.open, 0);
    }
})(window.EveWorldBook);
