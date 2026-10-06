/**
 * Aggregates Past Chats UI HTML components.
 */

const PAST_CHATS_UI_HTML_LOADERS_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/comm/past_chats';
const pastChatsUILoaderScripts = [
    `${PAST_CHATS_UI_HTML_LOADERS_BASE_PATH}/toggle_btn/togglePastChatsButtonUILoader.js?v=9bb28051ab84`
];
let pastChatsPreparePromise = null;

function preparePastChatsUIScripts() {
    if (pastChatsPreparePromise) return pastChatsPreparePromise;
    const loadOnce = window.GeminiCommunicationBootstrap?.loadScriptOnce;
    if (typeof loadOnce !== 'function') {
        return Promise.reject(new Error('GeminiCommunicationBootstrap.loadScriptOnce unavailable for Past Chats'));
    }
    pastChatsPreparePromise = Promise.all(pastChatsUILoaderScripts.map(loadOnce)).catch((error) => {
        pastChatsPreparePromise = null;
        throw error;
    });
    return pastChatsPreparePromise;
}

async function initializePastChatsUIHtmlComponents() {
    console.log('past_chats_ui_html_loaders.js: initializePastChatsUIHtmlComponents started.');
    try {
        await preparePastChatsUIScripts();
        if (typeof window.loadTogglePastChatsButton === 'function') {
            await window.loadTogglePastChatsButton();
            console.log('Toggle Past Chats Button HTML loaded.');
        } else {
            console.error('loadTogglePastChatsButton function not found after preparation.');
        }
    } catch (error) {
        console.error('Error initializing Past Chats UI HTML components:', error);
        throw error;
    }
    console.log('past_chats_ui_html_loaders.js: initializePastChatsUIHtmlComponents finished.');
}

window.preparePastChatsUIScripts = preparePastChatsUIScripts;
window.initializePastChatsUIHtmlComponents = initializePastChatsUIHtmlComponents;
