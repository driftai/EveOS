// js/modules/gemini/Script_Loader/Script_Loader.js
// Centralized Script Loader for Gemini Chat Interface.
// Loads Gemini child modules lazily to avoid blocking initial app startup.

function shouldDebugBootLogs() {
    try {
        const qs = new URLSearchParams(window.location.search || '');
        if (qs.get('debugGeminiBoot') === '1') return true;
        return window.localStorage && window.localStorage.getItem('eve.debugGeminiBoot') === '1';
    } catch (e) {
        return false;
    }
}

function debugBootLog() {
    if (!shouldDebugBootLogs()) return;
    console.log.apply(console, arguments);
}

debugBootLog('js/modules/gemini/Script_Loader/Script_Loader.js started loading');
window.__GEMINI_MASTER_LOADER_ACTIVE = true;

const APP_ROOT = window.GEMINI_APP_ROOT || '';
const BASE_PATHS = {
    AGENTIC: APP_ROOT + 'js/modules/gemini/agentic',
    CLIENT_CORE: APP_ROOT + 'js/modules/gemini/client',
    LOG_INTERFACE: APP_ROOT + 'js/modules/gemini/logs',
    COMM_PANEL: APP_ROOT + 'js/modules/gemini/comm'
};

// Order matters: Core -> Components -> Features -> UI
const masterScriptList = [
    // Debugging
    APP_ROOT + 'js/modules/gemini/debugTranscription.js?v=2b1a19e8a354',

    // 1. Client Core Control
    APP_ROOT + 'js/modules/gemini/comm/send_hist/chat_history_local_storage/localStorageHelper.js?v=17195069c03b',
    `${BASE_PATHS.CLIENT_CORE}/modelRegistry.js?v=c56151cab212`,
    `${BASE_PATHS.CLIENT_CORE}/usageTelemetry.js?v=dab13d07b950`,
    `${BASE_PATHS.CLIENT_CORE}/application_state_management/applicationStateManager.js?v=f51b582130e7`,
    `${BASE_PATHS.CLIENT_CORE}/page_initialization/error_filtering/errorFilter.js?v=8a54de31bff8`,
    `${BASE_PATHS.CLIENT_CORE}/page_initialization/svg_fixing/svgFixerLoader.js?v=fdf5cde639ee`,
    `${BASE_PATHS.CLIENT_CORE}/page_initialization/page_initialization_core/pageInitializerLoader.js?v=407ef636a240`,
    `${BASE_PATHS.CLIENT_CORE}/themeToggle.js?v=dd535222b6f0`,
    `${BASE_PATHS.CLIENT_CORE}/response_handling/responseClass.js?v=2fac1d9fdb98`,
    `${BASE_PATHS.CLIENT_CORE}/connection_management/connection_status_core/connectionStatusLoader.js?v=a6dbae2e3334`,
    `${BASE_PATHS.CLIENT_CORE}/connection_management/idleDetector.js?v=6af683b6306a`,
    `${BASE_PATHS.CLIENT_CORE}/connection_management/heartbeat_core/heartbeatLoader.js?v=c0f7922138af`,
    `${BASE_PATHS.CLIENT_CORE}/connection_management/geminiInstructionState.js?v=783e71af7bc3`,
    `${BASE_PATHS.CLIENT_CORE}/connection_management/geminiSessionResumption.js?v=14014db741b6`,
    `${BASE_PATHS.CLIENT_CORE}/connection_management/autoSetupHandler.js?v=fca60cb7616e`,
    `${BASE_PATHS.CLIENT_CORE}/connection_management/socket_core/socketCoreLoader.js?v=42b3f57437a9`,
    `${BASE_PATHS.CLIENT_CORE}/connection_management/waitForConnection.js?v=78e959ad2d9b`,

    // 2. Agentic Functions
    `${BASE_PATHS.AGENTIC}/audio_proc/audio_proc.js?v=b9c37abec210`,
    `${BASE_PATHS.AGENTIC}/self_talk/self_talk.js?v=2e41e1dbad9c`,
    `${BASE_PATHS.AGENTIC}/scr_cap/scr_cap.js?v=cd2003932bc1`,
    `${BASE_PATHS.AGENTIC}/sess_ctrl/sess_ctrl.js?v=cc5ee042f918`,
    `${BASE_PATHS.AGENTIC}/conv_mem/conv_mem.js?v=9d973f5cbe45`,
    `${BASE_PATHS.AGENTIC}/time_perc/time_perc.js?v=05fcdfc258d9`,

    // 3. Log Interface Display
    `${BASE_PATHS.LOG_INTERFACE}/msg_log/msg_log.js?v=f2b26e8f92de`,
    `${BASE_PATHS.LOG_INTERFACE}/sys_log/sys_log.js?v=2c6e25d0a00d`,
    `${BASE_PATHS.LOG_INTERFACE}/msg_int/msg_int.js?v=db986a21aefa`,
    `${BASE_PATHS.LOG_INTERFACE}/msg_int/popout_chat_feature/popoutChatHandler.js?v=ebd4472134e5`,
    `${BASE_PATHS.LOG_INTERFACE}/msg_int/text_message_operations/textMessageSender.js?v=cec51bb06442`,
    // Mode 2: Text Brain -> Live Voice relay (loads after sendTextMessage/socket/waitForConnection)
    APP_ROOT + 'js/modules/gemini/mode2/textBrainRelay.config.js?v=ae74c0d11c99',
    APP_ROOT + 'js/modules/gemini/mode2/textBrainRelay.js?v=efdf2b5c9145',
    `${BASE_PATHS.COMM_PANEL}/input_attachments/imageAttachmentHandler.js?v=09674faec11d`,
    `${BASE_PATHS.LOG_INTERFACE}/msg_int/text_input_handling/textInputHandler.js?v=b3ebecb2d9b3`,

    // 4. Communication Panel
    `${BASE_PATHS.COMM_PANEL}/mm_panel/Multimodal_Commuication_Panel.js?v=e586c87eba68`,
    `${BASE_PATHS.COMM_PANEL}/new_chat/Start_New_Chat_Commuication_Panel.js?v=b8d3015dd15f`,
    `${BASE_PATHS.COMM_PANEL}/clear_chat/Clear_Chat_Communication_Panel.js?v=5e6ea3199c50`,
    `${BASE_PATHS.COMM_PANEL}/clear_sys_log/Clear_System_Log_Commuication_Panel.js?v=b53612b2a565`,
    `${BASE_PATHS.COMM_PANEL}/past_chats/Toggle_Past_Chats_Commuication_Panel.js?v=4404063b22c3`,
    `${BASE_PATHS.COMM_PANEL}/sys_msg_toggle/System_Message_Toggle_Commuication_Panel.js?v=1549eaa29bde`,
    `${BASE_PATHS.COMM_PANEL}/reinit_model/Reinitiate_Model_Commuication_Panel.js?v=b297c794face`,

    // 5. Aggregator Modules
    APP_ROOT + 'js/modules/gemini/client/Client_Core_Control.js?v=f1ea8e0e2c03',
    APP_ROOT + 'js/modules/gemini/agentic/Agentic_js_Functions.js?v=25aeb2048eb1',
    APP_ROOT + 'js/modules/gemini/logs/Log_Interface_Display.js?v=bbf83858af82',
    APP_ROOT + 'js/modules/gemini/comm/Communication_Panel.js?v=f59247cf7066'
];

