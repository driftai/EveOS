(function () {
    'use strict';

    // A fresh EveOS page is observational only. Persisted lifecycle preferences
    // belong to the surface that explicitly chose them; merely opening another
    // EveOS page must not spawn Gemini or rewrite another page's shared state.
    // Explicit Start/Connect in this page flips the session authorization flag.
    window.__EVE_GEMINI_PASSIVE_BOOT = true;
    window.__EVE_GEMINI_SESSION_AUTHORIZED = false;
})();
