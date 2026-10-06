/**
 * Aggregates Clear System Log UI HTML components.
 */

const CLEAR_SYSTEM_LOG_UI_HTML_LOADERS_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/comm/clear_sys';
const clearSystemLogUILoaderScripts = [
    `${CLEAR_SYSTEM_LOG_UI_HTML_LOADERS_BASE_PATH}/clear_btn/clearSystemLogButtonUILoader.js?v=46b818fbfe07`
];
let clearSystemLogPreparePromise = null;

function prepareClearSystemLogUIScripts() {
    if (clearSystemLogPreparePromise) return clearSystemLogPreparePromise;
    const loadOnce = window.GeminiCommunicationBootstrap?.loadScriptOnce;
    if (typeof loadOnce !== 'function') {
        return Promise.reject(new Error('GeminiCommunicationBootstrap.loadScriptOnce unavailable for Clear System Log'));
    }
    clearSystemLogPreparePromise = Promise.all(clearSystemLogUILoaderScripts.map(loadOnce)).catch((error) => {
        clearSystemLogPreparePromise = null;
        throw error;
    });
    return clearSystemLogPreparePromise;
}

async function initializeClearSystemLogUIHtmlComponents() {
    console.log('clear_system_log_ui_html_loaders.js: initializeClearSystemLogUIHtmlComponents started.');
    try {
        await prepareClearSystemLogUIScripts();
        if (typeof window.loadClearSystemLogButton === 'function') {
            await window.loadClearSystemLogButton();
            console.log('Clear System Log Button HTML loaded.');
        } else {
            console.error('loadClearSystemLogButton function not found after preparation.');
        }
    } catch (error) {
        console.error('Error initializing Clear System Log UI HTML components:', error);
        throw error;
    }
    console.log('clear_system_log_ui_html_loaders.js: initializeClearSystemLogUIHtmlComponents finished.');
}

window.prepareClearSystemLogUIScripts = prepareClearSystemLogUIScripts;
window.initializeClearSystemLogUIHtmlComponents = initializeClearSystemLogUIHtmlComponents;
