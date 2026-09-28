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

function sourceContract() {
    const helper = read('server_modules/eveos_control_helper.py');
    const control = read('server_modules/watchfusion_control.py');
    const exposureControl = read('server_modules/watchfusion_exposure.py');
    const prefs = read('server_modules/eveos_console_prefs.py');
    const registry = JSON.parse(read('config/eveos-ports.json'));
    const manifest = read('js/config/manifest/scripts.parts/03-feature-modules.js');
    const bootstrap = read('js/modules/features/watchfusion/watchfusion.bootstrap.js');
    const ui = read('js/modules/features/watchfusion/watchfusion.js');
    const css = read('css/modules/watchfusion.css');
    const setupRoutes = read('tools/WatchFusion/src/server/setup-routes.js');
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
    const mediaPlayer = read('tools/WatchFusion/public/client/media-player.js');
    const roomConnection = read('tools/WatchFusion/public/client/room-connection.js');
    const continuityBridge = read('tools/WatchFusion/public/client/eveos-embed-bridge.js');
    const roomStore = read('tools/WatchFusion/src/server/room-store.js');
    const roomRoutes = read('tools/WatchFusion/src/server/room-routes.js');
    const lanLauncher = read('tools/WatchFusion/scripts/START-WATCHFUSION-LAN.bat');

    check(!sensing.includes('127-0-0-1.sslip.io'), 'WF-SENSING-NO-SSLIP', 'watchfusion.runtime-sensing.js still includes sslip candidate origin');
    check(sensing.includes('http://127.0.0.1:'), 'WF-SENSING-LOOPBACK-CANONICAL', 'watchfusion.runtime-sensing.js missing literal loopback candidate origin');
    check(sensing.includes('function configureExposure(snapshot)') && sensing.includes('parsed.origin === exposureOrigin'), 'WF-SENSING-EXPOSURE-ORIGIN', 'LAN/Cloudflare iframe heartbeats are not restricted to the selected exposure origin');

    check(/^from \. import .*\bwatchfusion_control\b/m.test(helper), 'WF-CONTROL-IMPORT', 'control plane does not import WatchFusion lifecycle');
    check(helper.includes('"/api/watchfusion/status"'), 'WF-CONTROL-STATUS', 'WatchFusion status route is missing');
    check(helper.includes('"/api/watchfusion/start"') && helper.includes('watchfusion_control.start_server'), 'WF-CONTROL-START', 'WatchFusion start route is missing');
    check(helper.includes('"/api/watchfusion/stop"') && helper.includes('watchfusion_control.stop_server'), 'WF-CONTROL-STOP', 'WatchFusion stop route is missing');
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
    check(control.includes('def start_server(*, persist: bool = False)') && control.includes('def stop_server(*, persist: bool = False)'), 'WF-NO-PERSIST-DEFAULT', 'ordinary WatchFusion start/stop still persists surprise boot state');
    check(control.includes('"components": components'), 'WF-OFFLINE-SETUP-STATUS', 'outer workspace cannot inspect components while WatchFusion is stopped');
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
    check(clientCore.includes("eveosShareMode !== 'local'") && clientCore.includes('return roomLink(eveosShareBaseUrl)'), 'WF-SHARE-SCOPE-LINK', 'WatchFusion does not preserve the selected LAN/Cloudflare room-sharing scope');
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
    check(roomConnection.includes('function resumeRoomSession') && roomConnection.includes('syncResumedPlayback') && roomConnection.includes("window.addEventListener('focus', resumeRoomSession)") && roomConnection.includes("document.addEventListener('visibilitychange', resumeVisibleRoom)"), 'WF-ROOM-RESUME-SYNC', 'returning from a background tab does not actively refresh room state and force playback catch-up');
    check(!roomConnection.includes('updateServerClock(nextState.serverTime, Date.now(), Date.now())') && clientBootstrap.includes('const sentAt=Date.now()') && clientBootstrap.includes('updateServerClock(data.state.serverTime,sentAt,receivedAt)'), 'WF-MEASURED-SERVER-CLOCK', 'unmeasured snapshots can still poison the room clock with a false zero-latency sample');
    check(clientRender.includes("$('partyDetails').hidden=!inRoom"), 'WF-ROOM-REJOIN-DETAILS', 'leaving and rejoining can leave the chat/details container hidden until reload');
    check(playbackCommands.includes('function requestViewerPlayback()') && playbackCommands.includes('if (autoplayWasBlocked) ytPlayer.mute?.();') && playbackCommands.includes('ytPlayer.playVideo?.();'), 'WF-MOBILE-AUTOPLAY-RETRY', 'phone viewers do not retry blocked synchronized playback muted');
    check(playbackCommands.includes('await primeYouTubePlayer();\n              // Priming may legitimately finish without autoplay permission.') && playbackCommands.includes('playerInitializing = false;\n              syncPlayer();'), 'WF-DETACH-HOST-PLAYBACK', 'a blocked autoplay prime can leave detached host playback events permanently suppressed');
    check(playbackSync.includes('requestViewerPlayback()') && !youtubePlayer.includes('playerPrimed || !ytPlayer'), 'WF-MOBILE-AUTOPLAY-GESTURE', 'mobile autoplay recovery still rejects the post-prime user gesture');
    check(playbackSync.includes("lastStatus='catching-up'") && playbackSync.includes('function markStable(resume=false)') && playbackSync.includes('markStable(true);return true;'), 'WF-CATCHUP-STATUS-SETTLES', 'viewer catch-up status does not return to Connected after drift settles or paused playback resumes');
    check(playbackSync.includes('SOFT_DRIFT_SEC=0.08') && playbackSync.includes('SYNC_TOLERANCE_SEC=0.04') && playbackSync.includes("lastStatus==='catching-up'&&abs>SYNC_TOLERANCE_SEC") && playbackSync.includes('TICK_MS=250'), 'WF-SUBAUDIO-DRIFT', 'automatic YouTube convergence still permits an audible fractional offset until Sync me is pressed');
    check(roomStore.includes('projectedPosition(room, serverTime)') && roomStore.includes('export function projectedPosition(room, atTime = now())'), 'WF-SINGLE-TIMESTAMP-PROJECTION', 'published playback position can be newer than projectedAt and get advanced twice by viewers');
    check(mediaPlayer.includes('mediaAnchorServerTime') && mediaPlayer.includes('estimatedServerNow() - mediaAnchorServerTime') && mediaPlayer.includes('mediaDriftCorrecting && absoluteDrift > 0.04'), 'WF-DIRECT-MEDIA-SUBAUDIO-DRIFT', 'direct media convergence does not account for transport time or correct fractional audio drift');
    check(continuityBridge.includes('function waitForTransferReady') && continuityBridge.includes('transfer.retryTimer = setInterval') && continuityBridge.includes('completedTransferIds.has(data.requestId)') && continuityBridge.includes('button.addEventListener(\'click\', reattachToEveOS)'), 'WF-REATTACH-ONE-CLICK', 'reattach can drop an early or in-flight handoff and require a second click');
    check(innerCss.includes('watchfusion-room-active:not(.eveos-embedded) #mediaStage.player-wrap:not(.media-stage-empty)') && innerCss.includes('grid-template-rows: auto minmax(0, 1fr) auto auto;') && innerCss.includes('align-self: stretch;'), 'WF-DETACHED-DYNAMIC-ROW', 'detached media and chat panels do not share the larger dynamic row height');
    check(roomImageRoutes.includes('MAX_CHAT_IMAGE_BYTES') && roomImageRoutes.includes('detectedImageType') && roomImageRoutes.includes('getRoomAttachment'), 'WF-ROOM-IMAGES', 'room image transfer is missing its size, content, or retrieval boundary');
    check(staticFiles.includes("'client/setup-health.js'") && staticFiles.includes("'client/voxelvision-adapter.js'") && staticFiles.includes("'client/media-player.js'"), 'WF-CLIENT-BUNDLE', 'Setup Health or core media adapters are missing from the integrated bundle');
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
const runtime = embeddedRuntime();

if (failures.length) {
    console.error(`WATCHFUSION INTEGRATION: PASS ${checks.length} | FAIL ${failures.length} | RUNTIME ${runtime.state}`);
    failures.slice(0, 20).forEach((failure) => console.error(`[FAIL] ${failure}`));
    process.exit(1);
}

console.log(`WATCHFUSION INTEGRATION: PASS ${checks.length} | FAIL 0 | RUNTIME ${runtime.state}${runtime.reason ? ` (${runtime.reason})` : ''}`);
