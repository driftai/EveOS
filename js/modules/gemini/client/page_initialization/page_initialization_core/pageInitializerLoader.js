/**
 * pageInitializerLoader.js
 * Dynamically loads the modularized page initialization scripts in the correct order.
 */

console.log("pageInitializerLoader.js loading...");
let pageInitializationStarted = false;

const COMPONENT_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/client/page_initialization/page_initialization_core';

const pageInitScripts = [
    `${COMPONENT_BASE_PATH}/svgLifecycle.js?v=20261006.1`,
    `${COMPONENT_BASE_PATH}/displayLoader.js?v=20261006.2`,
    `${COMPONENT_BASE_PATH}/connectivityStartup.js?v=f701e021de2c`,
    `${COMPONENT_BASE_PATH}/initializationCoordinator.js?v=20261006.1`
];

function loadPageInitScripts() {
    const fragment = document.createDocumentFragment();
    let loadedCount = 0;

    pageInitScripts.forEach(scriptPath => {
        const script = document.createElement('script');
        script.src = scriptPath;
        // `defer` is ignored on dynamically inserted scripts; async=false is what actually
        // guarantees list-order execution instead of download-completion order.
        script.async = false;
        script.defer = true;
        script.onload = () => {
            loadedCount++;
            if (loadedCount === pageInitScripts.length) {
                // All scripts loaded, set up the entry point
                setupEntryPoint();
            }
        };
        fragment.appendChild(script);
    });

    document.head.appendChild(fragment);
}

function setupEntryPoint() {
    const startCoordinator = () => {
        if (pageInitializationStarted) return;
        if (window.PageInitializationCore && window.PageInitializationCore.Coordinator) {
            pageInitializationStarted = true;
            // Short delay to ensure DOM is ready and other scripts (like svgFixer) have executed
            setTimeout(() => {
                window.PageInitializationCore.Coordinator.start();
            }, 100);
        } else {
            console.error("PageInitializationCore not fully loaded.");
        }
    };

    const entryPoint = () => {
        // This loader is near the beginning of the master list. Wait until the
        // remaining Gemini runtime modules exist before initializing HTML that
        // binds against them.
        if (window.__GEMINI_MASTER_LOADER_ACTIVE && !window.__GEMINI_BOOT_STATE?.completedAt) {
            window.addEventListener('eve:gemini-scripts-ready', startCoordinator, { once: true });
            window.setTimeout(() => {
                if (window.__GEMINI_BOOT_STATE?.completedAt || !window.__GEMINI_MASTER_LOADER_ACTIVE) {
                    startCoordinator();
                }
            }, 0);
            return;
        }
        startCoordinator();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', entryPoint, { once: true });
    } else {
        entryPoint();
    }
}

loadPageInitScripts();

console.log("pageInitializerLoader.js finished.");
