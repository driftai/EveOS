(function () {
    'use strict';
    if (window.__eveWatchFusionBootstrapReady) return;
    window.__eveWatchFusionBootstrapReady = true;

    function ensureStyle() {
        if (document.querySelector('link[data-eve-watchfusion-style]')) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'css/modules/watchfusion.css';
        link.dataset.eveWatchfusionStyle = '1';
        document.head.appendChild(link);
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
            if (window.EveWatchFusion?.open) window.EveWatchFusion.open();
            else window.__eveWatchFusionOpenPending = true;
        });
        audioflix.insertAdjacentElement('afterend', button);
    }

    function initialize() {
        ensureStyle();
        ensureButton();
        if (!document.querySelector('.topbar-watchfusion-btn')) {
            const observer = new MutationObserver(() => {
                ensureButton();
                if (document.querySelector('.topbar-watchfusion-btn')) observer.disconnect();
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
