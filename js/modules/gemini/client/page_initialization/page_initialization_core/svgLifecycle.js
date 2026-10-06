/**
 * svgLifecycle.js
 * Manages SVG attribute fixing lifecycle during page initialization.
 */

window.PageInitializationCore = window.PageInitializationCore || {};

(function () {
    let monitorStarted = false;

    function getGeminiRoot() {
        return document.getElementById('gemini-provider-runtime-host')
            || document.getElementById('gemini-ui-root')
            || null;
    }

    function runScopedFixes() {
        const root = getGeminiRoot();
        if (!root) return 0;
        if (window.SvgFixingCore?.fixSvgViewBoxIssues) {
            return window.SvgFixingCore.fixSvgViewBoxIssues(root);
        }
        if (typeof window.fixSvgViewBoxIssues === 'function') {
            return window.fixSvgViewBoxIssues(root);
        }
        return 0;
    }

    window.PageInitializationCore.SvgLifecycle = {
        init: function () {
            console.log('Initializing Gemini SVG baseline fixes...');

            // Apply one bounded scoped pass, but deliberately do not attach mutation
            // observers while the workspace DOM is still being assembled.
            runScopedFixes();

            console.log('Gemini SVG baseline fix complete; live monitoring deferred until workspace ready');
        },

        startMonitoring: function () {
            if (monitorStarted) return true;
            if (typeof window.setupSvgViewBoxMonitor !== 'function') return false;
            monitorStarted = window.setupSvgViewBoxMonitor() !== false;
            return monitorStarted;
        },

        runFixes: function () {
            console.log('Applying scoped SVG fixes after Gemini component loading...');
            return runScopedFixes();
        },

        stopMonitoring: function () {
            window.SvgFixingCore?.stopSvgViewBoxMonitor?.();
            monitorStarted = false;
        }
    };
})();

console.log('svgLifecycle.js loaded.');
