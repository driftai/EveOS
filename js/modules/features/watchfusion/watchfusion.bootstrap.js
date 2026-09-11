(function () {
    'use strict';
    if (window.__eveWatchFusionBootstrapReady) return;
    window.__eveWatchFusionBootstrapReady = true;

    let styleReadyPromise = null;
    let companionsReadyPromise = null;

    function stylesheetReady(selector, href, datasetKey) {
        return new Promise((resolve) => {
            let link = document.querySelector(selector);
            if (!link) {
                link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = href;
                link.dataset[datasetKey] = '1';
                document.head.appendChild(link);
            }

            if (link.sheet) {
                resolve();
                return;
            }

            const settle = () => resolve();
            link.addEventListener('load', settle, { once: true });
            // A missing optional stylesheet must never strand the top-bar button forever.
            link.addEventListener('error', settle, { once: true });
        });
    }

    function companionReady(src, dataKey, readyFlag) {
        return new Promise((resolve) => {
            if (window[readyFlag]) return resolve();
            let script = document.querySelector(`script[${dataKey}]`);
            if (!script) {
                script = document.createElement('script');
                script.src = src;
                script.async = false;
                script.setAttribute(dataKey, '1');
                document.head.appendChild(script);
            }
            if (window[readyFlag]) return resolve();
            const settle = () => resolve();
            script.addEventListener('load', settle, { once: true });
            script.addEventListener('error', settle, { once: true });
        });
    }

    function ensureRuntimeCompanions() {
        if (!companionsReadyPromise) {
            companionsReadyPromise = Promise.all([
                companionReady(
                    'js/modules/features/watchfusion/watchfusion.frame-capabilities.js?v=5354e7b02ed3',
                    'data-eve-watchfusion-frame-capabilities',
                    '__eveWatchFusionFrameCapabilitiesReady'
                ),
                companionReady(
                    'js/modules/features/watchfusion/watchfusion.selective-start.js?v=9566b0c6e27a',
                    'data-eve-watchfusion-selective-start',
                    '__eveWatchFusionSelectiveStartReady'
                )
            ]);
        }
        return companionsReadyPromise;
    }

    function ensureStyleReady() {
        if (!styleReadyPromise) {
            styleReadyPromise = Promise.all([
                stylesheetReady(
                    'link[data-eve-watchfusion-style]',
                    'css/modules/watchfusion.css?v=5468012d9c0a',
                    'eveWatchfusionStyle'
                ),
                stylesheetReady(
                    'link[data-eve-watchfusion-resilience-style]',
                    'css/modules/watchfusion-resilience.css?v=0d471f11203d',
                    'eveWatchfusionResilienceStyle'
                )
            ]);
        }
        return styleReadyPromise;
    }

    function ensureButton() {
        if (document.querySelector('.topbar-watchfusion-btn')) return;
        const audioflix = document.querySelector('.topbar-audioflix-btn');
        if (!audioflix) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'topbar-map-btn topbar-watchfusion-btn';
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-controls', 'watchfusion-overlay');
        button.setAttribute('aria-expanded', 'false');
        button.title = 'WatchFusion';
        button.innerHTML = '&#9654; WatchFusion';
        button.addEventListener('click', () => {
            if (window.EveWatchFusion?.prepareOpen) window.EveWatchFusion.prepareOpen();
            if (window.EveWatchFusion?.open) window.EveWatchFusion.open();
            else window.__eveWatchFusionOpenPending = true;
        });
        audioflix.insertAdjacentElement('afterend', button);
    }

    function bindButtonWhenHostExists() {
        ensureButton();
        if (document.querySelector('.topbar-watchfusion-btn')) return;
        const observer = new MutationObserver(() => {
            ensureButton();
            if (document.querySelector('.topbar-watchfusion-btn')) observer.disconnect();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    function initialize() {
        // The WatchFusion button becomes interactive only after both its visual
        // shell and the human selective-start interceptor are ready. That avoids
        // a first-click race that could bypass the terminal mode prompt.
        Promise.all([ensureRuntimeCompanions(), ensureStyleReady()]).then(bindButtonWhenHostExists);
    }

    window.EveWatchFusionStyleReady = ensureStyleReady;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();