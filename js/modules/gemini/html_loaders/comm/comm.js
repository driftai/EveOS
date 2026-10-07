/**
 * Entry point for the Communication Panel UI HTML loaders.
 * Script preparation is separate from DOM initialization so Communication Panel
 * JavaScript can execute before Layout inserts the large Gemini workspace DOM.
 */

const COMMUNICATION_PANEL_MODULE_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/comm';
const communicationScriptPromises = window.__geminiCommunicationScriptPromises || new Map();
window.__geminiCommunicationScriptPromises = communicationScriptPromises;

function normalizeCommunicationScriptPath(scriptPath) {
    try {
        return new URL(scriptPath, document.baseURI).href;
    } catch (_) {
        return String(scriptPath || '');
    }
}

function loadCommunicationScriptOnce(scriptPath) {
    const normalizedPath = normalizeCommunicationScriptPath(scriptPath);
    if (!normalizedPath) return Promise.reject(new Error('Missing Communication Panel script path'));

    const cached = communicationScriptPromises.get(normalizedPath);
    if (cached) return cached;

    const existing = Array.from(document.scripts || []).find((script) => script.src === normalizedPath);
    if (existing?.dataset?.geminiCommunicationLoaded === 'true') {
        const ready = Promise.resolve(existing);
        communicationScriptPromises.set(normalizedPath, ready);
        return ready;
    }

    const promise = new Promise((resolve, reject) => {
        const script = existing || document.createElement('script');
        let settled = false;

        const finish = () => {
            if (settled) return;
            settled = true;
            script.dataset.geminiCommunicationLoaded = 'true';
            console.log(`Communication module ready: ${scriptPath}`);
            resolve(script);
        };
        const fail = (error) => {
            if (settled) return;
            settled = true;
            communicationScriptPromises.delete(normalizedPath);
            console.error(`Failed to load Communication module: ${scriptPath}`, error);
            reject(error instanceof Error ? error : new Error(`Failed to load ${scriptPath}`));
        };

        script.addEventListener('load', finish, { once: true });
        script.addEventListener('error', fail, { once: true });

        if (!existing) {
            script.src = scriptPath;
            script.async = false;
            script.defer = true;
            script.dataset.geminiCommunicationScript = 'true';
            (document.head || document.documentElement).appendChild(script);
        } else if (script.readyState === 'complete' || script.readyState === 'loaded') {
            finish();
        }
    });

    communicationScriptPromises.set(normalizedPath, promise);
    return promise;
}

let communicationPreparationPromise = null;

async function prepareCommunicationPanelModules() {
    if (communicationPreparationPromise) return communicationPreparationPromise;

    communicationPreparationPromise = (async () => {
        console.log('comm.js: Preparing Communication Panel modules before layout...');

        // Normal EveOS boot places these bootstrap files beside comm.js in the
        // top-level HTML-loader batch. Keep bounded fallback loading for standalone
        // or legacy entry points that still load only comm.js.
        if (!window.communicationPanelLoaderConfig) {
            await loadCommunicationScriptOnce(
                `${COMMUNICATION_PANEL_MODULE_BASE_PATH}/communicationPanelLoaderConfig.js?v=85f2668919a2`
            );
        }
        if (!window.communicationPanelScriptLoader?.prepare) {
            await loadCommunicationScriptOnce(
                `${COMMUNICATION_PANEL_MODULE_BASE_PATH}/communicationPanelScriptLoader.js?v=1aad8be40f64`
            );
        }
        if (typeof window.initializeCommunicationPanelComponents !== 'function') {
            await loadCommunicationScriptOnce(
                `${COMMUNICATION_PANEL_MODULE_BASE_PATH}/communicationPanelComponentInitializer.js?v=1f70125d6ce4`
            );
        }

        if (!window.communicationPanelScriptLoader?.prepare) {
            throw new Error('communicationPanelScriptLoader.prepare not found after bootstrap load');
        }

        await window.communicationPanelScriptLoader.prepare();
        console.log('comm.js: Communication Panel scripts prepared before layout.');
        return true;
    })().catch((error) => {
        communicationPreparationPromise = null;
        throw error;
    });

    return communicationPreparationPromise;
}

async function initializeCommunicationPanelHtmlComponents() {
    console.log('comm.js: Initializing preloaded Communication Panel modules...');

    try {
        await prepareCommunicationPanelModules();

        if (typeof window.initializeCommunicationPanelComponents === 'function') {
            await window.initializeCommunicationPanelComponents();
        } else {
            console.error('window.initializeCommunicationPanelComponents not found after preparation!');
        }
    } catch (error) {
        console.error('Error bootstrapping Communication Panel:', error);
        throw error;
    }
}

window.GeminiCommunicationBootstrap = {
    loadScriptOnce: loadCommunicationScriptOnce,
    prepare: prepareCommunicationPanelModules,
    isPrepared: () => !!communicationPreparationPromise
};
window.prepareCommunicationPanelModules = prepareCommunicationPanelModules;
window.initializeCommunicationPanelHtmlComponents = initializeCommunicationPanelHtmlComponents;
