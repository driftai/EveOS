(function () {
    'use strict';
    if (window.__eveWatchFusionBootstrapReady) return;
    window.__eveWatchFusionBootstrapReady = true;

    let styleReadyPromise = null;

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

    function ensureStyleReady() {
        if (!styleReadyPromise) {
            styleReadyPromise = Promise.all([
                stylesheetReady(
                    'link[data-eve-watchfusion-style]',
                    'css/modules/watchfusion.css?v=f5aa920d43cf',
                    'eveWatchfusionStyle'
                ),
                stylesheetReady(
                    'link[data-eve-watchfusion-resilience-style]',
                    'css/modules/watchfusion-resilience.css?v=7c7e33b8a8bd',
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
        // The button is intentionally withheld until both WatchFusion stylesheets are ready.
        // This keeps the first visible overlay frame at its final geometry instead of briefly
        // rendering the raw, document-flow markup and snapping down after CSS arrives.
        ensureStyleReady().then(bindButtonWhenHostExists);
    }

    window.EveWatchFusionStyleReady = ensureStyleReady;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
