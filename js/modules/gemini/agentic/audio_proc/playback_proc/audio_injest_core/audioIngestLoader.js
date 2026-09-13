/**
 * audioIngestLoader.js
 * Dynamically loads the modularized audio ingestion scripts.
 */

console.log("audioIngestLoader.js loading...");

const AUDIO_INGEST_CORE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/agentic/audio_proc/playback_proc/audio_injest_core';

const audioIngestScripts = [
    `${AUDIO_INGEST_CORE_PATH}/sequentialIngestHandler.js?v=1a10dea642b1`,
    `${AUDIO_INGEST_CORE_PATH}/interimIngestHandler.js?v=3d2a8c661289`,
    `${AUDIO_INGEST_CORE_PATH}/workletIngestHandler.js?v=39d726eb9b58`,
    `${AUDIO_INGEST_CORE_PATH}/errorRecoveryHandler.js?v=a8c264daa638`,
    `${AUDIO_INGEST_CORE_PATH}/ingestCoordinator.js?v=596655da2d1e`
];

function loadAudioIngestScripts() {
    const fragment = document.createDocumentFragment();
    audioIngestScripts.forEach(scriptPath => {
        const script = document.createElement('script');
        script.src = scriptPath;
        script.defer = true;
        fragment.appendChild(script);
    });
    document.head.appendChild(fragment);
}

loadAudioIngestScripts();

console.log("audioIngestLoader.js finished.");
