window.EveMatrixWorkshop = window.EveMatrixWorkshop || {};

(function (ns) {
    'use strict';

    const OVERLAY_ID = 'matrix-workshop-overlay';
    const FRAME_ID = 'matrix-workshop-frame';
    const SOURCE_PATH = 'tools/workshop/MatrixBackground-V2-Upgrading.html';
    const HEADER_PREF_KEY = 'eveMatrixWorkshopHeaderHidden';
    const DETACHED_WINDOW_NAME = 'eveMatrixWorkshopWindow';
    const DETACHED_LOCK_PREF_KEY = 'eveMatrixDetachedBackgroundLock';
    let previousFocus = null;
    let previousBodyOverflow = '';
    let detachedWindow = null;
    let detachedWindowToken = '';
    let currentScope = null;

    function getLauncher() {
        return document.querySelector('.topbar-matrix-btn');
    }

    function isOpen() {
        return document.getElementById(OVERLAY_ID)?.classList.contains('is-open') || false;
    }

    function updateLauncher(open) {
        const launcher = getLauncher();
        if (launcher) launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function getSourceUrl() {
        return new URL(SOURCE_PATH, window.location.href).href;
    }

    function createDetachedWindowToken() {
        if (window.crypto?.getRandomValues) {
            const bytes = new Uint8Array(10);
            window.crypto.getRandomValues(bytes);
            return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
        }
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    }

    function getDetachedSourceUrl() {
        detachedWindowToken = createDetachedWindowToken();
        const url = new URL(getSourceUrl());
        url.searchParams.set('eveMatrixDetached', '1');
        url.searchParams.set('eveMatrixWindowToken', detachedWindowToken);
        const controlPort = Number(
            window.EveOSLocalControl?.port?.()
            || window.EveOSPortRegistry?.get?.('GEMINI_CONTROL_PORT', 0)
            || window.config?.bridges?.localControlPort
            || window.config?.bridges?.geminiControlPort
            || 0
        );
        if (controlPort > 0) url.searchParams.set('eveMatrixControlPort', String(controlPort));
        return url.href;
    }

    function readDetachedLockPreference() {
        try { return localStorage.getItem(DETACHED_LOCK_PREF_KEY) === '1'; }
        catch (error) { return false; }
    }

    function getDetachedWindowFeatures() {
        const availableWidth = Math.max(760, Number(window.screen?.availWidth) || 1280);
        const availableHeight = Math.max(600, Number(window.screen?.availHeight) || 820);
        const width = Math.min(1280, Math.max(760, availableWidth - 120));
        const height = Math.min(900, Math.max(600, availableHeight - 120));
        const left = Math.max(0, Math.round((availableWidth - width) / 2));
        const top = Math.max(0, Math.round((availableHeight - height) / 2));
        return [
            'popup=yes',
            `width=${width}`,
            `height=${height}`,
            `left=${left}`,
            `top=${top}`,
            'resizable=yes',
            'scrollbars=no'
        ].join(',');
    }

    function setStatus(message) {
        const status = document.querySelector(`#${OVERLAY_ID} [data-matrix-status]`);
        if (status) status.textContent = message;
    }

    function normalizeScope(scopeOption) {
        if (typeof ns.normalizeScope === 'function') return ns.normalizeScope(scopeOption);
        const config = window.eveState?.config || window.config || {};
        const source = scopeOption && typeof scopeOption === 'object' ? scopeOption : {};
        return {
            scope: source.scope || 'workspace',
            workspaceId: source.workspaceId || config.activeWorkspace || 'main',
            workspaceIds: Array.isArray(source.workspaceIds) ? source.workspaceIds.slice() : [],
            categoryName: source.categoryName || '',
            scopeLabel: source.scopeLabel || ''
        };
    }

    function setScope(scopeOption) {
        currentScope = normalizeScope(scopeOption);
        setStatus((ns.getScopeLabel?.(currentScope) || 'EveOS') + ' · Visual engine');
        ns.broadcastDatapackInvalidated?.('scope-changed');
        return currentScope;
    }

    function readHeaderPreference() {
        try {
            return localStorage.getItem(HEADER_PREF_KEY) === '1';
        } catch (error) {
            return false;
        }
    }

    function writeHeaderPreference(hidden) {
        try {
            localStorage.setItem(HEADER_PREF_KEY, hidden ? '1' : '0');
        } catch (error) {
            // The visual state still works when storage is unavailable.
        }
    }

    function setHeaderHidden(hidden, options = {}) {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) return;

        overlay.classList.toggle('is-header-hidden', !!hidden);
        const toggle = overlay.querySelector('[data-matrix-header-toggle]');
        if (toggle) toggle.setAttribute('aria-pressed', hidden ? 'true' : 'false');
        if (options.persist !== false) writeHeaderPreference(hidden);

        if (options.focus === 'restore') {
            requestAnimationFrame(() => overlay.querySelector('[data-matrix-header-restore]')?.focus());
        } else if (options.focus === 'toggle') {
            requestAnimationFrame(() => toggle?.focus());
        }
    }

    function createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.className = 'matrix-workshop-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'matrix-workshop-title');
        overlay.setAttribute('aria-hidden', 'true');
        overlay.innerHTML = `
            <section class="matrix-workshop-shell">
                <header class="matrix-workshop-header">
                    <div class="matrix-workshop-identity">
                        <span class="matrix-workshop-mark" aria-hidden="true"></span>
                        <div class="matrix-workshop-heading">
                            <strong id="matrix-workshop-title">Matrix Workshop</strong>
                            <span data-matrix-status>Local visual engine</span>
                        </div>
                    </div>
                    <div class="matrix-workshop-header-actions">
                        <button class="matrix-workshop-detach" type="button"
                            data-matrix-detach aria-label="Detach Matrix Workshop into a window"
                            title="Detach Matrix Workshop into a window">
                            <span aria-hidden="true">&#8599;</span><span class="matrix-workshop-detach-label">Detach</span>
                        </button>
                        <button class="matrix-workshop-header-toggle" type="button"
                            data-matrix-header-toggle aria-label="Hide Matrix header"
                            aria-pressed="false" title="Hide Matrix header">
                            <span aria-hidden="true">&#9650;</span>
                        </button>
                        <button class="matrix-workshop-close" type="button"
                            data-matrix-close aria-label="Close Matrix Workshop"
                            title="Close Matrix Workshop">Close <span aria-hidden="true">&times;</span></button>
                    </div>
                </header>
                <div class="matrix-workshop-stage">
                    <button class="matrix-workshop-header-restore" type="button"
                        data-matrix-header-restore aria-label="Show Matrix header"
                        title="Show Matrix header"><span aria-hidden="true">&#9660;</span></button>
                    <div class="matrix-workshop-loader" data-matrix-loader>
                        <span class="matrix-workshop-loader-grid" aria-hidden="true"></span>
                        <strong>Initializing Matrix</strong>
                    </div>
                    <iframe id="${FRAME_ID}" class="matrix-workshop-frame"
                        title="Matrix Code Rain Workshop" allow="fullscreen"></iframe>
                </div>
            </section>`;

        const frame = overlay.querySelector(`#${FRAME_ID}`);
        frame.addEventListener('load', function () {
            if (!isOpen() || frame.src === 'about:blank') return;
            overlay.classList.remove('is-loading');
            const status = overlay.querySelector('[data-matrix-status]');
            if (status) {
                status.textContent = (ns.getScopeLabel?.(currentScope) || 'EveOS') + ' · Online';
            }
        });

        overlay.querySelector('[data-matrix-close]')?.addEventListener('click', ns.close);
        overlay.querySelector('[data-matrix-detach]')?.addEventListener('click', ns.detach);
        overlay.querySelector('[data-matrix-header-toggle]')?.addEventListener('click', function () {
            setHeaderHidden(true, { focus: 'restore' });
        });
        overlay.querySelector('[data-matrix-header-restore]')?.addEventListener('click', function () {
            setHeaderHidden(false, { focus: 'toggle' });
        });
        document.body.appendChild(overlay);
        setHeaderHidden(readHeaderPreference(), { persist: false });
        return overlay;
    }

    function ensureOverlay() {
        return document.getElementById(OVERLAY_ID) || createOverlay();
    }

    ns.open = function openMatrixWorkshop(scopeOption) {
        setScope(scopeOption);
        const overlay = ensureOverlay();
        if (isOpen()) return;

        if (window.EveConstellationMap?.closeMap) {
            window.EveConstellationMap.closeMap();
        }

        previousFocus = document.activeElement;
        previousBodyOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        document.body.classList.add('matrix-workshop-open');

        const frame = overlay.querySelector(`#${FRAME_ID}`);
        const status = overlay.querySelector('[data-matrix-status]');
        if (status) {
            status.textContent = 'Starting · ' + (ns.getScopeLabel?.(currentScope) || 'EveOS');
        }
        overlay.classList.add('is-open', 'is-loading');
        overlay.setAttribute('aria-hidden', 'false');
        updateLauncher(true);

        if (frame) frame.src = getSourceUrl();
        requestAnimationFrame(function () {
            overlay.querySelector('[data-matrix-close]')?.focus();
        });
    };

    ns.close = function closeMatrixWorkshop() {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay || !isOpen()) return;

        overlay.classList.remove('is-open', 'is-loading');
        overlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('matrix-workshop-open');
        document.body.style.overflow = previousBodyOverflow;
        updateLauncher(false);

        const frame = overlay.querySelector(`#${FRAME_ID}`);
        if (frame) frame.src = 'about:blank';

        if (previousFocus && typeof previousFocus.focus === 'function') {
            previousFocus.focus();
        }
        previousFocus = null;
    };

    ns.detach = function detachMatrixWorkshop() {
        if (detachedWindow && !detachedWindow.closed) {
            if (!readDetachedLockPreference()) detachedWindow.focus();
            ns.close();
            return detachedWindow;
        }

        detachedWindow = window.open(
            getDetachedSourceUrl(),
            DETACHED_WINDOW_NAME,
            getDetachedWindowFeatures()
        );

        if (!detachedWindow) {
            setStatus('Window blocked - allow pop-ups to detach');
            return null;
        }

        if (!readDetachedLockPreference()) detachedWindow.focus();
        ns.close();
        return detachedWindow;
    };

    ns.isOpen = isOpen;
    ns.setHeaderHidden = setHeaderHidden;
    ns.getScope = function getScope() {
        return currentScope || normalizeScope();
    };
    ns.setScope = setScope;
    ns.getDetachedWindow = function getDetachedWindow() {
        return detachedWindow;
    };
    ns.getDetachedWindowToken = function getDetachedWindowToken() {
        return detachedWindowToken;
    };
    ns.openAll = function openAllMatrix() {
        ns.open({ scope: 'all' });
    };
    ns.openWorkspace = function openWorkspaceMatrix(workspaceId) {
        ns.open({ scope: 'workspace', workspaceId });
    };
    ns.openCard = function openCardMatrix(workspaceId, categoryName) {
        ns.open({ scope: 'card', workspaceId, categoryName });
    };
    ns.openCurrentView = function openCurrentMatrixView() {
        const mainContent = document.getElementById('main-content');
        const unidex = window.UnidexView;
        if (mainContent?.classList?.contains('unidex-view-active') && unidex?.getMatrixScope) {
            ns.open(unidex.getMatrixScope());
            return;
        }
        const groupScope = ns.getGroupOverviewScope?.();
        if (groupScope) {
            ns.open(groupScope);
            return;
        }
        const config = window.eveState?.config || window.config || {};
        ns.openWorkspace(config.activeWorkspace || 'main');
    };

    ns.rehydrate = function rehydrateMatrixWorkshop() {
        const overlay = ensureOverlay();
        if (!isOpen()) return;
        const frame = overlay.querySelector(`#${FRAME_ID}`);
        if (frame && (!frame.src || frame.src === 'about:blank')) frame.src = getSourceUrl();
    };

    window.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape' || !isOpen()) return;
        event.preventDefault();
        ns.close();
    });

    window.dispatchEvent(new CustomEvent('eve:matrix-workshop-ready'));
    window.EveOSResume?.register?.('matrix', { open: ns.openCurrentView, resume: ns.rehydrate });
    if (window.__eveMatrixOpenPending) {
        window.__eveMatrixOpenPending = false;
        setTimeout(ns.openCurrentView, 0);
    }
})(window.EveMatrixWorkshop);
