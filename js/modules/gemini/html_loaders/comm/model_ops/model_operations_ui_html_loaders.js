/**
 * Aggregates Model Operations UI HTML components.
 */

const MODEL_OPERATIONS_UI_HTML_LOADERS_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/comm/model_ops';
const modelOperationsUILoaderScripts = [
    `${MODEL_OPERATIONS_UI_HTML_LOADERS_BASE_PATH}/reinit_btn/reinitiateModelButtonUILoader.js?v=ca276cb7f837`,
    `${MODEL_OPERATIONS_UI_HTML_LOADERS_BASE_PATH}/new_chat_btn/newChatButtonUILoader.js?v=cc61e8a73c31`
];
let modelOperationsPreparePromise = null;

function prepareModelOperationsUIScripts() {
    if (modelOperationsPreparePromise) return modelOperationsPreparePromise;
    const loadOnce = window.GeminiCommunicationBootstrap?.loadScriptOnce;
    if (typeof loadOnce !== 'function') {
        return Promise.reject(new Error('GeminiCommunicationBootstrap.loadScriptOnce unavailable for Model Operations'));
    }
    modelOperationsPreparePromise = Promise.all(modelOperationsUILoaderScripts.map(loadOnce)).catch((error) => {
        modelOperationsPreparePromise = null;
        throw error;
    });
    return modelOperationsPreparePromise;
}

async function initializeModelOperationsUIHtmlComponents() {
    console.log('model_operations_ui_html_loaders.js: initializeModelOperationsUIHtmlComponents started.');
    try {
        await prepareModelOperationsUIScripts();
        if (typeof window.loadReinitiateModelButtonCard === 'function') {
            await window.loadReinitiateModelButtonCard();
            console.log('Reinitiate Model Button HTML loaded.');
        } else {
            console.error('loadReinitiateModelButtonCard function not found after preparation.');
        }
        if (typeof window.loadNewChatButtonCard === 'function') {
            await window.loadNewChatButtonCard();
            console.log('New Chat Button HTML loaded.');
        } else {
            console.error('loadNewChatButtonCard function not found after preparation.');
        }
    } catch (error) {
        console.error('Error initializing Model Operations UI HTML components:', error);
        throw error;
    }
    console.log('model_operations_ui_html_loaders.js: initializeModelOperationsUIHtmlComponents finished.');
}

window.prepareModelOperationsUIScripts = prepareModelOperationsUIScripts;
window.initializeModelOperationsUIHtmlComponents = initializeModelOperationsUIHtmlComponents;
