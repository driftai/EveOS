window.EveOS = window.EveOS || {};
window.EveOS.SearchAdvanced = window.EveOS.SearchAdvanced || {};
window.EveOS.SearchAdvanced.Modules = window.EveOS.SearchAdvanced.Modules || {};

(function () {
    window.EveOS.SearchAdvanced.Modules.createUiFormHelpers = function createUiFormHelpers(deps) {
        const onRunSearch = typeof deps?.onRunSearch === 'function' ? deps.onRunSearch : function () {};
        const onClearFilters = typeof deps?.onClearFilters === 'function' ? deps.onClearFilters : function () {};
        const modules = window.EveOS.SearchAdvanced.Modules || {};
        const fields = typeof modules.createUiFormFields === 'function'
            ? modules.createUiFormFields()
            : {};
        const modalTemplate = typeof modules.createUiFormTemplate === 'function'
            ? modules.createUiFormTemplate()
            : '';

        function getSearchMonitor() {
            return document.getElementById('loadingIndicator');
        }

        function forceMonitorVisible() {
            const indicator = getSearchMonitor();
            if (!indicator) return false;
            indicator.style.display = '';
            indicator.classList.add('visible');
            indicator.classList.remove('compact');
            if (window.LoadingIndicator) {
                window.LoadingIndicator._loadingIndicatorCompact = false;
            }
            return true;
        }

        function expandSearchMonitor() {
            if (window.SearchMonitorBoot?.expand) {
                window.SearchMonitorBoot.expand();
                return forceMonitorVisible();
            }
            if (window.LoadingIndicator?.expand) {
                window.LoadingIndicator.expand();
                return forceMonitorVisible();
            }
            return forceMonitorVisible();
        }

        function openGeminiWorkspace() {
            const expanded = expandSearchMonitor();
            const root = document.getElementById('gemini-ui-root');
            if (root) {
                const fullViewBtn = root.querySelector('[data-gemini-monitor-view-btn="full"]');
                if (fullViewBtn && !fullViewBtn.classList.contains('active')) {
                    fullViewBtn.click();
                } else if (typeof window.__loadGeminiScriptsNow === 'function') {
                    window.__loadGeminiScriptsNow();
                }
                window.setTimeout(function () {
                    root.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    root.focus?.({ preventScroll: true });
                }, 120);
                return true;
            }

            if (typeof window.__loadGeminiScriptsNow === 'function') {
                window.__loadGeminiScriptsNow();
            }
            const placeholder = document.getElementById('gemini-placeholder');
            if (placeholder) {
                window.setTimeout(function () {
                    placeholder.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 120);
            }
            return expanded || !!placeholder;
        }

        function setGeminiButtonLoading(button, isLoading) {
            if (!button) return;
            button.disabled = !!isLoading;
            button.textContent = isLoading ? 'Loading Gemini...' : 'Gemini';
        }

        function bindEvents() {
            const runBtn = fields.byId?.('esRunBtn');
            const clearBtn = fields.byId?.('esClearBtn');
            const queryInput = fields.byId?.('esQuery');
            const typeahead = typeof modules.createUiTypeahead === 'function'
                ? modules.createUiTypeahead({
                    onRunSearch: onRunSearch,
                    getSettings: fields.collectSettings,
                    getScope: deps?.getScope
                })
                : null;
            if (runBtn) runBtn.onclick = onRunSearch;
            if (clearBtn) clearBtn.onclick = onClearFilters;
            const datapackViewBtn = fields.byId?.('nxDatapackViewBtn');
            if (datapackViewBtn) {
                datapackViewBtn.onclick = function () {
                    window.EveOS?.SearchAdvanced?.DatapackView?.openGateway?.();
                };
            }
            if (queryInput) {
                typeahead?.bind(queryInput, fields.byId?.('nxTypeahead'), fields.byId?.('nxInlineQuery'));
                queryInput.addEventListener('keypress', function (event) {
                    if (event.key === 'Enter') {
                        if (queryInput.__nexusTypeaheadHandledEnter) return;
                        event.preventDefault();
                        onRunSearch();
                    }
                });
            }

            // Wire debug diagnostics panel - render on first expand.
            const debugSection = fields.byId?.('nxDebugSection');
            if (debugSection) {
                debugSection.addEventListener('toggle', function () {
                    if (!debugSection.open) return;
                    const container = fields.byId?.('nxDebugContainer');
                    if (!container) return;
                    const DebugView = window.EveOS?.SearchAdvanced?.DebugView;
                    if (DebugView?.renderDebugPanel) {
                        DebugView.renderDebugPanel(container);
                    } else {
                        container.innerHTML = '<div style="padding:12px; color:rgba(255,120,120,0.8); font-size:0.78rem;">Debug module not loaded.</div>';
                    }
                });
            }

            // Return to the existing Audioflix tab and Nexus scope if one is already open.
            // Calling openNexus() first resets the search/facet and switches Soundboard to Music.
            const audioflixBtn = fields.byId?.('nxAudioflixLinkBtn');
            if (audioflixBtn) {
                audioflixBtn.addEventListener('click', function () {
                    if (typeof window.closeModals === 'function') window.closeModals();
                    // Reopening the retained Audioflix view preserves its active tab, groups,
                    // selected Nexus facet, search text and saved per-scope policy controls.
                    window.EveAudioflix?.open?.();
                    if (!document.querySelector('#audioflix-overlay .audioflix-nexus-panel')) {
                        // Nexus Search may also be opened directly, without an Audioflix caller.
                        window.EveAudioflix?.openNexus?.('music', true);
                    }
                });
            }

            // Wire Gemini Link button - opens Search Monitor with the Gemini workspace.
            const geminiBtn = fields.byId?.('nxGeminiLinkBtn');
            if (geminiBtn) {
                geminiBtn.addEventListener('click', function () {
                    if (openGeminiWorkspace()) return;

                    // LoadingIndicator can still be deferred; rush-load then retry once.
                    if (typeof window.__loadDeferredScriptsNow === 'function') {
                        setGeminiButtonLoading(geminiBtn, true);
                        window.__loadDeferredScriptsNow().then(function () {
                            setGeminiButtonLoading(geminiBtn, false);
                            setTimeout(openGeminiWorkspace, 100);
                        }).catch(function () {
                            setGeminiButtonLoading(geminiBtn, false);
                        });
                    }
                });
            }
        }

        function createModalIfNeeded() {
            if (fields.byId?.('expandedSearchModal')) return;
            document.body.insertAdjacentHTML('beforeend', modalTemplate);
            bindEvents();
            // Initialize Nexus Search vector toggles and stats.
            if (typeof fields.initVectorToggles === 'function') fields.initVectorToggles();
            if (typeof fields.updateFooterStats === 'function') fields.updateFooterStats();
        }

        return Object.assign({}, fields, {
            createModalIfNeeded
        });
    };
})();
