// main.js - Initial entry point for the Gemini Chat Interface front-end.
// This file loads the canonical Gemini Script_Loader entry point.

function loadMainScriptAggregator() {
    const script = document.createElement('script');
    // The server now serves from the project root (Workshop/)
    // So we point to the migrated script loader in js/modules/gemini/
    script.src = (window.GEMINI_APP_ROOT || '') + "js/modules/gemini/Script_Loader/Script_Loader.js?v=1a3317bc2464";
    script.defer = true;
    document.head.appendChild(script);
}

// Since main.js itself is deferred, it will execute after the initial DOM parsing.
// So, we can call loadMainScriptAggregator directly.
loadMainScriptAggregator();
