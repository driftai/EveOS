/**
 * Aggregates Send Chat History UI HTML components.
 */

const SEND_CHAT_HISTORY_UI_HTML_LOADERS_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/comm/send_hist';
const sendChatHistoryUILoaderScripts = [
    `${SEND_CHAT_HISTORY_UI_HTML_LOADERS_BASE_PATH}/send_btn/sendHistoryButtonUILoader.js?v=e60ae6c7b4a3`
];
const sendChatHistoryFunctionalityScripts = [
    (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/comm/send_hist/chat_history_sending_operations/chatHistorySender.js?v=2f8ee5d0ffb7'
];
let sendChatHistoryPreparePromise = null;

function prepareSendChatHistoryScripts() {
    if (sendChatHistoryPreparePromise) return sendChatHistoryPreparePromise;
    const loadOnce = window.GeminiCommunicationBootstrap?.loadScriptOnce;
    if (typeof loadOnce !== 'function') {
        return Promise.reject(new Error('GeminiCommunicationBootstrap.loadScriptOnce unavailable for Send Chat History'));
    }
    console.log('send_chat_history_html_loader.js: Preparing Send Chat History scripts...');
    sendChatHistoryPreparePromise = Promise.all([
        ...sendChatHistoryFunctionalityScripts.map(loadOnce),
        ...sendChatHistoryUILoaderScripts.map(loadOnce)
    ]).catch((error) => {
        sendChatHistoryPreparePromise = null;
        throw error;
    });
    return sendChatHistoryPreparePromise;
}

async function initializeSendChatHistoryUIHtmlComponents() {
    console.log('send_chat_history_html_loader.js: initializeSendChatHistoryUIHtmlComponents started.');
    try {
        await prepareSendChatHistoryScripts();
        if (typeof window.loadSendChatHistoryButton === 'function') {
            await window.loadSendChatHistoryButton();
            console.log('Send Chat History Button HTML loaded and handler initialized.');
        } else {
            console.warn('loadSendChatHistoryButton function not found after preparation.');
        }
    } catch (error) {
        console.error('send_chat_history_html_loader.js: Error in initializeSendChatHistoryUIHtmlComponents:', error);
        throw error;
    }
    console.log('send_chat_history_html_loader.js: initializeSendChatHistoryUIHtmlComponents finished.');
}

window.prepareSendChatHistoryScripts = prepareSendChatHistoryScripts;
window.initializeSendChatHistoryUIHtmlComponents = initializeSendChatHistoryUIHtmlComponents;