let bootStarted = false;
let bootPromise = null;

function normalizeScriptPath(path) {
    const raw = String(path || '');
    try {
        const url = new URL(raw, window.location.href);
        return `${url.pathname.replace(/^\/+/, '')}${url.search || ''}`;
    } catch (error) {
        return raw
            .replace(/^https?:\/\/[^/]+\//i, '')
            .replace(/^\/+/, '');
    }
}

function hasScriptTag(path) {
    const target = normalizeScriptPath(path);
    const scripts = document.querySelectorAll('script[src]');
    for (const script of scripts) {
        if (normalizeScriptPath(script.getAttribute('src')) === target) {
            return true;
        }
    }
    return false;
}

function shouldEagerBoot() {
    try {
        const qs = new URLSearchParams(window.location.search || '');
        if (qs.get('geminiBoot') === 'eager') return true;
        return window.localStorage && window.localStorage.getItem('eve.geminiBoot') === 'eager';
    } catch (e) {
        return false;
    }
}

function sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function getBootPressure() {
    try {
        return {
            domNodes: document.body ? document.body.getElementsByTagName('*').length : 0,
            images: document.images ? document.images.length : 0
        };
    } catch (e) {
        return { domNodes: 0, images: 0 };
    }
}

function isAppBusyForGeminiBoot(pressure) {
    const now = Date.now();
    if (window._eveDashRenderPending) return 'dashboard-render';
    if (Number(window.__eveLargeMutationActiveUntil || 0) > now) return 'large-mutation';
    if (Number(window.__eveSuppressFaviconRefreshUntil || 0) > now) return 'favicon-suppressed';
    const liveLinkCount = typeof window.getLiveLinks === 'function'
        ? (window.getLiveLinks() || []).length
        : (Array.isArray(window.eveState?.links) ? window.eveState.links.length : 0);
    if (
        !window.__GEMINI_FORCE_BOOT_NOW
        && liveLinkCount >= 1000
        && window.__GEMINI_BOOT_STATE?.startedAt
        && now - Number(window.__GEMINI_BOOT_STATE.startedAt || 0) < 26000
    ) {
        return 'large-pack-startup-hold';
    }
    if (window._eveStartupBookmarkPaintActive && (pressure.domNodes > 6000 || pressure.images > 700)) return 'startup-paint';
    return '';
}

async function waitForGeminiLoadWindow() {
    while (true) {
        const pressure = getBootPressure();
        const busyReason = isAppBusyForGeminiBoot(pressure);
        if (window.__GEMINI_BOOT_STATE) {
            window.__GEMINI_BOOT_STATE.pausedReason = busyReason;
            window.__GEMINI_BOOT_STATE.domNodes = pressure.domNodes;
            window.__GEMINI_BOOT_STATE.images = pressure.images;
        }
        if (!busyReason || window.__GEMINI_FORCE_BOOT_NOW) return pressure;
        await sleep(700);
    }
}

function getGeminiPauseMs(pressure) {
    if (!pressure) return 120;
    if (pressure.domNodes > 24000 || pressure.images > 2400) return 900;
    if (pressure.domNodes > 12000 || pressure.images > 1200) return 450;
    return 120;
}

function loadScriptElement(scriptPath) {
    return new Promise((resolve, reject) => {
        if (hasScriptTag(scriptPath)) {
            resolve('cached');
            return;
        }
        const script = document.createElement('script');
        script.src = scriptPath;
        script.async = false;
        script.onload = () => resolve('loaded');
        script.onerror = (e) => reject(e);
        document.head.appendChild(script);
    });
}

async function loadAllScripts(reason) {
    debugBootLog('Script_Loader: Starting to load all application scripts...');

    const deduped = [];
    const seen = new Set();
    for (const path of masterScriptList) {
        const key = normalizeScriptPath(path);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(path);
    }

    let loadedCount = 0;
    let failedCount = 0;
    const totalScripts = deduped.length;
    window.__GEMINI_BOOT_STATE = {
        total: totalScripts,
        loaded: 0,
        failed: 0,
        reason: reason || 'manual',
        startedAt: Date.now(),
        pausedReason: ''
    };

    for (const scriptPath of deduped) {
        const pressure = await waitForGeminiLoadWindow();
        const started = nowMs();
        try {
            await loadScriptElement(scriptPath);
            loadedCount++;
        } catch (e) {
            failedCount++;
            console.error(`ERROR: Failed to load script: ${scriptPath}`, e);
        }
        window.__GEMINI_BOOT_STATE.loaded = loadedCount;
        window.__GEMINI_BOOT_STATE.failed = failedCount;
        window.__GEMINI_BOOT_STATE.remaining = Math.max(0, totalScripts - loadedCount - failedCount);
        window.EvePerformanceMonitor?.recordOperation?.('gemini-script-load', nowMs() - started, {
            source: 'gemini-loader',
            total: totalScripts,
            remaining: window.__GEMINI_BOOT_STATE.remaining,
            domNodes: pressure.domNodes,
            images: pressure.images,
            phase: reason || 'manual'
        });
        if (loadedCount % 5 === 0 || loadedCount + failedCount === totalScripts) {
            debugBootLog(`Script_Loader: Progress ${loadedCount}/${totalScripts}`);
        }
        if (loadedCount + failedCount < totalScripts) {
            await sleep(getGeminiPauseMs(pressure));
        }
    }

    window.__GEMINI_BOOT_STATE.completedAt = Date.now();
    window.__GEMINI_BOOT_STATE.ready = failedCount === 0;
    window.dispatchEvent(new CustomEvent('eve:gemini-scripts-ready', {
        detail: { ...window.__GEMINI_BOOT_STATE }
    }));
    debugBootLog(`Script_Loader: Gemini boot complete (${loadedCount}/${totalScripts}).`);
    return { ...window.__GEMINI_BOOT_STATE };
}

function startGeminiBoot(reason) {
    if (bootPromise) return bootPromise;
    bootStarted = true;
    window.__GEMINI_BOOT_STARTED = true;
    debugBootLog(`Script_Loader: Starting Gemini module load (${reason || 'auto'})`);
    bootPromise = loadAllScripts(reason).catch(error => {
        console.error('Gemini boot failed:', error);
        throw error;
    });
    window.__GEMINI_BOOT_PROMISE = bootPromise;
    return bootPromise;
}

// Expose manual trigger for on-demand startup from gemini-init.js.
window.__loadGeminiScriptsNow = function () {
    window.__GEMINI_BOOT_REQUESTED = true;
    window.__GEMINI_FORCE_BOOT_NOW = true;
    return startGeminiBoot('manual');
};

window.__whenGeminiScriptsReady = function () {
    if (window.__GEMINI_BOOT_STATE?.completedAt) {
        return Promise.resolve({ ...window.__GEMINI_BOOT_STATE });
    }
    return bootPromise || startGeminiBoot('readiness-request');
};
window.dispatchEvent(new CustomEvent('eve:gemini-loader-ready'));

if (window.__GEMINI_BOOT_REQUESTED || shouldEagerBoot()) {
    startGeminiBoot(window.__GEMINI_BOOT_REQUESTED ? 'pre-requested' : 'eager');
}
