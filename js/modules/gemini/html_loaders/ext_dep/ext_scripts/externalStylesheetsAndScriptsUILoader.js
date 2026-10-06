/**
 * Loads the external styles and runtimes used by the Gemini workspace.
 * Resource insertion is idempotent so pre-layout preparation and late verification
 * can safely share the same path.
 */

const MATERIAL_DESIGN_LITE_SCRIPT_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/material-design-lite/1.3.0/material.min.js';
const DIALOG_POLYFILL_SCRIPT_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/dialog-polyfill/0.5.6/dialog-polyfill.min.js';

let materialDesignLiteRuntimePromise = null;
let dialogPolyfillRuntimePromise = null;

function normalizeExternalUrl(url) {
    try {
        return new URL(url, document.baseURI).href;
    } catch (error) {
        return String(url || '');
    }
}

function hasExternalLink(href, rel) {
    const target = normalizeExternalUrl(href);
    return Array.from(document.querySelectorAll('link[href]')).some((link) => {
        return normalizeExternalUrl(link.href) === target && (!rel || link.rel === rel);
    });
}

function appendExternalLinkOnce(headElement, resource) {
    if (hasExternalLink(resource.href, resource.rel)) return false;

    const link = document.createElement('link');
    link.rel = resource.rel;
    link.href = resource.href;
    if (resource.customType) link.type = resource.customType;
    if (resource.key) link.dataset.eveGeminiExternalLink = resource.key;
    headElement.appendChild(link);
    return true;
}

function hasNativeDialogSupport() {
    const Dialog = window.HTMLDialogElement;
    const prototype = Dialog && Dialog.prototype;
    return !!prototype
        && typeof prototype.showModal === 'function'
        && typeof prototype.close === 'function';
}

function getExternalLinkResources() {
    const appRoot = (window.GEMINI_APP_ROOT || '').replace(/\\/g, '/');
    const normalizedRoot = appRoot && !appRoot.endsWith('/') ? `${appRoot}/` : appRoot;
    const resources = [
        {
            key: 'material-icons',
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/icon?family=Material+Icons'
        },
        {
            key: 'material-design-lite',
            rel: 'stylesheet',
            href: 'https://cdnjs.cloudflare.com/ajax/libs/material-design-lite/1.3.0/material.cyan-light_blue.min.css'
        },
        {
            key: 'favicon',
            rel: 'icon',
            href: `${normalizedRoot}server/images/favicon.ico`,
            customType: 'image/x-icon'
        }
    ];

    if (!hasNativeDialogSupport()) {
        resources.push({
            key: 'dialog-polyfill',
            rel: 'stylesheet',
            href: 'https://cdnjs.cloudflare.com/ajax/libs/dialog-polyfill/0.5.6/dialog-polyfill.min.css'
        });
    }

    return resources;
}

function prepareExternalStylesheetsAndIcons() {
    const headElement = document.head;
    if (!headElement) {
        throw new Error('Document head element not found');
    }

    let insertedCount = 0;
    getExternalLinkResources().forEach((resource) => {
        if (appendExternalLinkOnce(headElement, resource)) insertedCount++;
    });
    return insertedCount;
}

function findExternalScript(src) {
    const target = normalizeExternalUrl(src);
    return Array.from(document.scripts || []).find((script) => normalizeExternalUrl(script.src) === target) || null;
}

function loadExternalScriptOnce(src, label, readyCheck) {
    if (typeof readyCheck === 'function' && readyCheck()) {
        return Promise.resolve('ready');
    }

    const existing = findExternalScript(src);
    if (existing?.dataset?.eveGeminiExternalLoaded === '1') {
        return Promise.resolve('loaded');
    }

    return new Promise((resolve) => {
        const script = existing || document.createElement('script');
        let settled = false;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            if (result === 'loaded') script.dataset.eveGeminiExternalLoaded = '1';
            resolve(result);
        };

        const timeoutId = setTimeout(() => {
            console.warn(`externalStylesheetsAndScriptsUILoader.js: Timeout waiting for script: ${src}`);
            finish('timeout');
        }, 5000);

        script.addEventListener('load', () => {
            console.log(`externalStylesheetsAndScriptsUILoader.js: Script loaded: ${src}`);
            finish('loaded');
        }, { once: true });
        script.addEventListener('error', (error) => {
            console.warn(`externalStylesheetsAndScriptsUILoader.js: Script failed to load: ${src}`, error);
            finish('error');
        }, { once: true });

        if (!existing) {
            script.src = src;
            script.async = true;
            script.dataset.eveGeminiExternalRuntime = label || 'external';
            document.head.appendChild(script);
        } else if (typeof readyCheck === 'function' && readyCheck()) {
            finish('ready');
        }
    });
}

