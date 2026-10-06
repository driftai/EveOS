/**
 * Aggregates System Message Toggle UI HTML components.
 */

const SYSTEM_MESSAGE_TOGGLE_UI_HTML_LOADERS_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/comm/sys_msg';
const systemMessageToggleUILoaderScripts = [
    `${SYSTEM_MESSAGE_TOGGLE_UI_HTML_LOADERS_BASE_PATH}/toggle_sw/systemMessageToggleSwitchUILoader.js?v=438e4d63b9b5`
];
let systemMessageTogglePreparePromise = null;

function prepareSystemMessageToggleUIScripts() {
    if (systemMessageTogglePreparePromise) return systemMessageTogglePreparePromise;
    const loadOnce = window.GeminiCommunicationBootstrap?.loadScriptOnce;
    if (typeof loadOnce !== 'function') {
        return Promise.reject(new Error('GeminiCommunicationBootstrap.loadScriptOnce unavailable for System Message Toggle'));
    }
    systemMessageTogglePreparePromise = Promise.all(systemMessageToggleUILoaderScripts.map(loadOnce)).catch((error) => {
        systemMessageTogglePreparePromise = null;
        throw error;
    });
    return systemMessageTogglePreparePromise;
}

async function initializeSystemMessageToggleUIHtmlComponents() {
    console.log('system_message_toggle_ui_html_loaders.js: initializeSystemMessageToggleUIHtmlComponents started.');
    try {
        await prepareSystemMessageToggleUIScripts();
        if (typeof window.loadSystemMessageToggleSwitch === 'function') {
            await window.loadSystemMessageToggleSwitch();
            console.log('System Message Toggle Switch HTML loaded.');
        } else {
            console.error('loadSystemMessageToggleSwitch function not found after preparation.');
        }
    } catch (error) {
        console.error('Error initializing System Message Toggle UI HTML components:', error);
        throw error;
    }
    console.log('system_message_toggle_ui_html_loaders.js: initializeSystemMessageToggleUIHtmlComponents finished.');
}

window.prepareSystemMessageToggleUIScripts = prepareSystemMessageToggleUIScripts;
window.initializeSystemMessageToggleUIHtmlComponents = initializeSystemMessageToggleUIHtmlComponents;
