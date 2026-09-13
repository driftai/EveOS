/**
 * socketCoreLoader.js
 * 
 * Dynamically loads the modularized socket connection scripts in the correct order.
 */

console.log("socketCoreLoader.js loading...");

const SOCKET_CORE_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/client/connection_management/socket_core';

const socketCoreScripts = [
    `${SOCKET_CORE_BASE_PATH}/geminiApiFailure.js?v=3a84186b5ef6`,
    `${SOCKET_CORE_BASE_PATH}/socketGlobalState.js?v=7e59a7999ff8`, // Load Global State before handlers
    `${SOCKET_CORE_BASE_PATH}/scc/eh/errorEventHandler.js?v=f4ce7d6151a4`,
    `${SOCKET_CORE_BASE_PATH}/scc/eh/openEventHandler.js?v=2745fa72a01d`,
    `${SOCKET_CORE_BASE_PATH}/scc/eh/closeEventHandler.js?v=536ed02bd541`,
    `${SOCKET_CORE_BASE_PATH}/scc/socketConnectionState.js?v=65a49f14464e`,
    `${SOCKET_CORE_BASE_PATH}/scc/socketLifecycle.js?v=cf38c3d45c63`,
    `${SOCKET_CORE_BASE_PATH}/scc/socketConnectionCoordinator.js?v=65c8658b0ced`,
    `${SOCKET_CORE_BASE_PATH}/socketMessageRouter.js?v=e4ddcf12826e`,
    `${SOCKET_CORE_BASE_PATH}/audioPlayerUI.js?v=4ac0a32c2f58`,
    `${SOCKET_CORE_BASE_PATH}/socketAudioLogic.js?v=11444be6d5c3`,
    `${SOCKET_CORE_BASE_PATH}/serverStatusChecker.js?v=cba3a4ad0191`
];

// Load scripts sequentially to ensure dependencies are met
function loadSocketCoreScripts() {
    console.log("Loading Socket Core scripts...");

    // Load sequentially: this module chain has hard ordering dependencies.
    const loadSequentially = (index = 0) => {
        if (index >= socketCoreScripts.length) {
            console.log("socketCoreLoader.js finished. All socket core scripts loaded.");
            window.__GEMINI_SOCKET_READY = true;
            window.dispatchEvent(new CustomEvent('eve:gemini-socket-ready'));
            return;
        }

        const scriptPath = socketCoreScripts[index];
        const script = document.createElement('script');
        script.src = scriptPath;
        script.async = false;

        script.onload = () => loadSequentially(index + 1);
        script.onerror = (err) => {
            console.error(`Failed to load socket core script: ${scriptPath}`, err);
            loadSequentially(index + 1);
        };

        document.head.appendChild(script);
    };

    loadSequentially();
}

loadSocketCoreScripts();
