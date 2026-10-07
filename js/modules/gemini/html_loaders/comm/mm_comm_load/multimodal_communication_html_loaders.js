/**
 * Aggregates Multimodal Communication UI HTML components.
 */

const MULTIMODAL_COMMUNICATION_HTML_LOADERS_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/comm/mm_comm_load';
const multimodalCommunicationUILoaderScripts = [
    `${MULTIMODAL_COMMUNICATION_HTML_LOADERS_BASE_PATH}/scr_share/screen_share_mm_html_loaders.js?v=389cef3dd4b4`,
    `${MULTIMODAL_COMMUNICATION_HTML_LOADERS_BASE_PATH}/voice_input/voice_input_mm_html_loader.js?v=1145171d680c`
];
let multimodalPreparePromise = null;

function prepareMultimodalCommunicationScripts() {
    if (multimodalPreparePromise) return multimodalPreparePromise;
    const loadOnce = window.GeminiCommunicationBootstrap?.loadScriptOnce;
    if (typeof loadOnce !== 'function') {
        return Promise.reject(new Error('GeminiCommunicationBootstrap.loadScriptOnce unavailable for Multimodal Communication'));
    }

    multimodalPreparePromise = (async () => {
        await Promise.all(multimodalCommunicationUILoaderScripts.map(loadOnce));

        if (typeof window.prepareScreenShareMMUIScripts !== 'function') {
            throw new Error('prepareScreenShareMMUIScripts not found after Screen Share aggregator load');
        }
        if (typeof window.prepareVoiceInputMMUIScripts !== 'function') {
            throw new Error('prepareVoiceInputMMUIScripts not found after Voice Input aggregator load');
        }

        await Promise.all([
            window.prepareScreenShareMMUIScripts(),
            window.prepareVoiceInputMMUIScripts()
        ]);
        return true;
    })().catch((error) => {
        multimodalPreparePromise = null;
        throw error;
    });

    return multimodalPreparePromise;
}

async function initializeMultimodalCommunicationHtmlComponents() {
    console.log('multimodal_communication_html_loaders.js: initializeMultimodalCommunicationHtmlComponents started.');
    try {
        await prepareMultimodalCommunicationScripts();

        if (typeof window.initializeUiComponentHtmlComponents === 'function') {
            await window.initializeUiComponentHtmlComponents();
            console.log('Screen Share MM HTML Components initialized.');
        } else {
            console.error('initializeUiComponentHtmlComponents function for Screen Share MM not found after preparation.');
        }

        if (typeof window.initializeVoiceInputMMHtmlComponents === 'function') {
            await window.initializeVoiceInputMMHtmlComponents();
            console.log('Voice Input MM HTML Components initialized.');
        } else {
            console.error('initializeVoiceInputMMHtmlComponents for Voice Input MM not found after preparation.');
        }
    } catch (error) {
        console.error('Error initializing Multimodal Communication UI HTML components:', error);
        throw error;
    }

    console.log('multimodal_communication_html_loaders.js: initializeMultimodalCommunicationHtmlComponents finished.');
}

window.prepareMultimodalCommunicationScripts = prepareMultimodalCommunicationScripts;
window.initializeMultimodalCommunicationHtmlComponents = initializeMultimodalCommunicationHtmlComponents;
