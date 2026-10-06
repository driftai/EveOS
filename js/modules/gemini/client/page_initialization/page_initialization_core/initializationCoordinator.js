/**
 * initializationCoordinator.js
 * Orchestrates the page initialization sequence: SVG baseline -> HTML Load -> Connectivity -> ready -> SVG maintenance.
 */

window.PageInitializationCore = window.PageInitializationCore || {};
let coordinatorPromise = null;

window.PageInitializationCore.Coordinator = {
    start: function () {
        if (coordinatorPromise) return coordinatorPromise;

        coordinatorPromise = (async function () {
            console.log('Initialization Coordinator: Starting sequence...');

            const Core = window.PageInitializationCore;

            // 1. Apply a bounded SVG baseline pass and initialize pre-connect UI state.
            // Live SVG observation stays off while the workspace DOM is being assembled.
            Core.SvgLifecycle.init();
            Core.ConnectivityStartup.showInitialMessage();
            Core.ConnectivityStartup.preInitReset();

            console.log('Audio context initialization deferred until user interaction');

            // 2. Load HTML Components.
            await Core.DisplayLoader.loadHtmlComponents();

            // 3. Preserve the current connectivity/readiness semantics.
            await Core.ConnectivityStartup.init();
            const detail = {
                readyAt: Date.now(),
                textInputReady: !!document.getElementById('textInput'),
                sendButtonReady: !!document.getElementById('sendButton')
            };
            window.__GEMINI_WORKSPACE_READY = detail;
            window.dispatchEvent(new CustomEvent('eve:gemini-workspace-ready', { detail }));

            // 4. SVG repair and live observation are maintenance, not prerequisites for
            // workspace readiness. Arm them after the ready boundary without adding an
            // arbitrary startup delay or changing connectivity ordering.
            const armSvgMaintenance = () => {
                try {
                    Core.SvgLifecycle.runFixes();
                    Core.SvgLifecycle.startMonitoring();
                } catch (error) {
                    console.warn('Gemini SVG maintenance could not be armed after workspace ready.', error);
                }
            };

            if (typeof window.requestIdleCallback === 'function') {
                window.requestIdleCallback(armSvgMaintenance, { timeout: 1000 });
            } else {
                window.setTimeout(armSvgMaintenance, 0);
            }

            return detail;
        })().catch(function (error) {
            console.error('Initialization Coordinator: Failed to load HTML components.', error);
            coordinatorPromise = null;
            throw error;
        });

        window.__GEMINI_WORKSPACE_PROMISE = coordinatorPromise;
        return coordinatorPromise;
    }
};

console.log('initializationCoordinator.js loaded.');
