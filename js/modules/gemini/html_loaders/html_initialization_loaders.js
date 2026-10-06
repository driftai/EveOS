/**
 * This file aggregates the loading and initialization logic for all HTML components.
 * It is loaded by pageInitializer.js.
 */

const HTML_LOADERS_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders';

const htmlLoaderAggregatorScripts = [
    `${HTML_LOADERS_BASE_PATH}/ext_dep/ext_dep.js?v=20261006.2`,
    `${HTML_LOADERS_BASE_PATH}/layout/layout.js?v=20261006.2`,
    `${HTML_LOADERS_BASE_PATH}/agentic/agentic.js?v=20261006.1`,
    `${HTML_LOADERS_BASE_PATH}/comm/comm.js?v=e5ce16870cac`,
    `${HTML_LOADERS_BASE_PATH}/chat_disp/chat_disp.js?v=b898bd562f74`
];

function loadHtmlLoaderAggregatorScripts() {
    console.log('html_initialization_loaders.js: Loading top-level HTML loader aggregator scripts...');
    const promises = htmlLoaderAggregatorScripts.map(scriptPath => {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = scriptPath;
            script.async = false;
            script.defer = true;
            script.onload = () => {
                console.log(`${scriptPath} loaded.`);
                resolve();
            };
            script.onerror = (error) => {
                console.error(`Failed to load ${scriptPath}:`, error);
                reject(error);
            };
            document.body.appendChild(script);
        });
    });
    return Promise.all(promises);
}

async function initializeAllHtmlComponents() {
    console.log('html_initialization_loaders.js: initializeAllHtmlComponents started.');

    try {
        await loadHtmlLoaderAggregatorScripts();
        console.log('html_initialization_loaders.js: All top-level HTML loader aggregator scripts loaded.');

        if (window.ExternalDependenciesLoadersReady) {
            await window.ExternalDependenciesLoadersReady;
        }
        if (typeof window.prepareExternalDependenciesLoaderScripts === 'function') {
            await window.prepareExternalDependenciesLoaderScripts();
            console.log('External dependency loader modules and runtimes prepared before Layout initialization.');
        } else {
            throw new Error('prepareExternalDependenciesLoaderScripts not found after ext_dep.js load');
        }

        if (window.AgenticHtmlLoadersReady) {
            await window.AgenticHtmlLoadersReady;
        }
        if (typeof window.prepareAgenticUILoaderScripts === 'function') {
            await window.prepareAgenticUILoaderScripts();
            console.log('Agentic UI loader script graph prepared before Layout initialization.');
        } else {
            throw new Error('prepareAgenticUILoaderScripts not found after agentic core load');
        }

        if (typeof window.initializeLocalStylesheet === 'function') {
            await window.initializeLocalStylesheet();
            console.log('Local Stylesheet initialized via html_initialization_loaders.js.');
        } else {
            console.error('initializeLocalStylesheet function not found.');
        }

        if (typeof window.initializeLayoutUIHtmlComponents === 'function') {
            await window.initializeLayoutUIHtmlComponents();
            console.log('Layout UI HTML Components initialized via html_initialization_loaders.js.');
        } else {
            console.error('initializeLayoutUIHtmlComponents function not found after loading layout_ui_html_loaders.js.');
        }

        if (typeof window.initializeCommunicationPanelHtmlComponents === 'function') {
            await window.initializeCommunicationPanelHtmlComponents();
            console.log('Communication Panel HTML Components initialized via html_initialization_loaders.js.');
        } else {
            console.error('initializeCommunicationPanelHtmlComponents function not found after loading communication_panel_html_loaders.js.');
        }

        if (typeof window.initializeChatLogDisplayHtmlComponents === 'function') {
            await window.initializeChatLogDisplayHtmlComponents();
            console.log('Chat Log Display HTML Components initialized via html_initialization_loaders.js.');
        } else {
            console.error('initializeChatLogDisplayHtmlComponents function not found after loading chat_log_display_components_html_loaders.js.');
        }

        if (typeof window.initializeAgenticHtmlComponents === 'function') {
            await window.initializeAgenticHtmlComponents();
            console.log('Agentic HTML Components initialized via html_initialization_loaders.js.');
        } else {
            console.error('initializeAgenticHtmlComponents function not found after loading agentic_html_loaders.js.');
        }

        if (typeof window.initializeExternalScripts === 'function') {
            await window.initializeExternalScripts();
            console.log('External Scripts initialized via html_initialization_loaders.js.');
            console.log('Skipping redundant provider-wide MDL upgrade; component loaders upgrade inserted nodes in place.');
        } else if (typeof window.initializeExternalDependenciesHtmlComponents === 'function') {
            console.warn('Using legacy initializeExternalDependenciesHtmlComponents');
            await window.initializeExternalDependenciesHtmlComponents();
        } else {
            console.error('initializeExternalScripts function not found.');
        }

        // AudioWorklet registration belongs to AudioWorkletInitializer. The historical
        // HTML loader only appends a loader whose processor-injection path is disabled,
        // so keeping it here adds a late dynamic script phase without registering audio.
        console.log('Skipping redundant Audio Worklet HTML loader phase; AudioWorkletInitializer owns processor registration.');
    } catch (error) {
        console.error('Error initializing all HTML components:', error);
    }

    console.log('html_initialization_loaders.js: initializeAllHtmlComponents finished.');
}

window.initializeAllHtmlComponents = initializeAllHtmlComponents;
