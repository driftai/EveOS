/**
 * agentic_html_loaders.js
 * Entry point for the Agentic HTML Loaders module.
 * It loads the core configuration, script loader, and orchestrator,
 * preventing the "large file" issue by modularizing the logic.
 */

// Define the base path is roughly the same, but we point to core now for the initial scripts
const AGENTIC_LOADERS_CORE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/agentic/core';

const coreScripts = [
    `${AGENTIC_LOADERS_CORE_PATH}/agenticLoaderConfig.js?v=614bb9bb6729`,
    `${AGENTIC_LOADERS_CORE_PATH}/agenticScriptLoader.js?v=5822a74eb324`,
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
                script.defer = true;
                script.onload = () => {
                    // console.log(`Core script loaded: ${scriptPath}`);
                    resolve();
                };
                script.onerror = (e) => {
                    console.error(`Failed to load core script: ${scriptPath}`, e);
                    reject(e);
                };
                document.head.appendChild(script);
            });
        });
    }, Promise.resolve());
}

// Start loading
loadCoreScriptsSequentially().then(() => {
    console.log("agentic_html_loaders.js: Core modules loaded. Ready for initialization.");
}).catch(err => {
    console.error("agentic_html_loaders.js: Critical error loading core modules:", err);
});
