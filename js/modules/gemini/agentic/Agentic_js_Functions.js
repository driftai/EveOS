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

// Gemini Live tool execution stays deliberately smaller than AgenticFunctions. Never expose the
// whole namespace (or arbitrary property traversal/eval) to model-controlled input.
(function installGeminiLiveToolBridge() {
    function requiredFunction(namespace, name) {
        const fn = window.AgenticFunctions?.[namespace]?.[name];
        if (typeof fn !== 'function') {
            throw new Error(`${namespace}.${name} is not ready`);
        }
        return fn;
    }

    function safeStorageGet(key) {
        try { return window.localStorage?.getItem?.(key) || ''; }
        catch (error) { return ''; }
    }

    const handlers = Object.freeze({
        eve_get_client_time: async () => ({
            ok: true,
            iso: new Date().toISOString(),
            local: new Date().toString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'
        }),

        eve_get_context_memory_state: async () => ({
            ok: true,
            enabled: !!requiredFunction('ConversationMemory', 'isContextMemoryEnabled')()
        }),

        eve_set_context_memory_state: async (args) => {
            if (typeof args?.enabled !== 'boolean') {
                throw new TypeError('enabled must be boolean');
            }
            requiredFunction('ConversationMemory', 'setContextMemoryEnabled')(args.enabled);
            return { ok: true, enabled: !!requiredFunction('ConversationMemory', 'isContextMemoryEnabled')() };
        },

        eve_get_screen_share_state: async () => ({
            ok: true,
            // Intentionally never return currentFrameB64: a state query is not capture permission.
            sharing: !!requiredFunction('ScreenCaptureInterval', 'getScreenSharingState')()
        }),

        eve_get_audio_playback_diagnostics: async () => {
            const getDiagnostics = window.AudioIngestCore?.InterimIngestHandler?.getDiagnostics;
            return {
                ok: true,
                diagnostics: typeof getDiagnostics === 'function'
                    ? getDiagnostics.call(window.AudioIngestCore.InterimIngestHandler)
                    : { available: false }
            };
        },

        eve_get_session_state: async () => ({
            ok: true,
            model: safeStorageGet('selectedModel') || window.EveGeminiModelRegistry?.defaults?.live || '',
            socketReadyState: Number.isInteger(window.webSocket?.readyState) ? window.webSocket.readyState : null,
            geminiApiReady: window.SocketGlobalState?.geminiApiReady === true,
            pageVisibility: document.visibilityState || 'unknown'
        })
    });

    window.GeminiLiveToolBridge = Object.freeze({
        names: Object.freeze(Object.keys(handlers)),
        async execute(call) {
            const name = String(call?.name || '');
            const handler = Object.prototype.hasOwnProperty.call(handlers, name)
                ? handlers[name]
                : null;
            if (!handler) throw new Error(`Gemini Live tool is not allowed: ${name || '(missing)'}`);
            const args = call?.args && typeof call.args === 'object' && !Array.isArray(call.args)
                ? call.args
                : {};
            return handler(args);
        }
    });
})();
