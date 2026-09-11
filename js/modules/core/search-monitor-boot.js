(function () {
    const traceApi = window.SearchMonitorBootTrace;
    if (!traceApi) throw new Error('[SearchMonitorBoot] Trace module missing.');

    function getIndicator() {
        return document.getElementById('loadingIndicator');
    }

    function isCompact(indicator) {
        return !!indicator && indicator.classList.contains('compact');
    }

    function ensureVisible(indicator) {
        if (!indicator) return;
        indicator.classList.add('visible');
        indicator.style.display = '';
    }
    function setWideMode(indicator) {
        if (!indicator) return false;
        const isWide = indicator.classList.toggle('wide-mode');
        if (isWide) indicator.classList.remove('fullscreen-mode');
        try {
            localStorage.setItem('searchMonitorWide', isWide ? 'true' : 'false');
        } catch (error) {
            // Restricted storage must not block the view control.
        }
        return isWide;
    }

    function setFullscreenMode(indicator) {
        if (!indicator) return false;
        const isFullscreen = indicator.classList.toggle('fullscreen-mode');
        if (isFullscreen) {
            indicator.classList.remove('wide-mode');
            try {
                localStorage.setItem('searchMonitorWide', 'false');
            } catch (error) {
                // Restricted storage must not block the view control.
            }
        }
        return isFullscreen;
    }

    function handleModeControlClick(event) {
        const button = event.target?.closest?.('.monitor-wide-toggle, .monitor-fullscreen-toggle');
        const indicator = button?.closest?.('#loadingIndicator');
        if (!button || !indicator) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (button.classList.contains('monitor-wide-toggle')) {
            setWideMode(indicator);
        } else {
            setFullscreenMode(indicator);
        }
    }

    function bindModeControls(indicator) {
        if (!indicator) return;
        const wideButton = indicator.querySelector('.monitor-wide-toggle');
        const fullscreenButton = indicator.querySelector('.monitor-fullscreen-toggle');
        if (!window.__searchMonitorModeDelegateBound) {
            window.__searchMonitorModeDelegateBound = true;
            document.addEventListener('click', handleModeControlClick, true);
        }

        if (wideButton) {
            wideButton.dataset.searchMonitorModeBound = '1';
            wideButton.onclick = function (event) {
                event.preventDefault();
                event.stopPropagation();
                setWideMode(indicator);
            };
        }

        if (fullscreenButton) {
            fullscreenButton.dataset.searchMonitorModeBound = '1';
            fullscreenButton.onclick = function (event) {
                event.preventDefault();
                event.stopPropagation();
                setFullscreenMode(indicator);
            };
        }
    }

    function shouldIgnoreToggleEvent(event, indicator) {
        if (!event || !indicator) return false;
        const target = event.target;
        if (!target || target === indicator) return false;
        if (typeof target.closest !== 'function') return false;
        const interactive = target.closest('button, a, input, textarea, select, summary, [role="button"], [contenteditable="true"], .status-group');
        return !!interactive && indicator.contains(interactive);
    }

    // The bottom stats panel (Status / Wikis / Results / Trace) collapses independently of the
    // whole-monitor compact toggle. State lives as the `details-collapsed` class on the indicator;
    // matching CSS (loading-indicator.details-message.css) hides `.expanded-content` and rotates
    // the ▼ arrow when the class is present.
    function setDetailsCollapsed(indicator, collapsed) {
        if (!indicator) return;
        indicator.classList.toggle('details-collapsed', !!collapsed);
        try {
            localStorage.setItem('searchMonitorDetailsCollapsed', collapsed ? '1' : '0');
        } catch (error) {
            // Restricted storage must not block the view control.
        }
    }

    function restoreDetailsCollapsed(indicator) {
        if (!indicator) return;
        let stored = null;
        try {
            stored = localStorage.getItem('searchMonitorDetailsCollapsed');
        } catch (error) {
            stored = null;
        }
        indicator.classList.toggle('details-collapsed', stored === '1');
    }

    // The status header row is the collapse affordance. Guarantee the ▼ arrow exists (the static
    // markup ships with it, but rebuilt/legacy indicators may not) so the control is discoverable.
    function ensureDetailsArrow(indicator) {
        if (!indicator) return;
        const statusGroup = indicator.querySelector('.status-group');
        if (!statusGroup || statusGroup.querySelector('.monitor-details-collapse-arrow')) return;
        const arrow = document.createElement('span');
        arrow.className = 'monitor-details-collapse-arrow';
        arrow.textContent = '▼';
        statusGroup.appendChild(arrow);
    }

    function expandFallback(indicator) {
        if (!indicator) return;
        ensureVisible(indicator);
        indicator.classList.remove('compact');
    }

    function collapseFallback(indicator) {
        if (!indicator) return;
        indicator.classList.add('compact');
    }

    function toggleViaModule(event) {
        const indicator = getIndicator();
        if (!indicator || !window.LoadingIndicator) {
            return false;
        }

        const canExpand = typeof window.LoadingIndicator.expand === 'function';
        const canCollapse = typeof window.LoadingIndicator.collapse === 'function';
        if (!canExpand || !canCollapse) {
            return false;
        }

        if (isCompact(indicator)) {
            window.LoadingIndicator.expand();
        } else {
            window.LoadingIndicator.collapse();
        }

        if (event) {
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            }
        }
        return true;
    }

    // Dialogs/confirms opened FROM the monitor (clear chat, clear-all confirm, new-chat confirm,
    // inline prompts, generic modals) are appended to <body>, OUTSIDE the indicator's DOM. A click
    // on one of those is interaction with a monitor-spawned surface, not "clicking out" of it.
    // Peer surfaces are top-level workspaces of their own, NOT something the monitor spawned.
    // Notes / World Book carries role="dialog" for accessibility, which the generic dialog test
    // below matches — so clicking it counted as "still inside the monitor's world" and the monitor
    // stayed open on top of the panel the user had just switched to. Checked first so the
    // accessibility markup cannot re-capture the click.
    const PEER_SURFACE_SELECTOR = '#notes-world-book-overlay, .notes-world-book-overlay';

    function isMonitorDialogTarget(target) {
        if (!target || typeof target.closest !== 'function') return false;
        if (target.closest(PEER_SURFACE_SELECTOR)) return false;
        // `dialog` (the element) is essential: native <dialog> panels (audio/session/self-talk/
        // screen-capture settings) have an IMPLICIT role, so `[role="dialog"]` does NOT match them —
        // clicking one was read as "clicked out" and closed the monitor.
        return !!target.closest(
            'dialog, #custom-modal-overlay, #chat-clear-dialog, #chat-clear-overlay, '
            + '#gemini-new-chat-confirm, #eve-inline-prompt-overlay, .modal-overlay, '
            + '[role="dialog"], [data-eve-dialog]'
        );
    }

    function handleOutsideClick(event) {
        const indicator = getIndicator();
        if (!indicator || indicator.contains(event.target) || isMonitorDialogTarget(event.target)) {
            return;
        }

        // Search Monitor is the top layer. Consume this click so an overlay underneath it
        // (Audioflix, Matrix, etc.) does not also close or activate on the same gesture.
        event.preventDefault();
        event.stopImmediatePropagation();
        if (window.LoadingIndicator && typeof window.LoadingIndicator.collapse === 'function') {
            window.LoadingIndicator.collapse();
            return;
        }

        collapseFallback(indicator);
    }

    function handleTopLayerOutsideClick(event) {
        const indicator = getIndicator();
        if (!indicator || isCompact(indicator)) return;
        handleOutsideClick(event);
    }

    function handleToggle(event) {
        const indicator = getIndicator();
        if (!indicator) return;

        // Once expanded, Search Monitor behaves like a stable panel rather than one giant toggle.
        // Internal whitespace/text clicks stay inside it. The status header remains the dedicated
        // stats-collapse affordance; the whole monitor closes only through the top-layer outside
        // click gate or an explicit collapse API call.
        if (!isCompact(indicator)) {
            const statusGroup = event.target && typeof event.target.closest === 'function'
                ? event.target.closest('.status-group')
                : null;
            if (statusGroup && indicator.contains(statusGroup)) {
                event.preventDefault();
                event.stopPropagation();
                setDetailsCollapsed(indicator, !indicator.classList.contains('details-collapsed'));
            }
            return;
        }

        if (shouldIgnoreToggleEvent(event, indicator)) return;

        if (toggleViaModule(event)) {
            return;
        }

        expandFallback(indicator);
        if (event) event.stopPropagation();
    }

    function bind() {
        const indicator = getIndicator();
        if (!indicator || indicator.dataset.searchMonitorBootBound === '1') {
            return;
        }

        indicator.dataset.searchMonitorBootBound = '1';
        indicator.tabIndex = indicator.tabIndex >= 0 ? indicator.tabIndex : 0;
        indicator.setAttribute('role', 'button');
        indicator.setAttribute('aria-label', 'Toggle Search Monitor');
        traceApi.ensureTraceRow(indicator);
        traceApi.ensureTraceDetails(indicator);
        traceApi.ensureNexusLauncher(indicator);
        ensureDetailsArrow(indicator);
        restoreDetailsCollapsed(indicator);
        bindModeControls(indicator);
        if (!window.__searchMonitorTopLayerGateBound) {
            window.__searchMonitorTopLayerGateBound = true;
            document.addEventListener('click', handleTopLayerOutsideClick, true);
        }

        indicator.addEventListener('click', handleToggle);
        indicator.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const tag = event.target && event.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
                || (event.target && event.target.isContentEditable)) return;
            if (shouldIgnoreToggleEvent(event, indicator)) return;
            event.preventDefault();
            handleToggle(event);
        });

        if (!window.__nexusShortcutBound) {
            window.__nexusShortcutBound = true;
            document.addEventListener('keydown', function (event) {
                const key = String(event.key || '').toLowerCase();
                const isCurrentShortcut = (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && key === 'k';
                const isAllTabsShortcut = (event.ctrlKey || event.metaKey) && event.shiftKey && event.altKey && key === 'k';
                if (!isCurrentShortcut && !isAllTabsShortcut) return;
                const target = event.target;
                const tag = target?.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
                event.preventDefault();
                traceApi.openNexusSearch({ scopeMode: isAllTabsShortcut ? 'all' : 'current' });
            });
        }
    }

    window.SearchMonitorBoot = {
        bind,
        bindModeControls,
        handleToggle,
        openNexusSearch: function () {
            return traceApi.openNexusSearch({ scopeMode: 'current' });
        },
        openNexusAllTabs: function () {
            return traceApi.openNexusSearch({ scopeMode: 'all' });
        },
        _nexusSessions: [],
        recordNexusTrace: function (trace) {
            const indicator = getIndicator();
            if (!indicator || !trace?.id) return;
            traceApi.ensureTraceRow(indicator);
            traceApi.ensureTraceDetails(indicator);
            const summary = trace.summary || ('total ' + Number(trace.totalMs || 0) + 'ms');
            const textNode = indicator.querySelector('#nexusTrace');
            if (textNode) textNode.textContent = trace.id + ' · ' + summary;
            indicator.dataset.lastNexusTraceId = String(trace.id);
            traceApi.renderTraceDetails(indicator, trace);

            const sessions = window.SearchMonitorBoot._nexusSessions || [];
            sessions.unshift(trace);
            window.SearchMonitorBoot._nexusSessions = sessions.slice(0, 20);
        },
        getLatestNexusTrace: function () {
            return (window.SearchMonitorBoot._nexusSessions || [])[0] || null;
        },
        showNexusTrace: function (traceId) {
            const indicator = getIndicator();
            if (!indicator) return;
            traceApi.ensureTraceRow(indicator);
            traceApi.ensureTraceDetails(indicator);
            const sessions = window.SearchMonitorBoot._nexusSessions || [];
            const targetTrace = sessions.find(function (trace) {
                return String(trace?.id || '') === String(traceId || '');
            }) || sessions[0];
            if (targetTrace) {
                const textNode = indicator.querySelector('#nexusTrace');
                if (textNode) {
                    const summary = targetTrace.summary || ('total ' + Number(targetTrace.totalMs || 0) + 'ms');
                    textNode.textContent = targetTrace.id + ' · ' + summary;
                }
                traceApi.renderTraceDetails(indicator, targetTrace);
            }
            if (window.LoadingIndicator && typeof window.LoadingIndicator.expand === 'function') {
                window.LoadingIndicator.expand();
                return;
            }
            expandFallback(indicator);
        },
        expand: function () {
            const indicator = getIndicator();
            if (!indicator) return;
            traceApi.ensureTraceRow(indicator);
            traceApi.ensureTraceDetails(indicator);
            if (window.LoadingIndicator && typeof window.LoadingIndicator.expand === 'function') {
                window.LoadingIndicator.expand();
                return;
            }
            expandFallback(indicator);
        },
        collapse: function () {
            const indicator = getIndicator();
            if (!indicator) return;
            if (window.LoadingIndicator && typeof window.LoadingIndicator.collapse === 'function') {
                window.LoadingIndicator.collapse();
                return;
            }
            collapseFallback(indicator);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind, { once: true });
    } else {
        bind();
    }
})();
