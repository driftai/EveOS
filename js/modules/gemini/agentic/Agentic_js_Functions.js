// js/modules/gemini/agentic/Agentic_js_Functions.js
// Aggregates all agentic function modules
// Script loading is handled by js/modules/gemini/Script_Loader/Script_Loader.js.

console.log("js/modules/gemini/agentic/Agentic_js_Functions.js started loading");

// Keep one stable aggregator object so callers that captured the reference before the child
// modules finished loading still see the populated functions after initialization.
window.AgenticFunctions = window.AgenticFunctions || {
    TimePerception: {},
    ConversationMemory: {},
    AISelfTalk: {},
    AudioProcessingControls: {},
    SessionControls: {},
    ScreenCaptureInterval: {}
};

// Child loaders can settle after any fixed timeout and some replace their namespace.
// Resolve on access: keep the aggregator stable without polling or freezing a stale {}.
for (const name of ['TimePerception', 'ConversationMemory', 'AISelfTalk',
    'AudioProcessingControls', 'SessionControls', 'ScreenCaptureInterval']) {
    const pending = {};
    Object.defineProperty(window.AgenticFunctions, name, {
        configurable: true,
        enumerable: true,
        // The self-talk implementation uses Ai (not AI); AISelfTalkAgentic is
        // a legacy placeholder populated by the outer loader, not the runtime.
        get() { return window[name === 'AISelfTalk' ? 'AiSelfTalkAgentic' : name + 'Agentic'] || pending; }
    });
}
