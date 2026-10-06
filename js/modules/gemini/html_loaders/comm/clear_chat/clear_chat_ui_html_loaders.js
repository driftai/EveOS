/**
 * Aggregates Clear Chat UI HTML components.
 */

const CLEAR_CHAT_UI_HTML_LOADERS_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/comm/clear_chat';
const clearChatUILoaderScripts = [
    `${CLEAR_CHAT_UI_HTML_LOADERS_BASE_PATH}/clear_btn/clearChatButtonUILoader.js?v=c28b3e726e71`
];
let clearChatPreparePromise = null;

function prepareClearChatUIScripts() {
    if (clearChatPreparePromise) return clearChatPreparePromise;
    const loadOnce = window.GeminiCommunicationBootstrap?.loadScriptOnce;
    if (typeof loadOnce !== 'function') {
        return Promise.reject(new Error('GeminiCommunicationBootstrap.loadScriptOnce unavailable for Clear Chat'));
    }
    clearChatPreparePromise = Promise.all(clearChatUILoaderScripts.map(loadOnce)).catch((error) => {
        clearChatPreparePromise = null;
        throw error;
    });
    return clearChatPreparePromise;
}

async function initializeClearChatUIHtmlComponents() {
    console.log('clear_chat_ui_html_loaders.js: initializeClearChatUIHtmlComponents started.');
    try {
        await prepareClearChatUIScripts();
        if (typeof window.loadClearChatButton === 'function') {
            await window.loadClearChatButton();
            console.log('Clear Chat Button HTML loaded.');
        } else {
            console.error('loadClearChatButton function not found after preparation.');
        }
    } catch (error) {
        console.error('Error initializing Clear Chat UI HTML components:', error);
        throw error;
    }
    console.log('clear_chat_ui_html_loaders.js: initializeClearChatUIHtmlComponents finished.');
}

window.prepareClearChatUIScripts = prepareClearChatUIScripts;
window.initializeClearChatUIHtmlComponents = initializeClearChatUIHtmlComponents;
