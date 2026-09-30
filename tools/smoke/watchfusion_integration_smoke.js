#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'tools', 'WatchFusion');
const security = process.argv.includes('--security');
const failures = [];
const checks = [];

function check(condition, id, detail) {
    if (condition) checks.push(id);
    else failures.push(`${id}: ${detail}`);
}

function read(relative) {
    return fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
}

function continuityReattachContract() {
    const vm = require('node:vm');
    const events = {};
    const makePeer = () => ({ closed: false, messages: [], postMessage(payload, origin) { this.messages.push({ payload, origin }); } });
    const oldEmbedded = makePeer(), newEmbedded = makePeer(), detached = makePeer();
    let currentEmbedded = oldEmbedded, opens = 0;
    const window = {
        crypto: { randomUUID: () => 'continuity-session' },
        addEventListener: (type, listener) => { events[type] = listener; },
        EveWatchFusionRuntimeSensor: { isCandidateOrigin: () => true },
        EveWatchFusion: {
            getDetachedWindow: () => detached,
            open: () => { opens += 1; currentEmbedded = newEmbedded; }
        }
    };
    const document = {
        querySelector: selector => selector.includes('watchfusion-frame') ? { contentWindow: currentEmbedded } : null,
        addEventListener: () => {}
    };
    window.window = window; window.document = document;
    vm.runInNewContext(read('js/modules/features/watchfusion/watchfusion.continuity.js'), {
        window, document, Uint8Array, Date, Math, Set, Map, Object, String
    });
    const send = (source, data) => events.message({ source, origin:'http://127.0.0.1:9087', data:{ source:'WatchFusion', ...data } });
    send(oldEmbedded, { type:'watchfusion:embedded-presence', version:1, embedded:true });
    send(detached, { type:'watchfusion:detached-presence', version:1, detached:true, windowName:'eveWatchFusionWindow' });
    send(detached, { type:'watchfusion:reattach-request', version:2, role:'detached', sessionId:'continuity-session' });
    send(detached, { type:'watchfusion:continuity-handoff', version:2, role:'detached', sessionId:'continuity-session',
        requestId:'handoff-1', targetRole:'embedded', snapshot:{ media:{ type:'none' } } });
    const staleDelivery = oldEmbedded.messages.some(item => item.payload.type === 'watchfusion:continuity-handoff');
    const earlyDelivery = newEmbedded.messages.some(item => item.payload.type === 'watchfusion:continuity-handoff');
    send(newEmbedded, { type:'watchfusion:embedded-presence', version:1, embedded:true });
    const delivered = newEmbedded.messages.filter(item => item.payload.type === 'watchfusion:continuity-handoff');
    check(opens === 1 && !staleDelivery && !earlyDelivery && delivered.length === 1
        && delivered[0].payload.requestId === 'handoff-1', 'WF-REATTACH-RECEIVER-QUEUE',
    'reattach did not hold the handoff until the replacement embedded receiver registered');
}

