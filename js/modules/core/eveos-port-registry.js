(function () {
    'use strict';

    if (window.EveOSPortRegistry) return;

    // Browser mirror of config/eveos-ports.json. The repository audit requires
    // this map to stay byte-for-byte value-aligned with the canonical registry,
    // so file:// mode can resolve ports without fetching JSON over HTTP.
    const ports = Object.freeze({
        LIGHTPANDA_BRIDGE_PORT: 3037,
        CAMOFOX_BRIDGE_PORT: 3038,
        WIKIMEDIA_BRIDGE_PORT: 3039,
        POPUP_BRIDGE_PORT: 3040,
        EVEOS_WEB_PORT: 8765,
        WORLD_BOOK_PORT: 8766,
        PIANO_PLAYER_PORT: 8771,
        GEMINI_CONTROL_PORT: 9082,
        GEMINI_WS_PORT: 9085,
        GEMINI_STATUS_PORT: 9086,
        WATCHFUSION_PORT: 9087
    });

    function get(name, fallback = 0) {
        const value = Number(ports[name]);
        return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : Number(fallback) || 0;
    }

    function entries() {
        return Object.entries(ports).map(([name, port]) => ({ name, port }));
    }

    function url(name, options = {}) {
        const port = get(name);
        if (!port) return null;
        const protocol = options.protocol || 'http:';
        const host = options.host || '127.0.0.1';
        return `${protocol}//${host}:${port}`;
    }

    window.EveOSPortRegistry = Object.freeze({ ports, get, entries, url });
})();
