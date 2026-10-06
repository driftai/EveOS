/**
 * displayLoader.js
 * Handles dynamic loading of HTML components via html_initialization_loaders.js.
 */

window.PageInitializationCore = window.PageInitializationCore || {};

window.PageInitializationCore.DisplayLoader = {
    loadHtmlComponents: function () {
        return new Promise((resolve, reject) => {
            const loadScript = () => {
                const htmlLoadersScript = document.createElement('script');
                htmlLoadersScript.src = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/html_initialization_loaders.js?v=20261006.2';

                // Set a safety timeout
                const timeoutId = setTimeout(() => {
                    console.error('displayLoader.js: TIMEOUT loading html_initialization_loaders.js');
                    reject('Timeout loading HTML loaders');
                }, 10000);

                htmlLoadersScript.onload = async () => {
                    clearTimeout(timeoutId);
                    console.log('html_initialization_loaders.js loaded dynamically.');
                    if (typeof window.initializeAllHtmlComponents === 'function') {
                        try {
                            await window.initializeAllHtmlComponents();
                            resolve();
                        } catch (e) {
                            console.error('Error in initializeAllHtmlComponents:', e);
                            reject(e);
                        }
                    } else {
                        const error = 'initializeAllHtmlComponents function not found after loading script.';
                        console.error(error);
                        reject(error);
                    }
                };

                htmlLoadersScript.onerror = (error) => {
                    clearTimeout(timeoutId);
                    const msg = 'Failed to load html_initialization_loaders.js';
                    console.error(msg, error);
                    reject(msg);
                };

                document.body.appendChild(htmlLoadersScript);
            };

            if (document.body) {
                loadScript();
            } else {
                console.log('displayLoader.js: Waiting for document.body...');
                window.addEventListener('DOMContentLoaded', loadScript);
            }
        });
    }
};

console.log("displayLoader.js loaded.");
