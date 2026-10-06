/**
 * Aggregates Text Input UI HTML components.
 */

const TEXT_INPUT_UI_HTML_LOADERS_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/comm/input_ui';
const textInputUILoaderScripts = [
    `${TEXT_INPUT_UI_HTML_LOADERS_BASE_PATH}/input_field/text_input_field_loader.js?v=d408f9f5de93`,
    `${TEXT_INPUT_UI_HTML_LOADERS_BASE_PATH}/send_btn/sendButtonUILoader.js?v=72a18418d62b`,
    `${TEXT_INPUT_UI_HTML_LOADERS_BASE_PATH}/pop_btn/popoutButtonUILoader.js?v=e31aa00a17c6`
];
let textInputPreparePromise = null;

function prepareTextInputUIScripts() {
    if (textInputPreparePromise) return textInputPreparePromise;
    const loadOnce = window.GeminiCommunicationBootstrap?.loadScriptOnce;
    if (typeof loadOnce !== 'function') {
        return Promise.reject(new Error('GeminiCommunicationBootstrap.loadScriptOnce unavailable for Text Input'));
    }
    console.log('text_input_ui_html_loaders.js: Preparing Text Input UI loader scripts...');
    textInputPreparePromise = Promise.all(textInputUILoaderScripts.map(loadOnce)).catch((error) => {
        textInputPreparePromise = null;
        throw error;
    });
    return textInputPreparePromise;
}

async function initializeTextInputUIHtmlComponents() {
    console.log('text_input_ui_html_loaders.js: initializeTextInputUIHtmlComponents started.');

    try {
        await prepareTextInputUIScripts();

        if (typeof window.loadTextInputFieldCard === 'function') {
            await window.loadTextInputFieldCard();
            console.log('Text Input Field HTML loaded.');
        } else {
            console.error('loadTextInputFieldCard function not found after preparation.');
        }

        if (typeof window.loadSendButtonCard === 'function') {
            await window.loadSendButtonCard();
            console.log('Send Button HTML loaded.');
        } else {
            console.error('loadSendButtonCard function not found after preparation.');
        }

        if (typeof window.loadPopoutButtonCard === 'function') {
            await window.loadPopoutButtonCard();
            console.log('Popout Button HTML loaded.');
        } else {
            console.error('loadPopoutButtonCard function not found after preparation.');
        }

        if (window.LogInterfaceDisplay?.MessagingInterface?.TextInputHandling &&
            typeof window.LogInterfaceDisplay.MessagingInterface.TextInputHandling.initializeTextInputHandlers === 'function') {
            window.LogInterfaceDisplay.MessagingInterface.TextInputHandling.initializeTextInputHandlers();
            console.log('Text input handlers initialized.');
        } else {
            console.error('TextInputHandling namespace or initializeTextInputHandlers function not found.');
        }
    } catch (error) {
        console.error('Error initializing Text Input UI HTML components:', error);
        throw error;
    }

    console.log('text_input_ui_html_loaders.js: initializeTextInputUIHtmlComponents finished.');
}

window.prepareTextInputUIScripts = prepareTextInputUIScripts;
window.initializeTextInputUIHtmlComponents = initializeTextInputUIHtmlComponents;
