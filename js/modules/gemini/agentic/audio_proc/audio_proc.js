// js/modules/gemini/Agentic_js_Functions/Audio_Processing_Controls_Agentic/Audio_Processing_Controls_Agentic.js
// Manages and loads all audio processing control related functionality

console.log("js/modules/gemini/Agentic_js_Functions/Audio_Processing_Controls_Agentic/Audio_Processing_Controls_Agentic.js started loading");

// Base path for audio processing scripts
const AUDIO_PROCESSING_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/agentic/audio_proc';

// List of audio processing scripts to load
const audioProcessingScripts = [
    // Core Audio Playback
    `${AUDIO_PROCESSING_BASE_PATH}/audio_playback_core/audioContainerHelper.js?v=c80814f4045c`,
    `${AUDIO_PROCESSING_BASE_PATH}/audio_playback_core/audioContextInitializer.js?v=5189000ac093`,
    `${AUDIO_PROCESSING_BASE_PATH}/audio_playback_core/audioSourceConfigurator.js?v=bc982a726c32`,
    `${AUDIO_PROCESSING_BASE_PATH}/audio_playback_core/base64_player_core/base64PlayerLoader.js?v=2d939014a8e8`,
    `${AUDIO_PROCESSING_BASE_PATH}/audio_playback_fallback/fallback_core/wavEncoder.js?v=7ff29831ee2e`,
    `${AUDIO_PROCESSING_BASE_PATH}/audio_playback_fallback/fallback_core/html5AudioFallback.js?v=3b18cabfb125`,
    `${AUDIO_PROCESSING_BASE_PATH}/audio_playback_fallback/fallback_core/webAudioFallback.js?v=33296fc94855`,
    `${AUDIO_PROCESSING_BASE_PATH}/audio_playback_fallback/fallback_core/fallbackAudioCoordinator.js?v=d04d740221e9`,
    `${AUDIO_PROCESSING_BASE_PATH}/playback_ctrl/audioPlaybackStopper.js?v=658584108df6`,

    // Audio Context and Buffer Management
    `${AUDIO_PROCESSING_BASE_PATH}/context_mgmt/audioContextState.js?v=0ffdbc09300e`,
    `${AUDIO_PROCESSING_BASE_PATH}/context_mgmt/audioWorkletProcessor.js?v=6851047f8d9b`,
    `${AUDIO_PROCESSING_BASE_PATH}/context_mgmt/iOSAudioUnlock.js?v=1799c936d8bd`,
    `${AUDIO_PROCESSING_BASE_PATH}/context_mgmt/user_gesture_core/userGestureLoader.js?v=be0eb5883daf`,
    `${AUDIO_PROCESSING_BASE_PATH}/context_mgmt/audioContextHelpers.js?v=e7a3fb66657e`,
    `${AUDIO_PROCESSING_BASE_PATH}/context_mgmt/initialization_modules/audioWorkletInitializer.js?v=ed8cc732f65d`,
    `${AUDIO_PROCESSING_BASE_PATH}/context_mgmt/initialization_modules/legacyAudioInitializer.js?v=25e1cfa57359`,
    `${AUDIO_PROCESSING_BASE_PATH}/context_mgmt/audioContextCoreInit.js?v=89a667ac831a`,
    `${AUDIO_PROCESSING_BASE_PATH}/context_mgmt/audioContextReadiness.js?v=b6c8ec7530b0`,
    `${AUDIO_PROCESSING_BASE_PATH}/context_mgmt/containerContextFactory.js?v=f3944854b788`,
    `${AUDIO_PROCESSING_BASE_PATH}/buffer_mgmt/audioBufferCreator.js?v=f16840baa135`,
    `${AUDIO_PROCESSING_BASE_PATH}/playback_settings/sequentialAudioPlayState.js?v=a3e389e81237`,

    // Audio Processing and Queue Management
    `${AUDIO_PROCESSING_BASE_PATH}/playback_proc/audio_injest_core/audioIngestLoader.js?v=0ece3f5a0bf4`,
    `${AUDIO_PROCESSING_BASE_PATH}/queue_mgmt/audioQueueStore.js?v=b79f06a3d496`,
    `${AUDIO_PROCESSING_BASE_PATH}/queue_mgmt/queue_core/queueItemSelector.js?v=984dc744106d`,
    `${AUDIO_PROCESSING_BASE_PATH}/queue_mgmt/queue_core/queueUIManager.js?v=df45f5b4416e`,
    `${AUDIO_PROCESSING_BASE_PATH}/queue_mgmt/queue_core/queuePlaybackExecutor.js?v=2dd3a2da37c3`,
    `${AUDIO_PROCESSING_BASE_PATH}/queue_mgmt/queue_core/queueCompletionHandler.js?v=88caa14331c7`,
    `${AUDIO_PROCESSING_BASE_PATH}/queue_mgmt/queue_core/queueProcessor.js?v=5a709469e11c`,

    // Audio Progress UI
    `${AUDIO_PROCESSING_BASE_PATH}/audio_progress_ui/audioProgressTracker.js?v=164bba86f412`,
    `${AUDIO_PROCESSING_BASE_PATH}/audio_progress_ui/audioProgressUpdater.js?v=e7183e9190c2`,
    `${AUDIO_PROCESSING_BASE_PATH}/progress_updater/directProgressBarUpdater.js?v=7ba78542ceeb`,

    // Audio Seeking and Settings
    `${AUDIO_PROCESSING_BASE_PATH}/seek_ops/audioSeeker.js?v=037657dd4b5f`,
    `${AUDIO_PROCESSING_BASE_PATH}/settings_dialog/audioSettingsDialogHandler.js?v=d71f9a9b6cff`,

    // Audio Processing Preferences and Toggles
    `${AUDIO_PROCESSING_BASE_PATH}/audio_preferences/audioProcessingPreferencesHandler.js?v=bfec08202e3b`,
    `${AUDIO_PROCESSING_BASE_PATH}/auto_play_toggle/autoAudioPlayToggleHandler.js?v=7bda035dcec3`,
    `${AUDIO_PROCESSING_BASE_PATH}/seq_play_toggle/sequentialAudioPlayToggleHandler.js?v=7b132068ca89`,
    `${AUDIO_PROCESSING_BASE_PATH}/interim_audio_toggle/interimAudioToggleHandler.js?v=6930235f78be`,

    // Speech Recognition (Client-Side)
    `${AUDIO_PROCESSING_BASE_PATH}/speech_recognition/speechRecognitionHandler.js?v=e6c37fa4ff3f`,

    // Voice Settings and Controls
    `${AUDIO_PROCESSING_BASE_PATH}/voice_announcements_handler/voiceAnnouncementsHandler.js?v=c269cd06342a`,
    `${AUDIO_PROCESSING_BASE_PATH}/voice_selection_handler/voiceSelectionHandler.js?v=22f5d2658801`,
    `${AUDIO_PROCESSING_BASE_PATH}/voice_operations/voiceAnnouncementTester.js?v=89bb1983d1a7`,

    // Transcription Mode Settings
    `${AUDIO_PROCESSING_BASE_PATH}/transcription_mode_settings/transcriptionModeState.js?v=b9b1bebe8941`,
    `${AUDIO_PROCESSING_BASE_PATH}/transcription_mode_settings/transcriptionModeToggleHandler.js?v=5539c8e908f2`,
    `${AUDIO_PROCESSING_BASE_PATH}/inline_transcription/transcriptionSystemInstructions.js?v=43d0cc1a451a`,
    `${AUDIO_PROCESSING_BASE_PATH}/inline_transcription/transcriptionBoxParser.js?v=33693282a854`,
    `${AUDIO_PROCESSING_BASE_PATH}/inline_transcription/transcriptionTagHandler.js?v=ef925586ed88`
];

