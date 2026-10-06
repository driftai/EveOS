/**
 * svgFixerLoader.js
 * Dynamically loads the modularized SVG fixing scripts.
 */

(function loadSvgFixingScripts() {
    console.log("svgFixerLoader.js loading...");

    const COMPONENT_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/client/page_initialization/svg_fixing/svg_fixing_core';

    const scripts = [
        `${COMPONENT_BASE_PATH}/svgFixLogic.js?v=20261006.1`,
        `${COMPONENT_BASE_PATH}/svgDomMonitor.js?v=20261006.1`,
        `${COMPONENT_BASE_PATH}/svgFixerCoordinator.js?v=20261006.1`
    ];

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.type = 'text/javascript';
            script.defer = true;
            script.onload = () => {
                console.log(`${src} loaded.`);
                resolve();
            };
            script.onerror = (err) => {
                console.error(`Failed to load script: ${src}`, err);
                reject(err);
            };
            document.head.appendChild(script);
        });
    }

    // Load scripts sequentially to ensure dependencies are met
    async function loadAllScripts() {
        console.log("Loading SVG Fixing Core scripts...");
        try {
            for (const script of scripts) {
                await loadScript(script);
            }
            console.log("svgFixerLoader.js finished. All SVG fixing modules loaded.");
        } catch (error) {
            console.error("Critical Error loading SVG fixing modules:", error);
        }
    }

    loadAllScripts();

})();
