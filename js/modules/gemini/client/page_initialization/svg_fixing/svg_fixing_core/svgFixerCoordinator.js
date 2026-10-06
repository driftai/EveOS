/**
 * svgFixerCoordinator.js
 * Coordinator for SVG Fixing Core.
 * Exposes core functions to the global window object for backward compatibility.
 */

window.SvgFixingCore = window.SvgFixingCore || {};

window.fixSvgViewBoxIssues = function (root) {
    if (window.SvgFixingCore.fixSvgViewBoxIssues) {
        return window.SvgFixingCore.fixSvgViewBoxIssues(root);
    }
    console.error('SvgFixingCore.fixSvgViewBoxIssues not available yet.');
    return 0;
};

window.setupSvgViewBoxMonitor = function () {
    if (window.SvgFixingCore.setupSvgViewBoxMonitor) {
        return window.SvgFixingCore.setupSvgViewBoxMonitor();
    }
    console.error('SvgFixingCore.setupSvgViewBoxMonitor not available yet.');
    return false;
};

window.stopSvgViewBoxMonitor = function () {
    window.SvgFixingCore.stopSvgViewBoxMonitor?.();
};

console.log('svgFixerCoordinator.js loaded.');
