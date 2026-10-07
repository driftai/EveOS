/**
 * agentic_html_loaders.js
 * Entry point for the Agentic HTML Loaders module.
 * It loads the core configuration, script loader, and orchestrator,
 * preventing the "large file" issue by modularizing the logic.
 */

// Define the base path is roughly the same, but we point to core now for the initial scripts
const AGENTIC_LOADERS_CORE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/agentic/core';

const coreScripts = [
    `${AGENTIC_LOADERS_CORE_PATH}/agenticLoaderConfig.js?v=46a72d54d75a`,
    `${AGENTIC_LOADERS_CORE_PATH}/agenticScriptLoader.js?v=906cfccd546a`,
    `${AGENTIC_LOADERS_CORE_PATH}/agenticComponentOrchestrator.js?v=dd61624900f4`
];

console.log("agentic_html_loaders.js: Loading core modules...");

// Helper to load core scripts sequentially to ensure dependencies are met
function loadCoreScriptsSequentially() {
    return coreScripts.reduce((promise, scriptPath) => {
        return promise.then(() => {
            return new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = scriptPath;
                script.async = false;
                script.defer = true;
                script.onload = () => resolve();
                script.onerror = (e) => {
                    console.error(`Failed to load core script: ${scriptPath}`, e);
                    reject(e);
                };
                document.head.appendChild(script);
            });
        });
    }, Promise.resolve());
}

// Expose a real readiness promise so the top-level HTML bootstrap can prepare the
// Agentic UI script graph before Layout mutates the large Gemini workspace DOM.
window.AgenticHtmlLoadersReady = loadCoreScriptsSequentially().then(() => {
    console.log("agentic_html_loaders.js: Core modules loaded. Ready for initialization.");
    return true;
}).catch(err => {
    console.error("agentic_html_loaders.js: Critical error loading core modules:", err);
    throw err;
});