/**
 * This file aggregates the loading and initialization logic for all HTML components.
 * It is loaded by pageInitializer.js.
 */

// Define the base path for HTML loaders
const HTML_LOADERS_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders';

// List of top-level HTML loader aggregator scripts
const htmlLoaderAggregatorScripts = [
    `${HTML_LOADERS_BASE_PATH}/ext_dep/ext_dep.js?v=bab48b0bba0b`, // External dependencies should load first
    `${HTML_LOADERS_BASE_PATH}/layout/layout.js?v=a99ac3b891a6`, // Layout UI group aggregator
    `${HTML_LOADERS_BASE_PATH}/agentic/agentic.js?v=e6056319099e`,
    `${HTML_LOADERS_BASE_PATH}/comm/comm.js?v=e5ce16870cac`,
    `${HTML_LOADERS_BASE_PATH}/chat_disp/chat_disp.js?v=b898bd562f74`, // Added new group aggregator
    `${HTML_LOADERS_BASE_PATH}/audio_worklet/audio_worklet.js?v=b08645d3954c` // Audio worklet components group aggregator
];

/**
 * Dynamically loads the top-level HTML loader aggregator scripts.
 * Returns a Promise that resolves when all scripts are loaded.
 */
function loadHtmlLoaderAggregatorScripts() {
    console.log("html_initialization_loaders.js: Loading top-level HTML loader aggregator scripts...");
    const promises = htmlLoaderAggregatorScripts.map(scriptPath => {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = scriptPath;
            // `defer` is ignored on dynamically inserted scripts; async=false is what actually
            // guarantees list-order execution instead of download-completion order.
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

/**
 * Initializes the loading and setup of all HTML components by calling their respective aggregators.
 */
async function initializeAllHtmlComponents() {
    console.log("html_initialization_loaders.js: initializeAllHtmlComponents started.");

    try {
        // First, dynamically load all the top-level aggregator scripts
        await loadHtmlLoaderAggregatorScripts();
        console.log("html_initialization_loaders.js: All top-level HTML loader aggregator scripts loaded.");

        // Now that the aggregator scripts are loaded, their initialization functions should be available.

        // Initialize Critical CSS (Local Stylesheet) FIRST
        if (typeof window.initializeLocalStylesheet === 'function') {
            await window.initializeLocalStylesheet();
            console.log('Local Stylesheet initialized via html_initialization_loaders.js.');
        } else {
            console.error('initializeLocalStylesheet function not found.');
        }

        // Initialize Layout UI HTML Components
        if (typeof window.initializeLayoutUIHtmlComponents === 'function') {
            await window.initializeLayoutUIHtmlComponents();
            console.log('Layout UI HTML Components initialized via html_initialization_loaders.js.');
        } else {
            console.error('initializeLayoutUIHtmlComponents function not found after loading layout_ui_html_loaders.js.');
        }

        // Initialize Communication Panel HTML Components (Must be before Chat Log Display because buttons render into panel placeholders)
        if (typeof window.initializeCommunicationPanelHtmlComponents === 'function') {
            await window.initializeCommunicationPanelHtmlComponents();
            console.log('Communication Panel HTML Components initialized via html_initialization_loaders.js.');
        } else {
            console.error('initializeCommunicationPanelHtmlComponents function not found after loading communication_panel_html_loaders.js.');
        }

        // Initialize Chat Log Display HTML Components
        if (typeof window.initializeChatLogDisplayHtmlComponents === 'function') {
            await window.initializeChatLogDisplayHtmlComponents();
            console.log('Chat Log Display HTML Components initialized via html_initialization_loaders.js.');
        } else {
            console.error('initializeChatLogDisplayHtmlComponents function not found after loading chat_log_display_components_html_loaders.js.');
        }

        // Initialize Agentic HTML Components
        if (typeof window.initializeAgenticHtmlComponents === 'function') {
            await window.initializeAgenticHtmlComponents();
            console.log('Agentic HTML Components initialized via html_initialization_loaders.js.');
        } else {
            console.error('initializeAgenticHtmlComponents function not found after loading agentic_html_loaders.js.');
        }

        // Initialize External Scripts (MDL) LAST to allow visual render first
        if (typeof window.initializeExternalScripts === 'function') {
            await window.initializeExternalScripts();
            console.log('External Scripts initialized via html_initialization_loaders.js.');

            // Give a small delay to ensure MDL is fully ready
            await new Promise(resolve => setTimeout(resolve, 200));

            // Upgrade ALL components now that MDL is loaded
            if (typeof componentHandler !== 'undefined' && componentHandler.upgradeDom) {
                console.log('Upgrading all DOM elements with MDL...');
                componentHandler.upgradeDom();
            }

        } else {
            // Fallback to legacy if granular function missing
            if (typeof window.initializeExternalDependenciesHtmlComponents === 'function') {
                console.warn("Using legacy initializeExternalDependenciesHtmlComponents");
                await window.initializeExternalDependenciesHtmlComponents();
            } else {
                console.error('initializeExternalScripts function not found.');
            }
        }

        // Initialize Audio Worklet Components HTML Components
        if (typeof window.loadAudioWorkletComponentsHTMLLoaders === 'function') {
            await window.loadAudioWorkletComponentsHTMLLoaders();
            console.log('Audio Worklet Components HTML Loaders loaded via html_initialization_loaders.js.');

            // Load the PCM processor script component
            if (typeof window.loadPcmProcessorScript === 'function') {
                await window.loadPcmProcessorScript();
                console.log('PCM Processor Script HTML Component loaded via html_initialization_loaders.js.');
            } else {
                console.error('loadPcmProcessorScript function not found after loading audio worklet components HTML loaders.');
            }
        } else {
            console.error('loadAudioWorkletComponentsHTMLLoaders function not found after loading audio_worklet_components_html_loaders.js.');
        }

        // If there were a general UI component loader (like the old initializeUiComponentHtmlComponents), it would be called here.
        // For now, screen_share related UI (video/canvas) is under MultimodalCommunication.

    } catch (error) {
        console.error("Error initializing all HTML components:", error);
    }

    console.log("html_initialization_loaders.js: initializeAllHtmlComponents finished.");
}

// Export the main initialization function to be called by pageInitializer.js
window.initializeAllHtmlComponents = initializeAllHtmlComponents;
