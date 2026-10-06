/**
 * Aggregates Screen Share MM UI HTML components.
 */

const UI_COMPONENT_HTML_LOADERS_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/comm/mm_comm_load/scr_share';
const uiComponentLoaderScripts = [
    `${UI_COMPONENT_HTML_LOADERS_BASE_PATH}/btn/screenShareButtonLoader.js?v=6ce18e34a523`,
    `${UI_COMPONENT_HTML_LOADERS_BASE_PATH}/vid_canv/video_canvas_elements_loader.js?v=c9920ebf39e1`
];
let screenSharePreparePromise = null;

function prepareScreenShareMMUIScripts() {
    if (screenSharePreparePromise) return screenSharePreparePromise;
    const loadOnce = window.GeminiCommunicationBootstrap?.loadScriptOnce;
    if (typeof loadOnce !== 'function') {
        return Promise.reject(new Error('GeminiCommunicationBootstrap.loadScriptOnce unavailable for Screen Share'));
    }
    screenSharePreparePromise = Promise.all(uiComponentLoaderScripts.map(loadOnce)).catch((error) => {
        screenSharePreparePromise = null;
        throw error;
    });
    return screenSharePreparePromise;
}

async function initializeUiComponentHtmlComponents() {
    console.log('ui_component_html_loaders.js: initializeUiComponentHtmlComponents started.');
    let screenShareButtonElement = null;

    try {
        await prepareScreenShareMMUIScripts();

        if (typeof window.loadScreenShareButton === 'function') {
            screenShareButtonElement = await window.loadScreenShareButton();
            if (screenShareButtonElement) console.log('Screen Share Button loaded and element stored.');
            else console.error('Screen Share Button loaded but element was not returned.');
        } else {
            console.error('loadScreenShareButton function not found after preparation.');
        }

        if (window.MediaDisplayElementsHTMLLoader && typeof window.MediaDisplayElementsHTMLLoader.loadVideoCanvasElements === 'function') {
            await window.MediaDisplayElementsHTMLLoader.loadVideoCanvasElements(screenShareButtonElement);
            console.log('Video and Canvas elements loaded and initialized.');
        } else {
            console.error('loadVideoCanvasElements function not found after preparation.');
        }
    } catch (error) {
        console.error('Error initializing UI HTML components:', error);
        throw error;
    }

    console.log('ui_component_html_loaders.js: initializeUiComponentHtmlComponents finished.');
}

window.prepareScreenShareMMUIScripts = prepareScreenShareMMUIScripts;
window.initializeUiComponentHtmlComponents = initializeUiComponentHtmlComponents;
