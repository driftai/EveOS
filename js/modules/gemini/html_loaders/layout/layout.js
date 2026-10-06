/**
 * This file aggregates the loading and initialization logic for Layout UI HTML components.
 */

// Define the base path for Layout UI HTML loaders
const LAYOUT_UI_HTML_LOADERS_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/layout';

// List of individual UI loader scripts for Layout UI components
const layoutUILoaderScripts = [
    `${LAYOUT_UI_HTML_LOADERS_BASE_PATH}/mdl_wrap/mdlLayoutWrapperUILoader.js?v=20261006.2`,
    `${LAYOUT_UI_HTML_LOADERS_BASE_PATH}/header/pageHeaderUILoader.js?v=9f7ec21a9f51`,
    `${LAYOUT_UI_HTML_LOADERS_BASE_PATH}/conn_stat/connectionStatusIndicatorUILoader.js?v=484117a9c62c`,
    `${LAYOUT_UI_HTML_LOADERS_BASE_PATH}/main_area/mainContentAreaContainerUILoader.js?v=ce5835c72664`,
    `${LAYOUT_UI_HTML_LOADERS_BASE_PATH}/vid_sect/videoSectionUILoader.js?v=d3ee55c53b2f`,
    `${LAYOUT_UI_HTML_LOADERS_BASE_PATH}/agentic_sect/agenticFunctionsSectionContainerUILoader.js?v=88f3d2aa62e2`,
    `${LAYOUT_UI_HTML_LOADERS_BASE_PATH}/chat_cont/chatContainerUILoader.js?v=4358087613f6`,
    `${LAYOUT_UI_HTML_LOADERS_BASE_PATH}/input_sect/textInputSectionContainerUILoader.js?v=7bc21100a932`
    // Add other UI loader scripts for Layout UI components here in the future
];

/**
 * Dynamically loads the individual Layout UI loader scripts.
 * Returns a Promise that resolves when all scripts are loaded.
 */
function loadLayoutUILoaderScripts() {
    console.log("layout_ui_html_loaders.js: Loading individual Layout UI loader scripts...");
    const promises = layoutUILoaderScripts.map(scriptPath => {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = scriptPath;
            script.defer = true; // Ensure scripts are executed in order after fetching
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
 * Initializes all Layout UI HTML components after their loader scripts are loaded.
 * Returns a Promise that resolves when all HTML components are loaded and initialized.
 */
async function initializeLayoutUIHtmlComponents() {
    console.log("layout_ui_html_loaders.js: Initializing Layout UI HTML components...");

    try {
        // Load all Layout UI loader scripts first
        await loadLayoutUILoaderScripts();

        // FIRST: Load MDL Layout Wrapper (provides foundational structure)
        if (typeof window.loadMdlLayoutWrapper === 'function') {
            await window.loadMdlLayoutWrapper();
            console.log("layout_ui_html_loaders.js: MDL Layout Wrapper loaded successfully.");
        } else {
            console.error('loadMdlLayoutWrapper function not found.');
        }

        // SECOND: Load Page Header (contains connection-status-placeholder)
        if (typeof window.loadPageHeader === 'function') {
            await window.loadPageHeader();
            console.log("layout_ui_html_loaders.js: Page Header loaded successfully.");
        } else {
            console.error('loadPageHeader function not found.');
        }

        // THIRD: Load Connection Status Indicator (depends on page header placeholder)
        if (typeof window.loadConnectionStatusIndicator === 'function') {
            await window.loadConnectionStatusIndicator();
            console.log("layout_ui_html_loaders.js: Connection Status Indicator loaded successfully.");
        } else {
            console.error('loadConnectionStatusIndicator function not found.');
        }

        // FOURTH: Load Main Content Area Container (contains all other placeholders)
        if (typeof window.loadMainContentAreaContainer === 'function') {
            await window.loadMainContentAreaContainer();
            console.log("layout_ui_html_loaders.js: Main Content Area Container loaded successfully.");
        } else {
            console.error('loadMainContentAreaContainer function not found.');
        }

        // FIFTH: Load Video Section component
        if (typeof window.loadVideoSection === 'function') {
            await window.loadVideoSection();
            console.log("layout_ui_html_loaders.js: Video Section loaded successfully.");
        } else {
            console.error('loadVideoSection function not found.');
        }

        // THEN: Load other components in parallel (they don't depend on each other)
        const otherComponentPromises = [];

        // Agentic Functions Section Container
        if (typeof window.loadAgenticFunctionsSectionContainer === 'function') {
            otherComponentPromises.push(window.loadAgenticFunctionsSectionContainer());
        } else {
            console.error('loadAgenticFunctionsSectionContainer function not found.');
        }

        // Chat Container
        if (typeof window.loadChatContainer === 'function') {
            otherComponentPromises.push(window.loadChatContainer());
        } else {
            console.error('loadChatContainer function not found.');
        }

        // Text Input Section Container
        if (typeof window.loadTextInputSectionContainer === 'function') {
            otherComponentPromises.push(window.loadTextInputSectionContainer());
        } else {
            console.error('loadTextInputSectionContainer function not found.');
        }

        // Wait for all other Layout UI components to be loaded
        await Promise.all(otherComponentPromises);
        console.log("layout_ui_html_loaders.js: All Layout UI HTML components initialized successfully.");

    } catch (error) {
        console.error("layout_ui_html_loaders.js: Error initializing Layout UI HTML components:", error);
    }
}

// Export the main initialization function
window.initializeLayoutUIHtmlComponents = initializeLayoutUIHtmlComponents; 