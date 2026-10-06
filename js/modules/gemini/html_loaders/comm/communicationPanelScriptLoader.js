/**
 * Handles script preparation for Communication Panel components.
 * Depends on communicationPanelLoaderConfig.js and the shared loader exposed by comm.js.
 */

let communicationAggregatorPromise = null;
let communicationComponentPromise = null;
let communicationPreparePromise = null;

function communicationLoadScriptOnce(scriptPath) {
    const loader = window.GeminiCommunicationBootstrap?.loadScriptOnce;
    if (typeof loader !== 'function') {
        return Promise.reject(new Error('GeminiCommunicationBootstrap.loadScriptOnce is unavailable'));
    }
    return loader(scriptPath);
}

function loadCommunicationPanelUILoaderAggregatorScripts() {
    if (communicationAggregatorPromise) return communicationAggregatorPromise;

    if (!window.communicationPanelLoaderConfig) {
        return Promise.reject(new Error('communicationPanelLoaderConfig not found'));
    }

    console.log('communicationPanelScriptLoader.js: Preparing Communication Panel aggregator scripts...');
    communicationAggregatorPromise = Promise.all(
        window.communicationPanelLoaderConfig.aggregatorScripts.map(communicationLoadScriptOnce)
    ).catch((error) => {
        communicationAggregatorPromise = null;
        throw error;
    });
    return communicationAggregatorPromise;
}

function loadCommunicationPanelUILoaderScripts() {
    if (communicationComponentPromise) return communicationComponentPromise;

    if (!window.communicationPanelLoaderConfig) {
        return Promise.reject(new Error('communicationPanelLoaderConfig not found'));
    }

    console.log('communicationPanelScriptLoader.js: Preparing simple Communication Panel loader scripts...');
    communicationComponentPromise = Promise.all(
        window.communicationPanelLoaderConfig.loaderScripts.map(communicationLoadScriptOnce)
    ).catch((error) => {
        communicationComponentPromise = null;
        throw error;
    });
    return communicationComponentPromise;
}

async function prepareCommunicationPanelScripts() {
    if (communicationPreparePromise) return communicationPreparePromise;

    communicationPreparePromise = (async () => {
        await Promise.all([
            loadCommunicationPanelUILoaderAggregatorScripts(),
            loadCommunicationPanelUILoaderScripts()
        ]);

        const preparationHooks = [
            'prepareMultimodalCommunicationScripts',
            'prepareTextInputUIScripts',
            'prepareSystemMessageToggleUIScripts',
            'prepareModelOperationsUIScripts',
            'preparePastChatsUIScripts',
            'prepareSendChatHistoryScripts',
            'prepareClearChatUIScripts',
            'prepareClearSystemLogUIScripts'
        ];

        for (const hookName of preparationHooks) {
            const prepare = window[hookName];
            if (typeof prepare !== 'function') {
                throw new Error(`${hookName} not found after Communication Panel aggregator preparation`);
            }
            await prepare();
        }

        console.log('communicationPanelScriptLoader.js: Communication Panel script graph prepared.');
        return true;
    })().catch((error) => {
        communicationPreparePromise = null;
        throw error;
    });

    return communicationPreparePromise;
}

window.communicationPanelScriptLoader = {
    loadAggregators: loadCommunicationPanelUILoaderAggregatorScripts,
    loadComponents: loadCommunicationPanelUILoaderScripts,
    prepare: prepareCommunicationPanelScripts
};
