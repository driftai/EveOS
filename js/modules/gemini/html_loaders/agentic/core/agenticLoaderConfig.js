/**
 * agenticLoaderConfig.js
 * Configuration for agentic HTML loaders path and scripts list.
 */

// Define the base path for agentic HTML loaders
// Note: This needs to be relative to where the index.html is or absolute from web root
const AGENTIC_HTML_LOADERS_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/agentic';

// List of individual agentic UI loader scripts
const agenticUILoaderScripts = [
    `${AGENTIC_HTML_LOADERS_BASE_PATH}/time_perc/timePerceptionUILoader.js?v=098e92d2fb30`,
    `${AGENTIC_HTML_LOADERS_BASE_PATH}/conv_mem/conversationMemoryUILoader.js?v=4d4da6e85f17`,
    `${AGENTIC_HTML_LOADERS_BASE_PATH}/gemini_link/geminiLiveLinkScopeRuntime.js?v=73f1e22453eb`,
    `${AGENTIC_HTML_LOADERS_BASE_PATH}/gemini_link/geminiLiveLinkUIState.js?v=fc2b58d51f24`,
    `${AGENTIC_HTML_LOADERS_BASE_PATH}/gemini_link/geminiLiveLinkUICard.js?v=32441bda75e1`,
    `${AGENTIC_HTML_LOADERS_BASE_PATH}/gemini_link/geminiLiveLinkUILoader.js?v=b7ab24564da9`,
    `${AGENTIC_HTML_LOADERS_BASE_PATH}/gemini_link/geminiLiveLinkAssistRuntime.js?v=395de93167df`,
    `${AGENTIC_HTML_LOADERS_BASE_PATH}/audio_proc/audioProcessingControlsUILoader.js?v=f8d0e38da1f1`,
    `${AGENTIC_HTML_LOADERS_BASE_PATH}/audio_proc/audioSettingsDialogUILoader.js?v=c2faf304f639`,
    `${AGENTIC_HTML_LOADERS_BASE_PATH}/sonic_forge/sonicForgeManagerUILoader.js?v=3d44b5033621`,
    `${AGENTIC_HTML_LOADERS_BASE_PATH}/narration/worldBookNarrationManagerUILoader.js?v=8c886e40f65c`,
    `${AGENTIC_HTML_LOADERS_BASE_PATH}/sess_ctrl/sessionControlsUILoader.js?v=cf55a0820c6c`,
    `${AGENTIC_HTML_LOADERS_BASE_PATH}/sess_ctrl/sessionControlsSettingsDialogUILoader.js?v=e4ab78d5a8ab`,
    `${AGENTIC_HTML_LOADERS_BASE_PATH}/scr_cap/screenCaptureSettingsUILoader.js?v=b15033edd2c1`,
    `${AGENTIC_HTML_LOADERS_BASE_PATH}/self_talk/aiSelfTalkUILoader.js?v=abd2a89d80ac`,
    `${AGENTIC_HTML_LOADERS_BASE_PATH}/self_talk/aiSelfTalkSettingsDialogUILoader.js?v=9b0bc4da5a51`
];

// Export to global scope if needed for other modules, though primarily used by scriptLoader
window.AgenticLoaderConfig = {
    BASE_PATH: AGENTIC_HTML_LOADERS_BASE_PATH,
    SCRIPTS: agenticUILoaderScripts
};

console.log("agenticLoaderConfig.js loaded.");