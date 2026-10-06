/**
 * This file aggregates the loading and initialization logic for External Dependencies HTML components.
 */

const EXTERNAL_DEPENDENCIES_HTML_LOADERS_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/ext_dep';

const LOCAL_STYLESHEET_LOADER_SRC = `${EXTERNAL_DEPENDENCIES_HTML_LOADERS_BASE_PATH}/loc_style/localStylesheetUILoader.js?v=ad1adc053d56`;
const EXTERNAL_SCRIPTS_LOADER_SRC = `${EXTERNAL_DEPENDENCIES_HTML_LOADERS_BASE_PATH}/ext_scripts/externalStylesheetsAndScriptsUILoader.js?v=8e8cf71cddbe`;

let localStylesheetLoaderPromise = null;
let externalScriptsLoaderPromise = null;
let externalDependenciesPreparationPromise = null;

function loadDependencyLoaderScriptOnce(src, readyCheck, label, currentPromise, setPromise) {
    if (readyCheck()) return Promise.resolve('ready');
    if (currentPromise) return currentPromise;

    const promise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = false;
        script.defer = true;
        script.onload = () => {
            console.log(`${label} loaded.`);
            if (readyCheck()) resolve('loaded');
            else reject(new Error(`${label} loaded without exposing its expected API`));
        };
        script.onerror = (error) => {
            console.error(`Failed to load ${label}:`, error);
            reject(error);
        };
        document.body.appendChild(script);
    }).catch((error) => {
        setPromise(null);
        throw error;
    });

    setPromise(promise);
    return promise;
}

function loadLocalStylesheetLoaderScript() {
    return loadDependencyLoaderScriptOnce(
        LOCAL_STYLESHEET_LOADER_SRC,
        () => typeof window.loadLocalStylesheet === 'function',
        'localStylesheetUILoader.js',
        localStylesheetLoaderPromise,
        (value) => { localStylesheetLoaderPromise = value; }
    );
}

function loadExternalScriptsLoaderScript() {
    return loadDependencyLoaderScriptOnce(
        EXTERNAL_SCRIPTS_LOADER_SRC,
        () => typeof window.loadExternalStylesheetsAndScripts === 'function',
        'externalStylesheetsAndScriptsUILoader.js',
        externalScriptsLoaderPromise,
        (value) => { externalScriptsLoaderPromise = value; }
    );
}

/**
 * Prepare external styles and runtimes while the Gemini provider DOM is still small.
 * The operation is single-flight and idempotent so later initialization can reuse the
 * same loaders/resources instead of appending them again after the workspace expands.
 */
function prepareExternalDependenciesLoaderScripts() {
    if (externalDependenciesPreparationPromise) return externalDependenciesPreparationPromise;

    externalDependenciesPreparationPromise = (async () => {
        await loadLocalStylesheetLoaderScript();
        await loadExternalScriptsLoaderScript();

        if (typeof window.prepareExternalStylesheetsAndIcons === 'function') {
            const insertedLinks = window.prepareExternalStylesheetsAndIcons();
            console.log(`external_dependencies_html_loaders.js: External stylesheets/icons prepared before Layout (${insertedLinks} inserted).`);
        } else {
            throw new Error('prepareExternalStylesheetsAndIcons not found after external loader module load');
        }

        if (typeof window.prepareMaterialDesignLiteRuntime === 'function') {
            await window.prepareMaterialDesignLiteRuntime();
            console.log('external_dependencies_html_loaders.js: Material Design Lite runtime prepared before Layout.');
        } else {
            throw new Error('prepareMaterialDesignLiteRuntime not found after external loader module load');
        }

        if (typeof window.prepareDialogPolyfillRuntime === 'function') {
            const dialogRuntime = await window.prepareDialogPolyfillRuntime();
            console.log(`external_dependencies_html_loaders.js: Dialog runtime prepared before Layout (${dialogRuntime}).`);
        } else {
            throw new Error('prepareDialogPolyfillRuntime not found after external loader module load');
        }

        console.log('external_dependencies_html_loaders.js: External dependency loader modules prepared.');
        return true;
    })().catch((error) => {
        externalDependenciesPreparationPromise = null;
        throw error;
    });

    return externalDependenciesPreparationPromise;
}

async function initializeLocalStylesheet() {
    console.log('external_dependencies_html_loaders.js: initializeLocalStylesheet started.');
    try {
        await loadLocalStylesheetLoaderScript();
        if (typeof window.loadLocalStylesheet === 'function') {
            await window.loadLocalStylesheet();
            console.log('external_dependencies_html_loaders.js: Local Stylesheet loaded.');
        } else {
            console.error('loadLocalStylesheet function not found.');
        }
    } catch (error) {
        console.error('Error initializing Local Stylesheet:', error);
    }
}

async function initializeExternalScripts() {
    console.log('external_dependencies_html_loaders.js: initializeExternalScripts started.');
    try {
        await loadExternalScriptsLoaderScript();
        if (typeof window.loadExternalStylesheetsAndScripts === 'function') {
            await window.loadExternalStylesheetsAndScripts();
            console.log('external_dependencies_html_loaders.js: External Stylesheets and Scripts loaded.');
        } else {
            console.error('loadExternalStylesheetsAndScripts function not found.');
        }
    } catch (error) {
        console.error('Error initializing External Scripts:', error);
    }
}

async function initializeExternalDependenciesHtmlComponents() {
    console.log('external_dependencies_html_loaders.js: initializeExternalDependenciesHtmlComponents started (LEGACY Mode).');
    await initializeLocalStylesheet();
    await initializeExternalScripts();
}

window.prepareExternalDependenciesLoaderScripts = prepareExternalDependenciesLoaderScripts;
window.initializeLocalStylesheet = initializeLocalStylesheet;
window.initializeExternalScripts = initializeExternalScripts;
window.initializeExternalDependenciesHtmlComponents = initializeExternalDependenciesHtmlComponents;

window.ExternalDependenciesLoadersReady = prepareExternalDependenciesLoaderScripts().catch((error) => {
    console.warn('external_dependencies_html_loaders.js: Early dependency preparation failed; will retry during initialization.', error);
    return false;
});
