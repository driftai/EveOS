(function () {
    'use strict';

    if (window.__eveWatchFusionFrameCapabilitiesReady) return;
    window.__eveWatchFusionFrameCapabilitiesReady = true;

    const REQUIRED = ['autoplay', 'encrypted-media', 'fullscreen', 'picture-in-picture', 'web-share', 'webgpu'];

    function patchFrame() {
        const frame = document.querySelector('#watchfusion-overlay .watchfusion-frame');
        if (!frame) return false;
        const values = (frame.getAttribute('allow') || '')
            .split(';')
            .map(value => value.trim())
            .filter(Boolean);
        const seen = new Set(values.map(value => value.toLowerCase()));
        for (const feature of REQUIRED) {
            if (!seen.has(feature)) values.push(feature);
        }
        frame.setAttribute('allow', values.join('; '));
        return true;
    }

    const observer = new MutationObserver(() => patchFrame());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    patchFrame();
})();