function sourceContract() {
    const helper = read('server_modules/eveos_control_helper.py');
    const control = read('server_modules/watchfusion_control.py');
    const modes = read('server_modules/watchfusion_modes.py');
    const extensionFolder = read('server_modules/watchfusion_extension.py');
    const exposureControl = read('server_modules/watchfusion_exposure.py');
    const prefs = read('server_modules/eveos_console_prefs.py');
    const registry = JSON.parse(read('config/eveos-ports.json'));
    const manifest = read('js/config/manifest/scripts.parts/03-feature-modules.js');
    const bootstrap = read('js/modules/features/watchfusion/watchfusion.bootstrap.js');
    const ui = read('js/modules/features/watchfusion/watchfusion.js');
    const modeUi = read('js/modules/features/watchfusion/watchfusion.mode-select.js');
    const css = read('css/modules/watchfusion.css');
    const setupRoutes = read('tools/WatchFusion/src/server/setup-routes.js');
    const systemRoutes = read('tools/WatchFusion/src/server/system-routes.js');
    const roomImageRoutes = read('tools/WatchFusion/src/server/room-image-routes.js');
    const localRequest = read('tools/WatchFusion/src/server/local-request.js');
    const httpUtils = read('tools/WatchFusion/src/server/http-utils.js');
    const setupClient = read('tools/WatchFusion/public/client/setup-health.js');
    const setupHtml = read('tools/WatchFusion/public/index.html');
    const innerCss = read('tools/WatchFusion/public/style.css');
    const staticFiles = read('tools/WatchFusion/src/server/static-files.js');
    const youtubeSetup = read('tools/WatchFusion/voxelvision/scripts/SETUP-YOUTUBE.ps1');
    const youtubeImport = read('tools/WatchFusion/voxelvision/youtube-import.js');
    const depthSession = read('tools/WatchFusion/voxelvision/public/js/depth-worker-session.js');
    const maskAssist = read('tools/WatchFusion/voxelvision/public/js/foreground-mask-assist.js');
    const sensing = read('js/modules/features/watchfusion/watchfusion.runtime-sensing.js');
    const frameCapabilities = read('js/modules/features/watchfusion/watchfusion.frame-capabilities.js');
    const playbackSync = read('tools/WatchFusion/public/playback-sync.js');
    const playbackCommands = read('tools/WatchFusion/public/client/commands.js');
    const youtubePlayer = read('tools/WatchFusion/public/client/youtube-player.js');
    const clientCore = read('tools/WatchFusion/public/client/core.js');
    const clientBootstrap = read('tools/WatchFusion/public/client/bootstrap.js');
    const clientRender = read('tools/WatchFusion/public/client/render.js');
    const roomResize = read('tools/WatchFusion/public/client/room-resize.js');
    const liveSource = read('tools/WatchFusion/public/client/live-source.js');
    const livePeer = read('tools/WatchFusion/browser-extension/live-peer.js');
    const providerRegistry = read('tools/WatchFusion/public/client/provider-registry.js');
    const audioflixLink = read('js/modules/features/watchfusion/watchfusion.audioflix-link.js');
    const sourceProbe = read('tools/WatchFusion/browser-extension/source-probe.js');
    const sourcePageAdapter = read('tools/WatchFusion/browser-extension/source-page-adapter.js');
    const sourceWorker = read('tools/WatchFusion/browser-extension/worker.js');
    const offscreenRelay = read('tools/WatchFusion/browser-extension/offscreen.js');
    const companionHub = read('tools/WatchFusion/browser-extension/eveos-hub-connector.js');
    const companionPopup = read('tools/WatchFusion/browser-extension/popup.js');
    const officialExtensionWorker = read('extension/service-worker.js');
    const dashboardOpen = read('tools/Nexus-Browser/extension/dashboard-open.js');
    const mediaPlayer = read('tools/WatchFusion/public/client/media-player.js');
    const roomConnection = read('tools/WatchFusion/public/client/room-connection.js');
    const continuityBridge = read('tools/WatchFusion/public/client/eveos-embed-bridge.js');
    const roomStore = read('tools/WatchFusion/src/server/room-store.js');
    const roomRoutes = read('tools/WatchFusion/src/server/room-routes.js');
    const liveStreams = read('tools/WatchFusion/src/server/live-streams.js');
    const lanLauncher = read('tools/WatchFusion/scripts/START-WATCHFUSION-LAN.bat');

    check(!sensing.includes('127-0-0-1.sslip.io'), 'WF-SENSING-NO-SSLIP', 'watchfusion.runtime-sensing.js still includes sslip candidate origin');
    check(sensing.includes('http://127.0.0.1:'), 'WF-SENSING-LOOPBACK-CANONICAL', 'watchfusion.runtime-sensing.js missing literal loopback candidate origin');
    check(sensing.includes('function configureExposure(snapshot)') && sensing.includes('parsed.origin === exposureOrigin'), 'WF-SENSING-EXPOSURE-ORIGIN', 'LAN/Cloudflare iframe heartbeats are not restricted to the selected exposure origin');

    check(/^from \. import .*\bwatchfusion_control\b/m.test(helper), 'WF-CONTROL-IMPORT', 'control plane does not import WatchFusion lifecycle');
    check(helper.includes('"/api/watchfusion/status"'), 'WF-CONTROL-STATUS', 'WatchFusion status route is missing');
    check(helper.includes('"/api/watchfusion/start"') && helper.includes('watchfusion_control.start_server'), 'WF-CONTROL-START', 'WatchFusion start route is missing');
    check(helper.includes('"/api/watchfusion/stop"') && helper.includes('watchfusion_control.stop_server'), 'WF-CONTROL-STOP', 'WatchFusion stop route is missing');
    check(helper.includes('"/api/watchfusion/mode"') && helper.includes('watchfusion_modes.apply_request'), 'WF-CONTROL-MODE', 'WatchFusion mode-switch route is missing');
    check(modes.includes('watchfusion_control.start_server(host="0.0.0.0")') && modes.includes('START-WATCHFUSION-REMOTE.bat'), 'WF-CONTROL-MODE-LAUNCH', 'mode switcher cannot launch LAN and Remote modes');
    check(modeUi.includes("dataset.wfMode") && modeUi.includes("/api/watchfusion/mode"), 'WF-MODE-UI', 'top marker mode selector is not wired to lifecycle control');
    check(officialExtensionWorker.includes("startPath:'/api/watchfusion/launch'") && dashboardOpen.includes('payload.launchPrompt === true') && dashboardOpen.includes('launchTimeoutMs'), 'WF-EXTENSION-SELECTIVE-OPEN', 'official Bridge WatchFusion Open bypasses the Local/LAN/Remote selective launcher');
    check(helper.includes('"/api/watchfusion/setup"') && helper.includes('watchfusion_control.setup_component'), 'WF-CONTROL-SETUP', 'fresh-clone core setup route is missing');
    check(helper.includes('("watchFusion", watchfusion_control.stop_server)'), 'WF-STOP-ALL', 'global EveOS stop does not include WatchFusion');

    const wfPort = Number(registry?.ports?.WATCHFUSION_PORT?.port);
    const geminiPort = Number(registry?.ports?.GEMINI_WS_PORT?.port);
    check(Number.isInteger(wfPort) && wfPort > 0, 'WF-PORT-REGISTRY', 'WatchFusion is missing from canonical port registry');
    check(wfPort !== geminiPort, 'WF-PORT-UNIQUE', 'WatchFusion still collides with Gemini Live');
    check(control.includes('eveos_ports.service_port("WATCHFUSION_PORT")'), 'WF-PORT', 'WatchFusion lifecycle does not resolve its port from the registry');
    check(!ui.includes('127-0-0-1.sslip.io:9085'), 'WF-PORT-UI', 'WatchFusion UI still hard-codes the old runtime port');
    check(control.includes('payload.get("app") != "WatchFusion"'), 'WF-IDENTITY', 'health check does not verify WatchFusion identity');
    check(control.includes('if verified:') && control.includes('for pid in _pids()'), 'WF-SAFE-STOP', 'stop path is not gated by verified service identity');
    check(control.includes('[npm, "ci", "--no-audit", "--no-fund"]'), 'WF-CORE-CI', 'fresh clone cannot repair locked WatchFusion dependencies');
    check(control.includes('setupAvailable') && control.includes('npmReady'), 'WF-CORE-STATUS', 'outer UI cannot distinguish repairable dependency state');
    check(control.includes('"onDemand": True') && control.includes('is never restored at EveOS boot'), 'WF-ON-DEMAND-LIFECYCLE', 'WatchFusion can still auto-restore a prior runtime session');
    check(control.includes('def start_server(*, persist: bool = False, host: str = "127.0.0.1")') && control.includes('def stop_server(*, persist: bool = False)'), 'WF-NO-PERSIST-DEFAULT', 'ordinary WatchFusion start/stop still persists surprise boot state');
    check(control.includes('"components": components'), 'WF-OFFLINE-SETUP-STATUS', 'outer workspace cannot inspect components while WatchFusion is stopped');
    check(offscreenRelay.includes('requestVideoFrameCallback') && offscreenRelay.includes("contentHint = 'motion'"), 'WF-LIVE-LOW-LATENCY-CAPTURE', 'linked-tab relay is not frame-driven/motion-optimized');
    check(sourceWorker.includes("to: 'offscreen'"), 'WF-LIVE-WORKER-RELAY', 'linked-tab worker no longer routes samples to offscreen relay');
    check(livePeer.includes("degradationPreference = 'maintain-framerate'"), 'WF-LIVE-SENDER-PACING', 'WebRTC sender is not tuned to preserve frame cadence');
    check(offscreenRelay.includes('fullFrame') && offscreenRelay.includes("relayHint === 'direct-start'") && offscreenRelay.includes("relayVideoMode = 'direct'") && !offscreenRelay.includes('await peer.replaceVideoTrack'), 'WF-LIVE-DIRECT-TRACK', 'full-frame linked tabs must choose the direct video track before WebRTC negotiation without mid-stream sender replacement');
    check(livePeer.includes('jitterBufferTargetMs') && livePeer.includes('async diagnostics()') && livePeer.includes('jitterBufferMinimumDelay') && liveSource.includes("return isTryCloudflare ? 60 : 10"), 'WF-LIVE-LATENCY-DIAGNOSTICS', 'live receiver latency targets or WebRTC diagnostics are missing');
    check(control.includes('_runtime_json("/api/network-info")') && control.includes('watchfusion_exposure.reconcile_status') && exposureControl.includes('network.get("localOnly") is False') && exposureControl.includes('network.get("canonicalLanHost")') && exposureControl.includes('exposureMode="lan"'), 'WF-LIVE-LAN-EXPOSURE', 'WatchFusion control does not recover the selected LAN surface from the live runtime when exposure metadata is stale');
    check(control.includes('eveos_console_prefs.headless_for("watchFusion")'), 'WF-CONSOLE', 'WatchFusion does not use its independent console preference');
    check(prefs.includes('"watchFusion"'), 'WF-CONSOLE-REGISTRY', 'WatchFusion is not registered in console preferences');

    check(manifest.includes('watchfusion/watchfusion.bootstrap.js') && manifest.includes('watchfusion/watchfusion.js'), 'WF-MANIFEST', 'WatchFusion feature scripts are not in the EveOS manifest');
    check(bootstrap.includes(".topbar-audioflix-btn") && bootstrap.includes("insertAdjacentElement('afterend'"), 'WF-HEADER', 'WatchFusion header button is not anchored beside Audioflix');
    check(ui.includes('Opening WatchFusion is presentation-only') && ui.includes('await refresh();'), 'WF-OPEN-ON-DEMAND', 'opening WatchFusion can still launch its runtime');
    check(!ui.includes('if (status?.dependenciesReady) await setRunning(true)'), 'WF-SETUP-NO-AUTOSTART', 'core dependency setup still starts WatchFusion automatically');
    check(ui.includes("DETACHED_WINDOW_NAME = 'eveWatchFusionWindow'") && ui.includes('function detach()'), 'WF-DETACH', 'WatchFusion does not have Matrix-style named-window detach');
    check(ui.includes('data-wf-action="detach"') && !ui.includes('Open separate'), 'WF-DETACH-UI', 'WatchFusion header still uses the old separate-window action');
    check(ui.includes("mode === 'lan' || mode === 'cloudflare'") && ui.includes('snapshot?.publicUrl || snapshot?.url || snapshot?.localUrl'), 'WF-SELECTED-EXPOSURE-URL', 'embedded and detached WatchFusion do not follow the selected Local/LAN/Cloudflare launch path');
    check(clientCore.includes("runtimeExposureMode !== 'local'") && clientCore.includes('return roomLink(runtimeShareBaseUrl)'), 'WF-SHARE-SCOPE-LINK', 'WatchFusion does not preserve the selected LAN/Cloudflare room-sharing scope');
    check(lanLauncher.includes('LAN_HOST_URL=http://!LAN_IP:.=-!.sslip.io:') && lanLauncher.includes('-PublicUrl "!LAN_HOST_URL!"') && lanLauncher.includes('[FALLBACK] Direct LAN IP:'), 'WF-LAN-SSLIP-EXPOSURE', 'LAN launcher does not publish sslip.io as the canonical exposure URL while retaining the raw IP fallback');
    check(clientCore.indexOf('preferredLanHost') < clientCore.indexOf('preferredLanAddress'), 'WF-LAN-SSLIP-SHARE-LINK', 'copied LAN room links do not prefer the sslip.io host over the raw LAN IP');
    check(/watchfusion-shell-head[\s\S]*data-wf-action="stop"[\s\S]*<\/header>/.test(ui) && css.includes('[data-state="running"] .watchfusion-service-bar { display: none; }'), 'WF-COMPACT-RUNNING-CHROME', 'running WatchFusion still renders a redundant lifecycle status strip');
    check(ui.includes('/api/watchfusion/setup') && ui.includes('Install WatchFusion Core'), 'WF-CORE-UI', 'outer workspace cannot repair a fresh clone');
    check(ui.includes('data-wf-components') && ui.includes('renderComponents'), 'WF-OFFLINE-HEALTH-UI', 'stopped WatchFusion does not expose setup health in EveOS');
    check(css.includes('var(--accent)') && css.includes('var(--bg-secondary)'), 'WF-THEME', 'WatchFusion shell does not consume EveOS theme tokens');
    check(css.includes('.watchfusion-components') && css.includes('width: 100%'), 'WF-WORKSPACE-SHELL', 'WatchFusion outer shell does not expose the full EveOS workspace/setup surface');
    check(css.includes('.watchfusion-shell-head') && css.includes('flex-direction: row;') && css.includes('flex-wrap: nowrap;'), 'WF-OUTER-HEADER-SIZING', 'outer WatchFusion header can stack vertically and consume media space');
    check(css.includes('grid-template-rows: auto auto auto minmax(0, 1fr);') && css.includes('align-content: stretch;'), 'WF-OUTER-CONTIGUOUS-ROWS', 'outer WatchFusion chrome can leave an empty strip between the header and service bar');
    check(/\.watchfusion-frame-wrap\s*\{[\s\S]*?grid-row:\s*4;[\s\S]*?height:\s*100%;/.test(css), 'WF-OUTER-FRAME-GRID-ROW', 'hidden setup banner can collapse the embedded WatchFusion frame into an auto-sized grid row');
    check(css.includes('.watchfusion-frame {') && css.includes('position: absolute;') && css.includes('inset: 0;'), 'WF-OUTER-FRAME-FILL', 'outer WatchFusion iframe is not pinned to the full remaining stage');
    check(css.includes('.watchfusion-frame-loading') && ui.includes('data-frame-state="idle"') && ui.includes('watchfusion-frame-loading') && frameCapabilities.includes("setFrameState(frame, 'loading'") && frameCapabilities.includes("setFrameState(activeFrame, 'ready')"), 'WF-OUTER-FRAME-LOADING-COVER', 'embedded WatchFusion can expose a blank frame before readiness');
    check(ui.includes('const heartbeat = sensor()?.heartbeatState?.()') && ui.includes('heartbeat?.embedded ? heartbeat.embeddedUrl') && ui.includes('embedded.origin === runtime.origin') && ui.includes("url.searchParams.delete('_wfReload')"), 'WF-DETACH-ROOM-PATH', 'detached WatchFusion does not preserve the active room path on the selected exposure origin');
    check(roomRoutes.includes("type === 'volume'") && roomRoutes.includes('room.playback.muted = !!body.muted'), 'WF-ROOM-AUDIO-SERVER', 'room volume and mute are not authoritative server state');
    check(playbackCommands.includes('observeYouTubeAudio') && playbackSync.includes('applyRoomAudioState()'), 'WF-ROOM-AUDIO-CLIENT', 'YouTube host/viewer volume synchronization is incomplete');
    check(clientCore.includes("let roomAudioCandidateKey = ''") && clientCore.includes('actualKey !== roomAudioCandidateKey') && clientCore.includes('}, 350);'), 'WF-ROOM-AUDIO-DEBOUNCE', 'host volume/mute changes are not stabilized before becoming authoritative room audio');
    check(playbackCommands.includes('const alreadyPlaying = ytPlayer.getPlayerState?.() === playingState') && playbackCommands.includes('if (alreadyPlaying)') && playbackCommands.includes('!userGesturePrimeUsed && !alreadyPlaying'), 'WF-VIEWER-AUDIO-STABILITY', 'viewer playback still reissues play/mute transitions while already playing');
    check(clientBootstrap.includes('data.state&&applyIncomingRoomState(data.state)') && clientBootstrap.includes('render()'), 'WF-COMMAND-STATE-HYDRATION', 'room commands still depend entirely on an already-connected event stream to update UI');
    check(clientBootstrap.includes('sampledServerAt') && clientBootstrap.includes('watchPartyClock?.rttMs?.()') && roomRoutes.includes('sampledCommandAgeSeconds') && roomRoutes.includes('sampledPosition + sampleAgeSeconds * activeRate'), 'WF-HOST-TRANSIT-PHASE', 'host playback samples are not advanced once for measured upload transit before becoming authoritative');
    check(clientCore.includes('serverClockSamples.push') && clientCore.includes('slice(0, Math.min(5, serverClockSamples.length))') && clientCore.includes('medianNumber(lowLatency.map(sample => sample.offset))'), 'WF-ROLLING-CLOCK-SENSOR', 'viewer server clock still freezes on one minimum-RTT sample instead of a rolling low-latency median');
    check(clientRender.includes('data-copy-image') && clientRender.includes("new ClipboardItem({'image/png':png})") && clientRender.includes('legacyCopyRoomImage') && clientRender.includes('isMobileImageClipboardClient') && clientRender.includes('Press and hold the image') && clientRender.indexOf('showImageCopyAssist(attachment,imageUrl)') < clientRender.indexOf('if(legacyCopyRoomImage(button))') && clientRender.includes("fileName.style.display='none'") && clientRender.includes('copyRoomImageViaHost') && !clientRender.includes('Image link copied') && !clientRender.includes('>Save</a>'), 'WF-CHAT-IMAGE-COPY', 'chat images do not keep a real mobile/desktop bitmap clipboard path before the host-native fallback');
    check(setupHtml.includes('id="leaveRoomBtn"') && /\/leave`\),\{method:'POST'/.test(clientBootstrap) && clientBootstrap.includes("leaveRoom('Left room.')"), 'WF-ROOM-LEAVE', 'hosts and guests do not have a non-destructive leave-room path');
    check(roomImageRoutes.includes('copyImageToHostClipboard') && roomImageRoutes.includes('isHostMachineClipboardRequest') && roomImageRoutes.includes('System.Windows.Forms.Clipboard') && roomImageRoutes.includes("parts[5] === 'copy-local'"), 'WF-HOST-IMAGE-CLIPBOARD', 'Windows host clipboard fallback for LAN/HTTP image copying is missing');

    check(setupRoutes.includes("parts[1] !== 'setup'") && setupRoutes.includes("parts[2] === 'install'"), 'WF-SETUP-API', 'WatchFusion setup API is not routed');
    check(setupRoutes.includes('isHostLocalRequest') && localRequest.includes("'cf-ray'") && localRequest.includes("'cf-connecting-ip'"), 'WF-SETUP-LOCAL-ONLY', 'install actions are not protected by the centralized host-local request boundary');
    check(localRequest.includes('socketIsLoopback') && localRequest.includes('requestHostIsLocal') && localRequest.includes('browserOriginIsLocal'), 'WF-HOST-LOCAL-BOUNDARY', 'host-local checks do not combine socket, host, and browser-origin validation');
    check(httpUtils.includes('apiCorsOriginForRequest') && !httpUtils.includes("'Access-Control-Allow-Origin', '*'"), 'WF-CORS-NO-WILDCARD', 'WatchFusion API CORS still permits wildcard browser origins');
    check(setupRoutes.includes("component === 'nuvio'") && setupRoutes.includes("component === 'voxel-youtube'"), 'WF-SETUP-ACTIONS', 'Nuvio/Voxel helper installers are missing');
    check(setupRoutes.includes('BritishWerewolf/IS-Net-Anime'), 'WF-MODEL-ID', 'Setup Health does not report the actual anime mask model');
    check(setupHtml.includes('id="setupHealthBtn"') && setupHtml.includes('id="setupHealthGrid"'), 'WF-SETUP-HTML', 'Setup Health panel is missing from WatchFusion');
    check(setupHtml.includes("get('eveos') === '1'") && setupHtml.includes("classList.add('eveos-embedded')"), 'WF-EMBEDDED-MODE', 'embedded WatchFusion cannot opt into EveOS-native layout geometry');
    check(setupHtml.includes('id="watchfusion-boot-theme"') && setupHtml.includes('background: #121212'), 'WF-EMBEDDED-DARK-BOOT', 'WatchFusion can flash a white document before its external theme loads');
    check(setupHtml.includes('id="resolveTabBtn"') && setupHtml.includes('id="shortcutVoxelVisionBtn"') && setupHtml.includes('id="shortcutNuvioBtn"'), 'WF-MEDIA-TABS', 'Find Media/Nuvio/VoxelVision tabs were lost in the merger');
    check(innerCss.includes('html.eveos-embedded .grid') && innerCss.includes('max-width: none') && innerCss.includes('aspect-ratio: auto'), 'WF-EMBEDDED-SIZING', 'embedded WatchFusion still uses standalone max-width/aspect constraints');
    check(innerCss.includes('html.eveos-embedded body {\n  display: flex;') && innerCss.includes('html.eveos-embedded main {\n  flex: 1 1 auto;'), 'WF-EMBEDDED-FLEX-FILL', 'embedded WatchFusion does not flex through the full EveOS stage');
    check(!innerCss.includes('html.eveos-embedded main,\nhtml.eveos-embedded #app { height: calc(100% - 48px)'), 'WF-NO-DOUBLE-HEADER-SUBTRACT', 'embedded WatchFusion still subtracts its inner header twice');
    check(innerCss.includes('grid-template-rows: minmax(0, 1fr) auto;'), 'WF-MEDIA-TOOLBAR-GRID', 'embedded media player still consumes 100% height before its toolbar is laid out');
    check(innerCss.includes('html.eveos-embedded .source-badge { display: none; }'), 'WF-EMBEDDED-TABS-WIDTH', 'redundant source badge still steals horizontal space from embedded tabs');
    check(innerCss.includes('html.eveos-embedded #partyDetails') && innerCss.includes('watchfusion-room-active:not(.eveos-embedded) #partyDetails') && innerCss.includes('scrollbar-gutter: stable'), 'WF-EMBEDDED-CHAT-SCROLL', 'embedded or detached WatchParty chat does not preserve a bounded scroll surface');
    check(innerCss.includes('html.eveos-embedded .top-actions button') && clientRender.includes("watchfusion-audioflix-live"), 'WF-EMBEDDED-COMPACT-AUDIOFLIX', 'embedded controls or Audioflix room geometry can still consume excessive space');
    check(setupHtml.includes('aria-orientation="horizontal"') && roomResize.includes("watchfusion.partyPanelHeight") && roomResize.includes('startY') && roomResize.includes('setPointerCapture') && innerCss.includes('--watchfusion-party-height') && innerCss.includes('cursor: row-resize'), 'WF-ROOM-RESIZE', 'Watch Party divider is not a horizontal resizer directly below the media controls');
    check(setupHtml.includes('id="liveAudioSync"') && setupHtml.includes('id="liveAudioSyncAuto"') && setupHtml.includes('max="1000"') && setupHtml.includes('id="liveStats"') && liveSource.includes('createDelay(2)') && liveSource.includes('AUDIO_SYNC_KEY'), 'WF-AUDIOFLIX-DEVICE-DELAY', 'Audioflix does not expose a deterministic per-device delay path');
    check(livePeer.includes('estimatedPlayoutTimestamp') && livePeer.includes('audioSyncSample()') && livePeer.includes("type: 'sync-sample'") && liveStreams.includes("type:'audio-sync'") && liveStreams.includes('estimatedPlayoutTimestamp') && liveSource.includes('AUDIO_SYNC_AUTO_KEY') && liveSource.includes('onAudioSync: applyAutoSync'), 'WF-AUDIOFLIX-AUTO-SYNC', 'Audioflix room receivers cannot automatically align their playout clocks');
    check(roomConnection.includes('function resumeRoomSession') && roomConnection.includes('syncResumedPlayback') && roomConnection.includes("window.addEventListener('focus', resumeRoomSession)") && roomConnection.includes("document.addEventListener('visibilitychange', resumeVisibleRoom)"), 'WF-ROOM-RESUME-SYNC', 'returning from a background tab does not actively refresh room state and force playback catch-up');
    check(!roomConnection.includes('updateServerClock(nextState.serverTime, Date.now(), Date.now())') && clientBootstrap.includes('const sentAt=Date.now()') && clientBootstrap.includes('updateServerClock(data.state.serverTime,sentAt,receivedAt)'), 'WF-MEASURED-SERVER-CLOCK', 'unmeasured snapshots can still poison the room clock with a false zero-latency sample');
    check(clientRender.includes("$('partyDetails').hidden=!inRoom"), 'WF-ROOM-REJOIN-DETAILS', 'leaving and rejoining can leave the chat/details container hidden until reload');
    check(playbackCommands.includes('function requestViewerPlayback()') && playbackCommands.includes('if (autoplayWasBlocked) ytPlayer.mute?.();') && playbackCommands.includes('ytPlayer.playVideo?.();'), 'WF-MOBILE-AUTOPLAY-RETRY', 'phone viewers do not retry blocked synchronized playback muted');
    check(playbackCommands.includes('await primeYouTubePlayer();\n              // Priming may legitimately finish without autoplay permission.') && playbackCommands.includes('playerInitializing = false;\n              syncPlayer();'), 'WF-DETACH-HOST-PLAYBACK', 'a blocked autoplay prime can leave detached host playback events permanently suppressed');
    check(playbackSync.includes('requestViewerPlayback()') && !youtubePlayer.includes('playerPrimed || !ytPlayer'), 'WF-MOBILE-AUTOPLAY-GESTURE', 'mobile autoplay recovery still rejects the post-prime user gesture');
    check(playbackSync.includes('SYNC_TOLERANCE_SEC = 0.15') && playbackSync.includes('SEEK_DRIFT_SEC = 0.65') && playbackSync.includes('SENSOR_MIN_SAMPLES = 5') && playbackSync.includes('watchFusionSyncDiagnostics') && !playbackSync.includes('nearestHigherRate') && !playbackSync.includes('nearestLowerRate'), 'WF-FILTERED-PHASE-SYNC', 'YouTube viewers can still chase noisy millisecond samples by changing playback speed');
    check(roomStore.includes('projectedPosition(room, serverTime)') && roomStore.includes('export function projectedPosition(room, atTime = now())'), 'WF-SINGLE-TIMESTAMP-PROJECTION', 'published playback position can be newer than projectedAt and get advanced twice by viewers');
    check(mediaPlayer.includes('mediaAnchorServerTime') && mediaPlayer.includes('estimatedServerNow() - mediaAnchorServerTime') && mediaPlayer.includes('absoluteDrift >= 0.20') && mediaPlayer.includes('mediaDriftCorrecting && absoluteDrift > 0.12'), 'WF-DIRECT-MEDIA-MICRO-DRIFT', 'direct media can still change playback speed for jitter-sized millisecond offsets');
    check(continuityBridge.includes('function waitForTransferReady') && continuityBridge.includes('transfer.retryTimer = setInterval') && continuityBridge.includes('completedTransferIds.has(data.requestId)') && continuityBridge.includes('button.addEventListener(\'click\', reattachToEveOS)'), 'WF-REATTACH-ONE-CLICK', 'reattach can drop an early or in-flight handoff and require a second click');
    check(innerCss.includes('height: clamp(540px, calc(100dvh - 112px), 760px);') && innerCss.includes('max-height: min(48dvh, 460px);') && innerCss.includes('watchfusion-room-active:not(.eveos-embedded) #mediaStage.player-wrap:not(.media-stage-empty)') && innerCss.includes('align-self: stretch;'), 'WF-DETACHED-BOUNDED-WORKSPACE', 'detached chat history can still grow the shared media/party row beyond its viewport cap');
    check(roomImageRoutes.includes('MAX_CHAT_IMAGE_BYTES') && roomImageRoutes.includes('detectedImageType') && roomImageRoutes.includes('getRoomAttachment'), 'WF-ROOM-IMAGES', 'room image transfer is missing its size, content, or retrieval boundary');
    check(clientBootstrap.includes('unloadWatchFusionMedia') && clientBootstrap.includes("command('source',{source:ready})") && clientRender.includes("unloadMediaBtn"), 'WF-MEDIA-UNLOAD', 'Find Media does not expose one authoritative unload path for solo and room media');
    check(providerRegistry.includes('unloadMediaProvider') && providerRegistry.includes('unload: () => window.mediaPlayback?.clear?.()'), 'WF-PROVIDER-UNLOAD', 'media providers do not participate in the generic unload lifecycle');
    check(setupHtml.includes('id="livePairClose"') && setupHtml.includes('id="livePairFolder"') && !setupHtml.includes('live-help.html'), 'WF-PAIRING-INLINE-SETUP', 'tab-pairing setup still depends on an external help page or lacks its own close/folder controls');
    check(setupRoutes.includes("parts[2] === 'open-extension-folder'") && setupRoutes.includes('isHostLocalRequest(req)') && setupRoutes.includes("spawn('explorer.exe'"), 'WF-EXTENSION-FOLDER-LOCAL', 'the companion folder shortcut is missing or not host-local protected');
    check(extensionFolder.includes('explorer.exe') && extensionFolder.includes('assemble.cjs') && !extensionFolder.includes('HTTPConnection'), 'WF-EXTENSION-FOLDER-CONTROL', 'EveOS folder buttons still depend on forwarding through the active WatchFusion exposure');
    check(systemRoutes.includes('exposureMode') && systemRoutes.includes('trustedExtensionIds()') && companionHub.includes('api/network-info') && companionPopup.includes('runtime-status'), 'WF-EXTENSION-MODE-STATUS', 'WatchFusion popup cannot report Local/LAN/Remote from the live runtime');
    check(clientCore.includes('data?.exposureMode') && clientBootstrap.includes("loadNetworkInfo().catch") && clientCore.includes("runtimeExposureMode === 'cloudflare'"), 'WF-RUNTIME-MODE-REFRESH', 'inner WatchFusion mode can remain stale after an exposure restart');
    check(liveSource.includes("listenPreferences.get(currentId) ?? source.mode === 'audioflix'") && liveSource.includes('listenPreferences.set(currentId') && audioflixLink.includes("acquireSpeakerMute?.('watchfusion-live')"), 'WF-AUDIOFLIX-LISTEN-HERE', 'Audioflix room monitoring must default on, preserve explicit listener choice, and suppress duplicate host speakers');
    check(sourceWorker.includes('allFrames: true') && sourceWorker.includes('controlFrameId') && sourceProbe.includes("pointerEvents: 'none'"), 'WF-GENERIC-TAB-MEDIA', 'generic tab media does not keep a stable media-only surface or route controls to the selected frame');
    check(sourceWorker.includes("world: 'MAIN'") && sourceWorker.includes("source-page-adapter.js")
      && sourcePageAdapter.includes("querySelectorAll('strmcx-embed')") && sourcePageAdapter.includes("'strmcx-time-update'")
      && sourceProbe.includes("querySelectorAll('strmcx-embed')"), 'WF-WEB-COMPONENT-MEDIA',
    'web-component players cannot expose their visual surface, playback state, or controls to the selected-tab relay');
    check(sourceProbe.includes("relayHint: controller ? 'direct-start' : 'auto'") && sourceWorker.includes('initialMetadata') && sourceWorker.includes('waitForInitialSample') && offscreenRelay.includes("relayHint === 'direct-start'") && offscreenRelay.includes("relayVideoMode = 'direct'") && !offscreenRelay.includes('await peer.replaceVideoTrack'), 'WF-WEB-COMPONENT-DIRECT-START', 'Miruro must choose its low-latency direct track before WebRTC negotiation instead of replacing tracks mid-stream');
    check(sourceProbe.includes('__watchFusionMediaProbeCleanup') && sourceProbe.includes("type:'dispose'") && sourcePageAdapter.includes('__watchFusionPageMediaAdapterCleanup') && sourcePageAdapter.includes("data.type === 'dispose'") && sourcePageAdapter.includes('observer?.disconnect()') && sourceWorker.includes("type: 'probe-stop'") && sourceWorker.includes('__watchFusionMediaProbeCleanup') && offscreenRelay.includes("type === 'stop'"), 'WF-LINK-RESTORE-SOURCE', 'unlinking a captured site does not fully restore the source tab, dispose injected observers, and stop capture');
    check(offscreenRelay.includes('maxWidth: 2560') && offscreenRelay.includes('1920 / sw') && offscreenRelay.includes('canvas.captureStream(0)') && offscreenRelay.includes('requestFrame'), 'WF-LIVE-CAPTURE-QUALITY', 'live tab capture is still fixed-resolution or does not render on-demand at a high-quality media aspect ratio');
    check(staticFiles.includes("'client/setup-health.js'") && staticFiles.includes("'client/voxelvision-adapter.js'") && staticFiles.includes("'client/media-player.js'") && staticFiles.includes("'client/room-resize.js'"), 'WF-CLIENT-BUNDLE', 'Setup Health, room resize, or core media adapters are missing from the integrated bundle');
    check(staticFiles.includes('resolveContainedFile') && staticFiles.includes('fs.promises.realpath'), 'WF-STATIC-REALPATH-CONTAINMENT', 'main WatchFusion static serving does not realpath-check filesystem containment');
    check(setupClient.includes("'/api/setup/status'") && setupClient.includes("'/api/setup/install'"), 'WF-SETUP-CLIENT', 'Setup Health UI is not connected to setup API');

    check(youtubeSetup.includes('yt-dlp.exe') && youtubeSetup.includes('ffmpeg.exe') && youtubeSetup.includes('ffprobe.exe'), 'WF-YOUTUBE-TOOLS', 'fresh YouTube installer does not provision current helpers');
    check(youtubeSetup.includes('$nodeMajor -ge 22') && youtubeSetup.includes('deno.exe'), 'WF-YOUTUBE-JS-RUNTIME', 'fresh YouTube installer does not prefer supported Node 22+ with Deno fallback');
    check(youtubeImport.includes('nodeMajor >= 22'), 'WF-YTDLP-EJS', 'VoxelVision still forces an unsupported old Node runtime into current yt-dlp');
    check(depthSession.includes('voxelvision.model-ready-v1') && depthSession.includes('readyAt'), 'WF-DEPTH-MODEL-STATUS', 'depth model readiness is not persisted for Setup Health');
    check(maskAssist.includes("current['anime-mask']") && maskAssist.includes('readyAt'), 'WF-MASK-MODEL-STATUS', 'anime mask readiness is not persisted for Setup Health');
}

function embeddedRuntime() {
    const packagePath = path.join(TOOL, 'package.json');
    if (!fs.existsSync(packagePath)) return { state: 'SKIP', reason: 'tools/WatchFusion has not been hydrated yet' };

    const serverPath = path.join(TOOL, 'server.js');
    const healthPath = path.join(TOOL, 'src', 'server', 'system-routes.js');
    check(fs.existsSync(serverPath), 'WF-RUNTIME-SERVER', 'hydrated WatchFusion is missing server.js');
    check(fs.existsSync(healthPath), 'WF-RUNTIME-HEALTH', 'hydrated WatchFusion is missing its system health route');
    if (fs.existsSync(healthPath)) {
        const health = fs.readFileSync(healthPath, 'utf8');
        check(health.includes("app: 'WatchFusion'") && health.includes("parts[1] === 'health'"), 'WF-RUNTIME-IDENTITY', 'runtime health identity changed');
    }

    const depsReady = fs.existsSync(path.join(TOOL, 'node_modules', 'ws'))
        && fs.existsSync(path.join(TOOL, 'node_modules', 'hls.js'));
    if (!depsReady) return { state: 'SKIP', reason: 'WatchFusion is hydrated but npm ci has not been run' };

    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const script = security ? 'test:security' : 'test:smoke';
    const result = spawnSync(npm, ['run', '--silent', script], {
        cwd: TOOL,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        windowsHide: true,
        maxBuffer: 3 * 1024 * 1024
    });
    if (result.status !== 0) {
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
        failures.push(`WF-RUNTIME-${security ? 'SECURITY' : 'SMOKE'}: nested ${script} failed\n${output.slice(-5000)}`);
        return { state: 'FAIL', reason: script };
    }
    return { state: 'PASS', reason: script };
}

sourceContract();
continuityReattachContract();
const runtime = embeddedRuntime();

if (failures.length) {
    console.error(`WATCHFUSION INTEGRATION: PASS ${checks.length} | FAIL ${failures.length} | RUNTIME ${runtime.state}`);
    failures.slice(0, 20).forEach((failure) => console.error(`[FAIL] ${failure}`));
    process.exit(1);
}

console.log(`WATCHFUSION INTEGRATION: PASS ${checks.length} | FAIL 0 | RUNTIME ${runtime.state}${runtime.reason ? ` (${runtime.reason})` : ''}`);
