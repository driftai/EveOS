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

function initializeAgenticModule() {
    Object.assign(window.AgenticFunctions, {
        TimePerception: window.TimePerceptionAgentic || {},
        ConversationMemory: window.ConversationMemoryAgentic || {},
        AISelfTalk: window.AISelfTalkAgentic || {},
        AudioProcessingControls: window.AudioProcessingControlsAgentic || {},
        SessionControls: window.SessionControlsAgentic || {},
        ScreenCaptureInterval: window.ScreenCaptureIntervalAgentic || {}
    });
}

// Child agentic loaders run before this aggregator in the master loader, but some of them load
// their own scripts asynchronously. Refresh once after that work has had a chance to settle.
setTimeout(initializeAgenticModule, 500);
