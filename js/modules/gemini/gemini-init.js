/* js/modules/gemini/gemini-init.js */
(function () {
    const GEMINI_MONITOR_VIEW_KEY = 'eve.geminiMonitorView';

    function shouldDebugBootLogs() {
        try {
            const qs = new URLSearchParams(window.location.search || '');
            if (qs.get('debugGeminiBoot') === '1') return true;
            return window.localStorage && window.localStorage.getItem('eve.debugGeminiBoot') === '1';
        } catch (e) {
            return false;
        }
    }

    function debugBootLog() {
        if (!shouldDebugBootLogs()) return;
        console.log.apply(console, arguments);
    }

    debugBootLog('Initializing Gemini Interface Integration...');

    function normalizeMonitorView(view) {
        return String(view || '').toLowerCase() === 'full' ? 'full' : 'summary';
    }

    function getPreferredMonitorView() {
        try {
            return normalizeMonitorView(window.localStorage && window.localStorage.getItem(GEMINI_MONITOR_VIEW_KEY));
        } catch (e) {
            return 'summary';
        }
    }

    function savePreferredMonitorView(view) {
        const normalized = normalizeMonitorView(view);
        try {
            if (window.localStorage) {
                window.localStorage.setItem(GEMINI_MONITOR_VIEW_KEY, normalized);
            }
        } catch (e) {
            // Ignore storage errors.
        }
        return normalized;
    }

    function shouldEagerBoot() {
        try {
            const qs = new URLSearchParams(window.location.search || '');
            if (qs.get('geminiBoot') === 'eager') return true;
            return window.localStorage && window.localStorage.getItem('eve.geminiBoot') === 'eager';
        } catch (e) {
            return false;
        }
    }

    function requestGeminiBoot(reason) {
        window.__GEMINI_BOOT_REQUESTED = true;

        if (typeof window.__loadGeminiScriptsNow === 'function') {
            return window.__loadGeminiScriptsNow();
        }

        // Script_Loader follows this module in the manifest. Keep the request
        // durable instead of relying on a single timing-sensitive retry.
        return new Promise(function (resolve) {
            const startWhenReady = function () {
                window.removeEventListener('eve:gemini-loader-ready', startWhenReady);
                if (typeof window.__loadGeminiScriptsNow === 'function') {
                    Promise.resolve(window.__loadGeminiScriptsNow()).then(resolve);
                    return;
                }
                resolve(null);
            };
            window.addEventListener('eve:gemini-loader-ready', startWhenReady, { once: true });
            window.setTimeout(function () {
                if (typeof window.__loadGeminiScriptsNow !== 'function') return;
                startWhenReady();
            }, 250);
            debugBootLog(`Gemini Init: Boot requested (${reason || 'manual'}), waiting for Script_Loader.`);
        });
    }

    function isWorkspaceCollapsed() {
        try {
            return !!(window.localStorage && window.localStorage.getItem('geminiDemoCollapsed') === 'true');
        } catch (e) {
            return false;
        }
    }

    function syncFullUiReadiness(container) {
        if (!container) return;
        const hasFullUi = !!container.querySelector('.mdl-layout__container');
        container.dataset.geminiFullReady = hasFullUi ? '1' : '0';
    }

    function ensureExpandedWorkspace(container) {
        if (!container) return;
        try {
            if (window.localStorage) {
                window.localStorage.setItem('geminiDemoCollapsed', 'false');
            }
        } catch (e) {
            // Ignore storage errors.
        }

        container.classList.remove('gemini-collapsed-mode');
        const layout = container.querySelector('.mdl-layout');
        const layoutContainer = container.querySelector('.mdl-layout__container');
        const headerButton = container.querySelector('#header-collapse-btn');
        const headerIcon = container.querySelector('#header-collapse-icon');

        [layout, layoutContainer].forEach(function (node) {
            if (node) node.classList.remove('gemini-collapsed-mode');
        });

        if (headerButton) headerButton.title = 'Collapse Workspace';
        if (headerIcon) headerIcon.textContent = 'expand_less';
    }

    function stopFullUiPolling(container) {
        if (!container || !container.__geminiFullUiPollTimer) return;
        window.clearInterval(container.__geminiFullUiPollTimer);
        container.__geminiFullUiPollTimer = null;
    }

    function startFullUiPolling(container) {
        if (!container || container.__geminiFullUiPollTimer) return;
        const startedAt = Date.now();
        container.__geminiFullUiPollTimer = window.setInterval(function () {
            if (!document.body.contains(container) || container.dataset.geminiMonitorView !== 'full' || Date.now() - startedAt > 30000) {
                stopFullUiPolling(container);
                return;
            }
            syncFullUiReadiness(container);
            if (container.dataset.geminiFullReady === '1') {
                stopFullUiPolling(container);
            }
        }, 500);
    }

    function updateMonitorViewState(container, view) {
        if (!container) return;
        const normalized = savePreferredMonitorView(view);
        container.dataset.geminiMonitorView = normalized;
        const indicator = container.closest('#loadingIndicator');
        indicator?.classList.toggle('gemini-monitor-workspace-active', normalized === 'full');
        syncFullUiReadiness(container);

        container.querySelectorAll('[data-gemini-monitor-view-btn]').forEach(function (button) {
            const isActive = button.dataset.geminiMonitorViewBtn === normalized;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });

        // View/provider state is presentation only. Search Monitor calls onGeminiOpen
        // only after the explicit Load Gemini Workspace action marks the workspace loaded.
        window.EveOSSearchMonitorAiHome?.setWorkspaceActive?.(normalized === 'full');
        if (normalized !== 'full') {
            stopFullUiPolling(container);
        } else if (container.dataset.geminiFullReady === '1'
                && window.EveOSSearchMonitorAiHome?.isGeminiOpen?.() && !isWorkspaceCollapsed()) {
            ensureExpandedWorkspace(container);
        }
    }

    function bindMonitorViewControls(container) {
        if (!container || container.dataset.geminiMonitorViewBound === '1') return;
        container.dataset.geminiMonitorViewBound = '1';

        container.querySelectorAll('[data-gemini-monitor-view-btn]').forEach(function (button) {
            button.addEventListener('click', function () {
                updateMonitorViewState(container, button.dataset.geminiMonitorViewBtn);
            });
        });
    }

    function openGeminiProvider(container) {
        if (!container || container.dataset.geminiMonitorView !== 'full') return;
        // Explicit Load Gemini Workspace owns expansion and heavy frontend boot.
        ensureExpandedWorkspace(container);
        requestGeminiBoot('gemini-provider-explicit-load');
        startFullUiPolling(container);
    }

    window.addEventListener('eve:gemini-workspace-ready', function () {
        const container = document.getElementById('gemini-ui-root');
        syncFullUiReadiness(container);
        if (container?.dataset.geminiFullReady === '1') {
            stopFullUiPolling(container);
        }
    });

    function injectGeminiUI() {
        if (document.getElementById('gemini-ui-root')) {
            return;
        }

        const geminiContainer = document.createElement('div');
        geminiContainer.id = 'gemini-ui-root';
        geminiContainer.className = 'gemini-monitor-shell';
        geminiContainer.tabIndex = 0;

        const aiHome = window.EveOSSearchMonitorAiHome;
        if (!aiHome) {
            debugBootLog('Gemini Init: AI Home shell not ready, waiting...');
            setTimeout(injectGeminiUI, 250);
            return;
        }
        geminiContainer.innerHTML = aiHome.markup();

        let target = document.getElementById('gemini-placeholder');
        if (target) {
            target.appendChild(geminiContainer);
            debugBootLog('Gemini Init: UI injected into placeholder.');
        } else {
            const indicatorContent = document.querySelector('#loadingIndicator .indicator-content');
            if (!indicatorContent || !indicatorContent.querySelector('.indicator-title')) {
                debugBootLog('Gemini Init: Search Monitor structure not ready, waiting...');
                setTimeout(injectGeminiUI, 500);
                return;
            }
            const title = indicatorContent.querySelector('.indicator-title');
            if (title && title.nextSibling) {
                indicatorContent.insertBefore(geminiContainer, title.nextSibling);
            } else {
                indicatorContent.prepend(geminiContainer);
            }
            debugBootLog('Gemini Init: UI injected using fallback order logic.');
        }

        aiHome.bind(geminiContainer, {
            onGeminiOpen: function () { openGeminiProvider(geminiContainer); }
        });
        bindMonitorViewControls(geminiContainer);
        syncFullUiReadiness(geminiContainer);
        updateMonitorViewState(geminiContainer, getPreferredMonitorView());

        if (shouldEagerBoot()) {
            requestGeminiBoot('eager-setting');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectGeminiUI);
    } else {
        injectGeminiUI();
    }
})();