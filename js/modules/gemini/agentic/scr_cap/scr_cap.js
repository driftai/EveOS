// js/modules/gemini/agentic/Screen_Capture_Interval_Agentic/Screen_Capture_Interval_Agentic.js
// Loads and connects all screen capture interval related functionality

console.log("js/modules/gemini/agentic/Screen_Capture_Interval_Agentic/Screen_Capture_Interval_Agentic.js started loading");

// Define the base path for screen capture related modules
const SCREEN_CAPTURE_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/agentic/scr_cap';

// List of screen capture related scripts to load
const screenCaptureScripts = [
    `${SCREEN_CAPTURE_BASE_PATH}/screen_sharing_state/screenSharingState.js?v=321ef7edf6db`,      // Technical state management
    `${SCREEN_CAPTURE_BASE_PATH}/media_stream_state/mediaStreamState.js?v=c2e88d9a2158`, // Manages the global state for the active media stream (camera/screen).
    `${SCREEN_CAPTURE_BASE_PATH}/screen_capture_frame_state/screenCaptureFrameState.js?v=59790a850a04`  // Frame buffer management
];

// Load all screen capture related scripts
function loadScreenCaptureScripts() {
    const fragment = document.createDocumentFragment();
    screenCaptureScripts.forEach(scriptPath => {
        const script = document.createElement('script');
        script.src = scriptPath;
        script.defer = true;
        script.onload = initializeScreenCaptureModule;
        fragment.appendChild(script);
    });
    document.head.appendChild(fragment);
}

// Initialize screen capture functionality after scripts load
function initializeScreenCaptureModule() {
    if (!window.ScreenCaptureIntervalAgentic) {
        window.ScreenCaptureIntervalAgentic = {
            isScreenShared: false,      // Will be managed by screenSharingState.js
            currentFrameB64: null,      // Will be managed by screenCaptureFrameState.js
            // Technical state getters/setters will be added by respective modules
            getScreenSharingState: null,
            setScreenSharingState: null,
            getCurrentFrame: null,
            setCurrentFrame: null
        };
    }

    // Expose the same state used by the capture pipeline, not a second stale copy.
    const api = window.ScreenCaptureIntervalAgentic;
    Object.assign(api, {
        getScreenSharingState: () => window.isScreenShared === true,
        setScreenSharingState: value => {
            if (typeof value !== 'boolean') throw new TypeError('Screen sharing state must be boolean');
            window.isScreenShared = value;
        },
        getCurrentFrame: () => window.currentFrameB64 || null,
        setCurrentFrame: value => {
            if (value !== null && typeof value !== 'string') throw new TypeError('Frame must be a string or null');
            window.currentFrameB64 = value;
        }
    });
    Object.defineProperties(api, {
        isScreenShared: { configurable: true, enumerable: true,
            get: api.getScreenSharingState, set: api.setScreenSharingState },
        currentFrameB64: { configurable: true, enumerable: true,
            get: api.getCurrentFrame, set: api.setCurrentFrame }
    });
    // These are state accessors, not permission to start screen capture.
    // Note: UI functions are now handled by Screen_Share_MM_Commuication_Panel
    // This module only manages technical state
}

// Initialize screen capture functionality
loadScreenCaptureScripts();

// Export screen capture related functions for global use
window.ScreenCaptureIntervalAgentic = window.ScreenCaptureIntervalAgentic || {
    isScreenShared: false,      // Will be managed by screenSharingState.js
    currentFrameB64: null,      // Will be managed by screenCaptureFrameState.js
    // Technical state getters/setters will be added by respective modules
    getScreenSharingState: null,
    setScreenSharingState: null,
    getCurrentFrame: null,
    setCurrentFrame: null
};

console.log("js/modules/gemini/agentic/Screen_Capture_Interval_Agentic/Screen_Capture_Interval_Agentic.js finished loading and initial execution");