// Function to load all audio processing scripts
function loadAudioProcessingScripts() {
    const fragment = document.createDocumentFragment();
    audioProcessingScripts.forEach(scriptPath => {
        const script = document.createElement('script');
        script.src = scriptPath;
        script.defer = true;
        fragment.appendChild(script);
    });
    document.head.appendChild(fragment);
}

// Function to initialize the audio processing module
function initializeAudioProcessingModule() {
    // Add any initialization code here if needed
    console.log('Audio Processing Controls module initialized');
}

// Load all audio processing scripts
loadAudioProcessingScripts();

// Initialize the module
initializeAudioProcessingModule();

// Export audio processing related functions for global use
window.AudioProcessingControlsAgentic = {
    // Core Audio Functions
    playAudio: null,                // Will be defined by base64AudioPlayer.js
    stopAudio: null,                // Will be defined by audioPlaybackStopper.js
    seekAudio: null,                // Will be defined by audioSeeker.js
    updateAudioProgress: null,      // Will be defined by audioProgressUpdater.js
    processAudioChunk: null,        // Will be defined by audioChunkInjestor.js
    queueAudio: null,               // Will be defined by audioQueueManager.js

    // Audio State Management
    isSequentialPlaybackEnabled: null, // Will be defined by sequentialAudioPlayState.js
    isAutoPlayEnabled: null,        // Will be defined by autoAudioPlayToggleHandler.js
    audioContext: null,             // Will be defined by audioContextManager.js
    createAudioBuffer: null,        // Will be defined by audioBufferCreator.js

    // Voice Control Functions
    isVoiceAnnouncementsEnabled: null, // Will be defined by voiceAnnouncementsHandler.js
    restoreVoiceSelection: null,    // Will be defined by voiceSelectionHandler.js
    saveVoiceAndReinitialize: null  // Will be defined by voiceSelectionHandler.js
};
