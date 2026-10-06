/**
 * This file aggregates the loading and initialization logic for Chat Log Display HTML components.
 */

const CHAT_LOG_DISPLAY_HTML_LOADERS_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/chat_disp';

const chatLogDisplayScripts = [
    `${CHAT_LOG_DISPLAY_HTML_LOADERS_BASE_PATH}/main_chat/mainChatLogUILoader.js?v=5e482b6a052f`,
    `${CHAT_LOG_DISPLAY_HTML_LOADERS_BASE_PATH}/logCopyRuntime.js?v=4ef10c50d114`,
    `${CHAT_LOG_DISPLAY_HTML_LOADERS_BASE_PATH}/prev_conv/previousConversationLogDisplayLoader.js?v=224c49910a10`,
    `${CHAT_LOG_DISPLAY_HTML_LOADERS_BASE_PATH}/toggle_hist/toggleConversationHistoryButtonUILoader.js?v=8d3d716beedc`,
    `${CHAT_LOG_DISPLAY_HTML_LOADERS_BASE_PATH}/sys_log/systemLogDisplayUILoader.js?v=278b34ce00e1`,
    (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/logs/sys_log/server_reboot_button/serverRebootButtonHandler.js?v=9e7bfdb6ff94',
    (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/comm/hist_toggle/conversation_history_ui/previousConversationClearHandler.js?v=316ce84da1c4',
    (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/comm/hist_toggle/conversation_history_ui/conversationHistoryToggler.js?v=0a5b38918cbb'
];

const chatLogDisplayScriptPromises = new Map();
let chatLogDisplayPreparationPromise = null;

function normalizeChatLogScriptPath(path) {
    try {
        return new URL(path, window.location.href).href;
    } catch (error) {
        return String(path || '');
    }
}

function loadChatLogDisplayScriptOnce(scriptPath) {
    const key = normalizeChatLogScriptPath(scriptPath);
    if (chatLogDisplayScriptPromises.has(key)) return chatLogDisplayScriptPromises.get(key);

    const existing = Array.from(document.querySelectorAll('script[src]')).find((node) => {
        return normalizeChatLogScriptPath(node.getAttribute('src')) === key;
    });
    if (existing) {
        const ready = Promise.resolve('existing');
        chatLogDisplayScriptPromises.set(key, ready);
        return ready;
    }

    const promise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = scriptPath;
        script.async = false;
        script.onload = () => {
            console.log(`${scriptPath} loaded.`);
            resolve('loaded');
        };
        script.onerror = (error) => {
            console.error(`Failed to load ${scriptPath}:`, error);
            chatLogDisplayScriptPromises.delete(key);
            reject(error);
        };
        document.body.appendChild(script);
    });

    chatLogDisplayScriptPromises.set(key, promise);
    return promise;
}

function prepareChatLogDisplayScripts() {
    if (chatLogDisplayPreparationPromise) return chatLogDisplayPreparationPromise;

    console.log('chat_log_display_components_html_loaders.js: Preparing Chat Log Display scripts...');
    chatLogDisplayPreparationPromise = Promise.all(
        chatLogDisplayScripts.map(loadChatLogDisplayScriptOnce)
    ).then(() => {
        console.log('chat_log_display_components_html_loaders.js: Chat Log Display script graph prepared.');
        return true;
    }).catch((error) => {
        chatLogDisplayPreparationPromise = null;
        throw error;
    });

    return chatLogDisplayPreparationPromise;
}

function loadChatLogDisplayScripts() {
    return prepareChatLogDisplayScripts();
}

async function initializeChatLogDisplayHtmlComponents() {
    console.log('chat_log_display_components_html_loaders.js: initializeChatLogDisplayHtmlComponents started.');

    try {
        await prepareChatLogDisplayScripts();
        console.log('chat_log_display_components_html_loaders.js: All Chat Log Display scripts loaded.');

        if (typeof window.loadMainChatLog === 'function') {
            await window.loadMainChatLog();
            console.log('Main Chat Log HTML loaded.');
        } else {
            console.error('loadMainChatLog function not found after dynamic loading.');
        }

        if (typeof window.loadPreviousConversationLogCard === 'function') {
            await window.loadPreviousConversationLogCard();
            console.log('Previous Conversation Log HTML loaded and handler initialized.');
        } else {
            console.error('loadPreviousConversationLogCard function not found after dynamic loading.');
        }

        if (typeof window.loadToggleConversationHistoryButton === 'function') {
            await window.loadToggleConversationHistoryButton();
            console.log('Toggle Conversation History Button HTML loaded.');
        } else {
            console.error('loadToggleConversationHistoryButton function not found after dynamic loading.');
        }

        if (typeof window.loadSystemLogDisplay === 'function') {
            await window.loadSystemLogDisplay();
            console.log('System Log Display HTML loaded.');
        } else {
            console.error('loadSystemLogDisplay function not found after dynamic loading.');
        }

        if (window.CommunicationPanel &&
            window.CommunicationPanel.ToggleConversationHistoryCommuicationPanel &&
            window.CommunicationPanel.ToggleConversationHistoryCommuicationPanel.ConversationHistoryUI &&
            typeof window.CommunicationPanel.ToggleConversationHistoryCommuicationPanel.ConversationHistoryUI.initializeConversationHistoryToggler === 'function') {
            window.CommunicationPanel.ToggleConversationHistoryCommuicationPanel.ConversationHistoryUI.initializeConversationHistoryToggler();
            console.log('Conversation history toggler initialized from aggregator after button and log display are loaded.');
        } else {
            console.error('ConversationHistoryUI namespace or initializeConversationHistoryToggler function not found when trying to initialize from aggregator.');
        }
    } catch (error) {
        console.error('Error initializing Chat Log Display HTML components and handlers:', error);
        throw error;
    }

    console.log('chat_log_display_components_html_loaders.js: initializeChatLogDisplayHtmlComponents finished.');
}

window.prepareChatLogDisplayScripts = prepareChatLogDisplayScripts;
window.loadChatLogDisplayScripts = loadChatLogDisplayScripts;
window.initializeChatLogDisplayHtmlComponents = initializeChatLogDisplayHtmlComponents;
