/**
 * Aggregates Voice Input MM UI HTML components.
 */

const VOICE_INPUT_MM_HTML_LOADERS_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/comm/mm_comm_load/voice_input';
const voiceInputMMUILoaderScripts = [
    `${VOICE_INPUT_MM_HTML_LOADERS_BASE_PATH}/btn/startButtonUILoader.js?v=3875d1671528`,
    `${VOICE_INPUT_MM_HTML_LOADERS_BASE_PATH}/btn/stopButtonUILoader.js?v=455f8dbf736c`
];
let voiceInputPreparePromise = null;

function prepareVoiceInputMMUIScripts() {
    if (voiceInputPreparePromise) return voiceInputPreparePromise;
    const loadOnce = window.GeminiCommunicationBootstrap?.loadScriptOnce;
    if (typeof loadOnce !== 'function') {
        return Promise.reject(new Error('GeminiCommunicationBootstrap.loadScriptOnce unavailable for Voice Input'));
    }
    voiceInputPreparePromise = Promise.all(voiceInputMMUILoaderScripts.map(loadOnce)).catch((error) => {
        voiceInputPreparePromise = null;
        throw error;
    });
    return voiceInputPreparePromise;
}

async function initializeVoiceInputMMHtmlComponents() {
    console.log('voice_input_mm_html_loader.js: initializeVoiceInputMMHtmlComponents started.');
    try {
        await prepareVoiceInputMMUIScripts();

        if (typeof window.loadStartButton === 'function') {
            await window.loadStartButton();
            console.log('Start Button HTML loaded.');
        } else {
            console.error('loadStartButton function not found after preparation.');
        }

        if (typeof window.loadStopButton === 'function') {
            await window.loadStopButton();
            console.log('Stop Button HTML loaded.');
        } else {
            console.error('loadStopButton function not found after preparation.');
        }

        if (window.CommunicationPanel?.MultimodalCommunicationPanel?.VoiceInputMMCommunicationPanel?.VoiceInputButtonHandlers &&
            typeof window.CommunicationPanel.MultimodalCommunicationPanel.VoiceInputMMCommunicationPanel.VoiceInputButtonHandlers.initializeVoiceInputButtonHandlers === 'function') {
            window.CommunicationPanel.MultimodalCommunicationPanel.VoiceInputMMCommunicationPanel.VoiceInputButtonHandlers.initializeVoiceInputButtonHandlers();
            console.log('Voice input button handlers initialized.');
        } else {
            console.error('VoiceInputMMCommunicationPanel namespace or initializeVoiceInputButtonHandlers function not found.');
        }
    } catch (error) {
        console.error('Error initializing Voice Input MM UI HTML components:', error);
        throw error;
    }

    console.log('voice_input_mm_html_loader.js: initializeVoiceInputMMHtmlComponents finished.');
}

window.prepareVoiceInputMMUIScripts = prepareVoiceInputMMUIScripts;
window.initializeVoiceInputMMHtmlComponents = initializeVoiceInputMMHtmlComponents;
