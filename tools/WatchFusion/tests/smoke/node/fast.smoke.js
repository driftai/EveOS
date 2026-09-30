import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server-harness.js';
import { request } from '../helpers/http-client.js';
import { isM3u8Response } from '../../../src/server/media-routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const PORT = 19180;

export async function runFastSmoke() {
  const results = [];
  const check = async (id, fn) => {
    try { await fn(); results.push({ id, status: 'PASS' }); }
    catch (error) { results.push({ id, status: 'FAIL', error: error.message }); }
  };

  await check('FAST-00:hls-segments-are-not-reparsed-as-playlists', () => {
    assert.equal(isM3u8Response('https://cdn.example/master.m3u8?token=1','application/octet-stream'),true);
    assert.equal(isM3u8Response('https://cdn.example/playlist/index.m3u8/govp/slices=0-20/file/seg.ts','video/mp2t'),false);
  });

  await check('FAST-01:source-tab-contract', () => {
    const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'index.html'), 'utf8');
    assert.match(html, /id="shortcutNuvioBtn"/);
    assert.match(html, /id="shortcutVoxelVisionBtn"/);
    assert.match(html, /id="resolveTabBtn"/);
    assert.match(html, /id="mediaStage"/);
    assert.match(html, /id="nuvioFrame"/);
    assert.match(html, /id="voxelVisionFrame"/);
    assert.match(html, /id="nuvioToolbar"/);
    assert.match(html, /id="nuvioBackBtn"/);
    assert.match(html, /id="nuvioHomeBtn"/);
    assert.match(html, /id="nuvioReloadBtn"/);
    assert.match(html, /id="nuvioFullBtn"/);
    assert.match(html, /id="nuvioCloseBtn"/);
    assert.match(html, /id="chatInput"[^>]+maxlength="262144"/);
    assert.match(html, /<textarea id="chatInput"/);
    assert.match(html, /id="chatImageInput"[^>]+accept="image\/jpeg,image\/png,image\/webp,image\/gif"/);
    assert.match(html, /id="leaveRoomBtn"[^>]*>Leave room<\/button>/);
    assert.match(html, /youtube-playback-mode\.css/);
    assert.match(html, /id="youtubeEmbedModeBtn"[^>]*>YouTube player<\/button>/);
    assert.match(html, /id="youtubeDirectModeBtn"[^>]*>Direct video<\/button>/);
  });

  await check('FAST-02:source-switch-wiring', () => {
    const bootstrap = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'bootstrap.js'), 'utf8');
    const adapter = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'nuvio-adapter.js'), 'utf8');
    const voxelVisionAdapter = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'voxelvision-adapter.js'), 'utf8');
    const hostFix = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'watchfusion-host-input-fix.js'), 'utf8');
    const toolbarLayout = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'nuvio-embedded-toolbar.js'), 'utf8');
    assert.match(bootstrap, /showNuvio/);
    assert.match(bootstrap, /showVoxelVision/);
    assert.match(adapter, /openNuvioBrowserMode/);
    assert.match(voxelVisionAdapter, /openVoxelVisionMode/);
    assert.doesNotMatch(hostFix, /window\.addEventListener\(['"](?:pointerdown|mousedown|click)['"][\s\S]*stopImmediatePropagation/);
    assert.match(hostFix, /shortcutNuvioBtn/);
    assert.match(hostFix, /shortcutVoxelVisionBtn/);
    assert.match(hostFix, /resolveTabBtn/);
    assert.doesNotThrow(() => new Function(toolbarLayout));
    assert.match(toolbarLayout, /html\.eveos-embedded \.nuvio-toolbar/);
    assert.match(toolbarLayout, /z-index:\s*70/);
    assert.match(toolbarLayout, /min-height:\s*38px/);
    assert.match(toolbarLayout, /flex-wrap:\s*nowrap/);
  });

  await check('FAST-02B:lan-room-share-and-embedded-layout-contract', () => {
    const core = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'core.js'), 'utf8');
    const connection = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'room-connection.js'), 'utf8');
    const render = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'render.js'), 'utf8');
    const bootstrap = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'bootstrap.js'), 'utf8');
    const mediaPlayer = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'media-player.js'), 'utf8');
    const playbackSync = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'playback-sync.js'), 'utf8');
    const commands = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'commands.js'), 'utf8');
    const youtubeStability = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'youtube-stability.js'), 'utf8');
    const youtubeMode = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'youtube-playback-mode.js'), 'utf8');
    const continuityBridge = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'eveos-embed-bridge.js'), 'utf8');
    const roomResize = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'room-resize.js'), 'utf8');
    const liveSource = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'live-source.js'), 'utf8');
    const linkedTab = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'linked-tab.js'), 'utf8');
    const mediaControls = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'media-controls.js'), 'utf8');
    const liveStreams = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'server', 'live-streams.js'), 'utf8');
    const sourceAdapter = fs.readFileSync(path.join(PROJECT_ROOT, 'browser-extension', 'source-page-adapter.js'), 'utf8');
    const sourceProbe = fs.readFileSync(path.join(PROJECT_ROOT, 'browser-extension', 'source-probe.js'), 'utf8');
    const sourceWorker = fs.readFileSync(path.join(PROJECT_ROOT, 'browser-extension', 'worker.js'), 'utf8');
    const style = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'style.css'), 'utf8');
    const roomLayoutCss = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'room-layout.css'), 'utf8');
    const layoutCss = `${style}\n${roomLayoutCss}`;
    const liveCss = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'live-source.css'), 'utf8');
    const youtubeModeCss = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'youtube-playback-mode.css'), 'utf8');
    assert.match(core, /serverLanMode && lanBaseUrl/);
    assert.ok(core.indexOf('preferredLanHost') < core.indexOf('preferredLanAddress'));
    assert.match(core, /function shareRoomToken\(\) \{ return joinCode \|\| roomCode \|\| roomId; \}/);
    assert.match(connection, /replaceRoomHistory\(joinCode \|\| roomId\)/);
    assert.match(render, /watchfusion-room-active/);
    assert.match(render, /renderedChatSignature/);
    assert.match(render, /roomImageUrl/);
    assert.match(render, /data-copy-image/);
    assert.match(render, /legacyCopyRoomImage/);
    assert.match(render, /isMobileImageClipboardClient/);
    assert.match(render, /Press and hold the image/);
    assert.match(render, /partyDetails'\)\)\$\('partyDetails'\)\.hidden=!inRoom/);
    assert.match(render, /fileName\.style\.display='none'/);
    assert.doesNotMatch(render, /Image link copied/);
    assert.doesNotMatch(render, />Save<\/a>/);
    assert.match(core, /runtimeShareBaseUrl/);
    assert.match(core, /runtimeExposureMode !== 'local'/);
    assert.match(core, /function updateLanCopyVisibility/);
    assert.match(core, /runtimeShareBaseUrl\|\|eveosShareBaseUrl/);
    assert.match(core, /button\.hidden=!\(roomId&&session&&serverLanMode&&base\)/);
    assert.match(style, /eveos-embedded\.watchfusion-room-active/);
    assert.match(style, /eveos-embedded #partyDetails/);
    assert.match(layoutCss, /watchfusion-room-active:not\(\.eveos-embedded\) #partyDetails/);
    assert.match(layoutCss, /watchfusion-room-active:not\(\.eveos-embedded\) #mediaStage\.player-wrap:not\(\.media-stage-empty\)/);
    assert.match(layoutCss, /height:\s*clamp\(540px, calc\(100dvh - 112px\), 760px\)/);
    assert.match(layoutCss, /max-height:\s*min\(48dvh, 460px\)/);
    assert.match(layoutCss, /align-self:\s*stretch/);
    assert.match(style, /scrollbar-gutter:\s*stable/);
    assert.match(roomResize, /watchfusion\.partyPanelHeight/);
    assert.match(roomResize, /MIN_MEDIA_HEIGHT = 280/);
    assert.match(roomResize, /startY/);
    assert.match(roomResize, /setPointerCapture/);
    assert.match(style, /--watchfusion-party-height/);
    assert.match(style, /cursor:\s*row-resize/);
    assert.match(render, /hasVisualMedia=\(isLive&&source\.mode!==['"]audioflix['"]\)/);
    assert.match(render, /watchShell\.classList\.toggle\('solo-idle',idleSolo\)/);
    assert.match(render, /watchShell\.classList\.toggle\('audio-only-live',audioOnlyLive\)/);
    assert.match(render, /watchShell\.classList\.toggle\('room-idle',roomIdleNoMedia\)/);
    assert.match(render, /watchfusion-room-idle/);
    assert.match(style, /watchfusion-room-active\.watchfusion-room-idle \.grid/);
    assert.match(style, /grid-template-rows:\s*auto 8px var\(--watchfusion-party-height/);
    assert.match(liveCss, /\.watch-shell\.audio-only-live \.live-controls/);
    assert.match(liveCss, /#liveQueueWrap:not\(\[hidden\]\)/);
    assert.match(liveCss, /#liveQueue[\s\S]*max-height:\s*none/);
    assert.match(liveCss, /overflow-y:\s*scroll/);
    assert.match(liveCss, /scrollbar-gutter:\s*stable/);
    assert.match(render, /soloEmptyState/);
    assert.match(style, /\.watch-shell\.solo-idle/);
    assert.match(style, /\.solo-empty-state/);
    assert.match(liveSource, /liveVideo\.hidden=source\?\.mode===['"]audioflix['"]/);
    assert.match(style, /#mediaStage\.player-wrap\.media-stage-empty[\s\S]*display:\s*none\s*!important/);
    assert.match(style, /video:not\(\[hidden\]\)/);
    assert.match(liveSource, /AUDIO_SYNC_AUTO_KEY/);
    assert.match(liveSource, /deviceProfileAudioDelayMs/);
    assert.match(liveSource, /return mobile\?355:0/);
    assert.match(liveSource, /onAudioSync:\s*applyAutoSync/);
    assert.match(linkedTab, /watchFusionMediaResolver/);
    assert.match(linkedTab, /command\('mirror'/);
    assert.match(mediaControls, /MEDIA_PREFS_KEY/);
    assert.match(mediaControls, /preferredCandidateIndex/);
    assert.match(liveStreams, /sync-sample/);
    assert.match(liveStreams, /audio-sync/);
    assert.match(liveStreams, /pageUrl/);
    assert.doesNotMatch(sourceAdapter, /setQuality|getQualities|qualityRestore/);
    assert.doesNotMatch(sourceProbe, /position:\s*['"]fixed['"]|captureStream|drawImage|requestFullscreen/);
    assert.match(sourceWorker, /cleanupInjected/);
    assert.match(sourceWorker, /__watchFusionPageMediaAdapterCleanup/);
    assert.match(connection, /function resumeRoomSession/);
    assert.match(connection, /syncResumedPlayback/);
    assert.match(connection, /document\.addEventListener\('visibilitychange', resumeVisibleRoom\)/);
    assert.doesNotMatch(connection, /updateServerClock\(nextState\.serverTime, Date\.now\(\), Date\.now\(\)\)/);
    assert.match(bootstrap, /updateServerClock\(data\.state\.serverTime,sentAt,receivedAt\)/);
    assert.match(playbackSync, /SYNC_TOLERANCE_SEC = 0\.15/);
    assert.match(commands, /if \(isHost\(\) && options\.hydrateHost !== true\) return;/);
    assert.match(commands, /watchFusionYoutubeStability\?\.observe[\s\S]*hostPlaybackEventAllowed/);
    assert.match(youtubeStability, /YT\.PlayerState\.BUFFERING/);
    assert.match(youtubeStability, /getVideoLoadedFraction/);
    assert.match(youtubeStability, /native playback stays active/);
    assert.match(youtubeStability, /options\.manual!==true&&options\.blocked!==true/);
    assert.match(youtubeStability, /\/voxelvision\/api\/youtube\/stream/);
    assert.match(youtubeStability, /\/voxelvision\/api\/youtube\/import/);
    assert.match(youtubeStability, /quality:'max'/);
    assert.match(youtubeStability, /watchFusionMediaResolver\?\.loadCandidate/);
    assert.match(youtubeStability, /Stable direct YouTube playback ready/);
    assert.match(youtubeMode, /switchToEmbed/);
    assert.match(youtubeMode, /switchToDirect/);
    assert.match(youtubeMode, /stabilize\?\.\(\{ manual: true/);
    assert.match(youtubeMode, /loadYoutubeInput\(url\)/);
    assert.match(youtubeModeCss, /button\[aria-pressed="true"\]/);
    assert.match(commands, /blocks embedding[\s\S]*stabilize\?\.\(\{ blocked: true \}\)/);
    assert.match(commands, /!ytPlayer \|\| !ytPlayerReady\)[\s\S]*setTimeout\(tick, 50\)/);
    assert.match(commands, /syncPlayer\(\{ hydrateHost: true \}\)/);
    assert.match(playbackSync, /SEEK_DRIFT_SEC = 0\.65/);
    assert.match(playbackSync, /SENSOR_MIN_SAMPLES = 5/);
    assert.doesNotMatch(playbackSync, /nearestHigherRate|nearestLowerRate/);
    assert.match(mediaPlayer, /mediaAnchorServerTime/);
    assert.match(mediaPlayer, /mediaEnsurePromise && mediaEnsureUrl === url/);
    assert.doesNotMatch(mediaPlayer, /host\.innerHTML\s*=/);
    assert.match(mediaPlayer, /host\.prepend\(mediaVideo\)/);
    assert.match(mediaPlayer, /absoluteDrift >= 0\.20 \|\| \(mediaDriftCorrecting && absoluteDrift > 0\.12\)/);
    assert.match(continuityBridge, /transfer\.retryTimer = setInterval/);
    assert.match(continuityBridge, /completedTransferIds\.has\(data\.requestId\)/);
  });

  await check('FAST-02C:youtube-buffering-stays-native-until-direct-mode-is-chosen', async () => {
    const callbacks=[];let directResolutions=0,imports=0,loaded=0,restored=0;
    const context={state:{source:{videoId:'H7OPLMNYi-Q',originalUrl:'https://youtu.be/H7OPLMNYi-Q'},playback:{position:0,paused:true}},
      roomId:null,isHost:()=>true,apiUrl:value=>value,window:{watchFusionLinkedTab:{active:()=>false}},
      ytPlayer:{getPlayerState:()=>3,getDuration:()=>240,getVideoLoadedFraction:()=>0,getCurrentTime:()=>0,pauseVideo(){},playVideo(){}},
      YT:{PlayerState:{BUFFERING:3,PLAYING:1,PAUSED:2,ENDED:0}},setTimeout:fn=>{callbacks.push(fn);return callbacks.length;},clearTimeout:()=>{},
      fetch:async url=>{if(String(url).endsWith('/stream')){directResolutions+=1;return{ok:true,json:async()=>({mediaUrl:'/youtube-direct.m3u8',mediaType:'hls',title:'Test'})};}imports+=1;return{ok:false,json:async()=>({error:'offline'})};},
      setStatus:()=>{},console};
    context.window.watchFusionMediaResolver={loadCandidate:async()=>{loaded+=1;context.state.source={kind:'media',url:'/youtube-direct.m3u8',originalUrl:'https://youtu.be/H7OPLMNYi-Q'};return true;}};
    context.window.mediaPlayback={ensureSource:async()=>true,restore:async()=>{restored+=1;return true;}};
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(PROJECT_ROOT,'public','client','youtube-stability.js'),'utf8'),context);
    context.window.watchFusionYoutubeStability.observe(3);
    callbacks.shift()();
    assert.equal(directResolutions,0,'buffering must not silently replace the YouTube iframe');
    assert.equal(imports,0,'buffering must not silently start a source-max download');
    assert.equal(await context.window.watchFusionYoutubeStability.stabilize(),false,'direct playback requires an explicit mode request');
    assert.equal(await context.window.watchFusionYoutubeStability.stabilize({manual:true,paused:true}),true);
    assert.equal(directResolutions,1,'manual Direct video should resolve the existing streaming fallback');
    assert.equal(imports,0,'a successful direct stream should not download the cache fallback');
    assert.equal(loaded,1);
    assert.equal(restored,1);
  });

  await check('FAST-02A:nuvio-browser-plugin-bridge-contract', () => {
    const build = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'BUILD-NUVIO.bat'), 'utf8');
    const patch = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'PATCH-NUVIO-BROWSER-PLUGINS.ps1'), 'utf8');
    const config = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'server', 'nuvio-config.js'), 'utf8');
    const routes = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'server', 'nuvio-routes.js'), 'utf8');
    const bridge = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'server', 'nuvio-plugin-proxy.js'), 'utf8');
    assert.match(build, /PATCH-NUVIO-BROWSER-PLUGINS\.ps1/);
    assert.match(build, /-VerifyDist/);
    assert.match(patch, /watchFusionBrowserBridge/);
    assert.match(patch, /__WATCHFUSION_NUVIO_PLUGIN_FETCH__/);
    assert.match(patch, /cinemeta\.strem\.io/);
    assert.match(patch, /moviedb_id/);
    assert.match(config, /__NUVIO_ALLOW_BROWSER_PLUGIN_RUNTIME__/);
    assert.match(config, /__WATCHFUSION_NUVIO_PLUGIN_FETCH__/);
    assert.match(config, /\/__nuvio__\/plugin-fetch/);
    assert.match(routes, /isHostLocalRequest\(req\)/);
    assert.match(routes, /\/__nuvio__\/plugin-fetch/);
    assert.match(bridge, /assertPublicHttpUrl/);
    assert.match(bridge, /MAX_PLUGIN_RESPONSE_BYTES/);
  });

  await check('FAST-03:nuvio-native-mouse-bridge-contract', () => {
    const bridge = fs.readFileSync(
      path.join(PROJECT_ROOT, 'public', 'client', 'nuvio-external-mouse-bridge.js'),
      'utf8'
    );
    const presentation = fs.readFileSync(
      path.join(PROJECT_ROOT, 'public', 'client', 'nuvio-player-input-fix.js'),
      'utf8'
    );
    const adapter = fs.readFileSync(
      path.join(PROJECT_ROOT, 'public', 'client', 'nuvio-adapter.js'),
      'utf8'
    );
    const connector = fs.readFileSync(
      path.join(PROJECT_ROOT, 'public', 'client', 'nuvio-native-viewport-connector.js'),
      'utf8'
    );
    const build = fs.readFileSync(
      path.join(PROJECT_ROOT, 'scripts', 'BUILD-NUVIO.bat'),
      'utf8'
    );
    const patch = fs.readFileSync(
      path.join(PROJECT_ROOT, 'scripts', 'PATCH-NUVIO-BROWSER-MOUSE.ps1'),
      'utf8'
    );
    assert.doesNotThrow(() => new Function(bridge));
    assert.doesNotThrow(() => new Function(connector));
    assert.match(bridge, /__WATCHFUSION_NUVIO_POINTER_API__/);
    assert.match(bridge, /native-patch-missing/);
    assert.match(bridge, /document\.addEventListener\(moveEvent, onPointerMove, true\)/);
    assert.match(bridge, /document\.addEventListener\(['"]click['"], onClick, true\)/);
    assert.match(bridge, /event\.isTrusted === false/);
    assert.match(bridge, /pointerTargetAt/);
    assert.match(bridge, /routeEventTo/);
    assert.match(bridge, /playerProgressShell/);
    assert.match(bridge, /retargetedClicks/);
    assert.match(bridge, /pauseOverlayTargetAt/);
    assert.match(bridge, /resumePauseOverlay/);
    assert.match(bridge, /pauseOverlayClicks/);
    assert.match(bridge, /api\.version >= 6/);
    assert.doesNotMatch(bridge, /\.currentTime\s*=|new MouseEvent|dispatchEvent/);
    assert.doesNotMatch(presentation, /addEventListener\(['"](?:pointerdown|pointerup|click)['"]/);
    assert.match(adapter, /watchFusionExternalNuvioMouse\?\.version===6/);
    assert.match(adapter, /watchFusionNuvioReady==='1'/);
    assert.match(build, /PATCH-NUVIO-BROWSER-MOUSE\.ps1/);
    assert.match(build, /-VerifyDist/);
    assert.match(patch, /watchFusionBrowserPointerEnabled/);
    assert.match(patch, /\$processPattern/);
    assert.match(patch, /__WATCHFUSION_NUVIO_POINTER_API__/);
    assert.match(patch, /__NUVIO_BROWSER_POINTER__/);
    assert.match(patch, /resumePauseOverlay/);
    assert.match(patch, /__WATCHFUSION_NUVIO_MOUSE_VERSION__\\s\*=\\s\*6/);
  });

  await check('FAST-04:bundle-includes-host-fix', async () => {
    const server = await startServer({ port: PORT, host: '127.0.0.1' });
    try {
      const response = await request(server.baseUrl, '/app.js');
      assert.equal(response.status, 200);
      assert.doesNotThrow(() => new Function(response.body));
      assert.match(response.body, /installWatchFusionHostInputFix/);
      assert.match(response.body, /watchfusion-host-input-fix\.js/);
      assert.match(response.body, /function openVoxelVisionMode/);
      assert.match(response.body, /__watchfusion_embedded_nuvio_toolbar_layout/);
      assert.ok(response.body.indexOf('installWatchFusionHostInputFix') > response.body.indexOf('function render'));
    } finally {
      await server.stop();
    }
  });

  await check('FAST-05:health-and-static', async () => {
    const server = await startServer({ port: PORT + 1, host: '127.0.0.1' });
    try {
      const health = await request(server.baseUrl, '/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.json?.ok, true);
      // GET '/' from 127.0.0.1 serves canonical HTML directly
      const html = await request(server.baseUrl, '/');
      assert.equal(html.status, 200);
      assert.match(html.body, /WatchFusion/);
    } finally {
      await server.stop();
    }
  });

  return results;
}
