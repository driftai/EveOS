/**
 * agenticScriptLoader.js
 * Handles the dynamic loading of agentic UI loader scripts.
 */

let agenticUiLoaderPreparationPromise = null;
let agenticUiLoaderScriptsPrepared = false;

function yieldAgenticLoaderTurn() {
    return new Promise(resolve => window.setTimeout(resolve, 0));
}

function loadAgenticUILoaderScript(scriptPath) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = scriptPath;
        script.async = false;
        script.defer = true;
        script.onload = () => resolve();
        script.onerror = (error) => {
            console.error(`Failed to load ${scriptPath}:`, error);
            reject(error);
        };
        document.head.appendChild(script);
    });
}

/**
 * Prepares the individual agentic UI loader scripts exactly once.
 *
 * This intentionally loads them one-at-a-time and yields between scripts. The
 * Gemini freeze probe showed Chromium becoming unresponsive when the old
 * Promise.all/map path appended the entire Agentic loader graph in one turn
 * after the large workspace DOM had already been inserted.
 */
function prepareAgenticUILoaderScripts() {
    if (agenticUiLoaderScriptsPrepared) return Promise.resolve(true);
    if (agenticUiLoaderPreparationPromise) return agenticUiLoaderPreparationPromise;

    console.log("agenticScriptLoader.js: Preparing individual agentic UI loader scripts sequentially...");

    if (typeof window.AgenticLoaderConfig === 'undefined' || !window.AgenticLoaderConfig.SCRIPTS) {
        console.error("AgenticLoaderConfig not found or invalid!");
        return Promise.reject(new Error("AgenticLoaderConfig missing"));
    }

    agenticUiLoaderPreparationPromise = (async () => {
        for (const scriptPath of window.AgenticLoaderConfig.SCRIPTS) {
            await loadAgenticUILoaderScript(scriptPath);
            await yieldAgenticLoaderTurn();
        }
        agenticUiLoaderScriptsPrepared = true;
        console.log("agenticScriptLoader.js: Agentic UI loader script graph prepared.");
        return true;
    })().catch(error => {
        agenticUiLoaderPreparationPromise = null;
        throw error;
    });

    return agenticUiLoaderPreparationPromise;
}

/**
 * Legacy/public entry point retained for callers outside the normal EveOS
 * bootstrap. It now shares the exact same single-flight preparation path.
 */
function loadAgenticUILoaderScripts() {
    return prepareAgenticUILoaderScripts();
}

window.prepareAgenticUILoaderScripts = prepareAgenticUILoaderScripts;
window.loadAgenticUILoaderScripts = loadAgenticUILoaderScripts;

console.log("agenticScriptLoader.js loaded.");