function prepareMaterialDesignLiteRuntime() {
    if (typeof window.componentHandler !== 'undefined' && window.componentHandler.upgradeAllRegistered) {
        return Promise.resolve('ready');
    }
    if (materialDesignLiteRuntimePromise) return materialDesignLiteRuntimePromise;

    materialDesignLiteRuntimePromise = loadExternalScriptOnce(
        MATERIAL_DESIGN_LITE_SCRIPT_SRC,
        'material-design-lite',
        () => typeof window.componentHandler !== 'undefined' && !!window.componentHandler.upgradeAllRegistered
    ).catch((error) => {
        materialDesignLiteRuntimePromise = null;
        throw error;
    });

    return materialDesignLiteRuntimePromise;
}

function prepareDialogPolyfillRuntime() {
    if (hasNativeDialogSupport()) {
        return Promise.resolve('native-dialog');
    }
    if (typeof window.dialogPolyfill !== 'undefined') return Promise.resolve('ready');
    if (dialogPolyfillRuntimePromise) return dialogPolyfillRuntimePromise;

    dialogPolyfillRuntimePromise = loadExternalScriptOnce(
        DIALOG_POLYFILL_SCRIPT_SRC,
        'dialog-polyfill',
        () => typeof window.dialogPolyfill !== 'undefined'
    ).catch((error) => {
        dialogPolyfillRuntimePromise = null;
        throw error;
    });

    return dialogPolyfillRuntimePromise;
}

async function loadExternalStylesheetsAndScripts() {
    console.log('externalStylesheetsAndScriptsUILoader.js: Verifying prepared External Stylesheets and Scripts component...');

    try {
        const insertedCount = prepareExternalStylesheetsAndIcons();
        if (insertedCount > 0) {
            console.warn(`externalStylesheetsAndScriptsUILoader.js: Recovered ${insertedCount} missing external link(s) during late verification.`);
        }

        await prepareMaterialDesignLiteRuntime();
        await prepareDialogPolyfillRuntime();
        await waitForMaterialDesignLite();

        console.log('externalStylesheetsAndScriptsUILoader.js: External Stylesheets and Scripts verified successfully.');
        return Promise.resolve();
    } catch (error) {
        console.error('externalStylesheetsAndScriptsUILoader.js: Error loading External Stylesheets and Scripts:', error);
        return Promise.reject(error);
    }
}

function loadExternalScriptElement(originalScript) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');

        for (let attr of originalScript.attributes) {
            script.setAttribute(attr.name, attr.value);
        }

        if (originalScript.textContent) {
            script.textContent = originalScript.textContent;
        }

        script.onload = () => {
            console.log(`externalStylesheetsAndScriptsUILoader.js: Script loaded: ${script.src || 'inline script'}`);
            resolve();
        };

        script.onerror = (error) => {
            console.error(`externalStylesheetsAndScriptsUILoader.js: Script failed to load: ${script.src || 'inline script'}`, error);
            reject(error);
        };

        document.head.appendChild(script);
    });
}

function waitForMaterialDesignLite() {
    return new Promise((resolve) => {
        if (typeof window.componentHandler !== 'undefined' && window.componentHandler.upgradeAllRegistered) {
            console.log('externalStylesheetsAndScriptsUILoader.js: Material Design Lite componentHandler already available and ready.');
            resolve();
            return;
        }

        let attempts = 0;
        const maxAttempts = 100;
        const checkInterval = setInterval(() => {
            attempts++;
            if (typeof window.componentHandler !== 'undefined' && window.componentHandler.upgradeAllRegistered) {
                console.log(`externalStylesheetsAndScriptsUILoader.js: Material Design Lite componentHandler is now available and ready (attempt ${attempts}).`);
                clearInterval(checkInterval);
                resolve();
            } else if (attempts >= maxAttempts) {
                console.warn('externalStylesheetsAndScriptsUILoader.js: Material Design Lite componentHandler not available after waiting. Continuing anyway.');
                clearInterval(checkInterval);
                resolve();
            }
        }, 100);
    });
}

window.hasNativeDialogSupport = hasNativeDialogSupport;
window.prepareExternalStylesheetsAndIcons = prepareExternalStylesheetsAndIcons;
window.prepareMaterialDesignLiteRuntime = prepareMaterialDesignLiteRuntime;
window.prepareDialogPolyfillRuntime = prepareDialogPolyfillRuntime;
window.loadExternalStylesheetsAndScripts = loadExternalStylesheetsAndScripts;
