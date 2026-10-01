import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(__dirname, '../../../public/client');
const SRC_SERVER = path.resolve(__dirname, '../../../src/server');
const EXTENSION = path.resolve(__dirname, '../../../browser-extension');

function readClient(name) {
  return fs.readFileSync(path.join(CLIENT, name), 'utf8');
}
function readExtension(name) {
  return fs.readFileSync(path.join(EXTENSION, name), 'utf8');
}

export async function runSourceTabSmokes() {
  const results = [];
  const record = (id, fn) => async () => {
    try {
      await fn();
      results.push({ id, status: 'PASS' });
    } catch (err) {
      results.push({ id, status: 'FAIL', error: err.message });
    }
  };

  const bootstrap = readClient('bootstrap.js');
  const hostFix = readClient('watchfusion-host-input-fix.js');
  const playerFix = readClient('nuvio-player-input-fix.js');
  const voxelVisionAdapter = readClient('voxelvision-adapter.js');
  const staticFiles = fs.readFileSync(path.join(SRC_SERVER, 'static-files.js'), 'utf8');
  const worker = readExtension('worker.js');
  const probe = readExtension('source-probe.js');
  const popup = readExtension('popup.js');
  const linkedTab = readClient('linked-tab.js');
  const linkedPlayback = readClient('linked-playback-sync.js');
  const mediaPlayer = readClient('media-player.js');
  const commands = readClient('commands.js');
  const liveSourceCss = fs.readFileSync(path.resolve(CLIENT, '../live-source.css'), 'utf8');

  await record('ST-01:bootstrap-no-global-window-pointerdown-for-nuvio-tab', async () => {
    const hasGlobalCapture = /window\.addEventListener\s*\(\s*['"]pointerdown['"]/.test(bootstrap) && /closest.*shortcut(?:Nuvio|VoxelVision)Btn/.test(bootstrap);
    assert.ok(!hasGlobalCapture, 'bootstrap.js must not install a global pointerdown capture handler for source tabs.');
  })();

  await record('ST-02:bootstrap-has-element-click-listener-for-nuvio-tab', async () => {
    assert.ok(bootstrap.includes("addEventListener('click',showNuvio,true)") || bootstrap.includes("addEventListener('click', showNuvio, true)"), 'bootstrap.js must attach a capture-phase click listener on #shortcutNuvioBtn calling showNuvio.');
    assert.ok(bootstrap.includes("addEventListener('click',showVoxelVision,true)") || bootstrap.includes("addEventListener('click', showVoxelVision, true)"), 'bootstrap.js must attach a capture-phase click listener on #shortcutVoxelVisionBtn calling showVoxelVision.');
    assert.equal((bootstrap.match(/__watchFusionHostInputBound=true/g) || []).length, 3, 'Primary source handlers must mark all three buttons so the fallback layer does not bind duplicates.');
  })();

  await record('ST-03:host-fix-binds-only-source-buttons', async () => {
    assert.ok(hostFix.includes("bindButton($id('shortcutNuvioBtn'), openNuvio)"));
    assert.ok(hostFix.includes("bindButton($id('shortcutVoxelVisionBtn'), openVoxelVision)"));
    assert.ok(hostFix.includes("bindButton($id('resolveTabBtn'), openFindMedia)"));
    assert.doesNotMatch(hostFix, /window\.addEventListener\s*\(\s*['"](?:pointerdown|mousedown|click)['"]/);
  })();

  await record('ST-04:host-fix-dispatches-source-actions', async () => {
    assert.ok(hostFix.includes('openNuvio()') && hostFix.includes('openVoxelVision()') && hostFix.includes('openFindMedia()'), 'Host compatibility bindings must cover every source action.');
  })();

  await record('ST-05:bundle-order-host-fix-after-bootstrap', async () => {
    const bootstrapIdx = staticFiles.indexOf("'client/bootstrap.js'");
    const hostFixIdx = staticFiles.indexOf("'client/watchfusion-host-input-fix.js'");
    assert.ok(bootstrapIdx !== -1, "Could not find 'client/bootstrap.js' in static-files.js.");
    assert.ok(hostFixIdx !== -1, "Could not find 'client/watchfusion-host-input-fix.js' in static-files.js.");
    assert.ok(hostFixIdx > bootstrapIdx, 'watchfusion-host-input-fix.js must be bundled AFTER bootstrap.js.');
  })();

  await record('ST-06:openNuvioBrowserMode-exported-to-window', async () => {
    assert.ok(bootstrap.includes('window.openNuvioBrowserMode = openNuvioBrowserMode'), 'bootstrap.js must export window.openNuvioBrowserMode for the host-fix fallback.');
    assert.ok(bootstrap.includes('window.openVoxelVisionMode = openVoxelVisionMode'), 'bootstrap.js must export window.openVoxelVisionMode for the host-fix fallback.');
    assert.match(voxelVisionAdapter, /id:\s*'voxelvision'/);
  })();

  await record('ST-07:all-client-js-files-parse-cleanly', async () => {
    const { execFileSync } = await import('node:child_process');
    const clientFiles = fs.readdirSync(CLIENT).filter(f => f.endsWith('.js'));
    const failures = [];
    for (const file of clientFiles) {
      try { execFileSync(process.execPath, ['--check', path.join(CLIENT, file)], { encoding: 'utf8' }); }
      catch (err) { failures.push(`${file}: ${(err.stderr || err.stdout || err.message).trim()}`); }
    }
    assert.deepEqual(failures, [], `Client JS syntax errors:\n${failures.join('\n')}`);
  })();

  await record('ST-08:nuvio-player-fix-is-presentation-only', async () => {
    assert.match(playerFix, /Mouse input is owned exclusively by nuvio-external-mouse-bridge\.js/);
    assert.match(playerFix, /hideSecondarySeekPresentation/);
    assert.doesNotMatch(playerFix, /addEventListener\(['"](?:pointerdown|pointerup|click)['"]/);
  })();

  await record('ST-09:nuvio-player-fix-remains-scoped-to-nuvio-frame', async () => {
    assert.match(playerFix, /frame\.id !== 'nuvioFrame'/);
    assert.match(playerFix, /#nuvioFrame/);
  })();

  await record('ST-10:extension-keeps-one-companion-owned-state-link-runtime', async () => {
    assert.match(worker, /globalThis\.WatchFusionMediaLink\s*=\s*Object\.freeze/);
    assert.match(worker, /startCurrentTab/);
    assert.match(worker, /allFrames: true/);
    assert.match(worker, /source-page-adapter\.js/);
    assert.match(worker, /world: 'MAIN'/);
    assert.match(worker, /controlFrameId/);
    assert.match(worker, /relayVideoMode:'state-only'/);
    assert.match(worker, /importScripts\('live-peer\.js'\)/);
    assert.doesNotMatch(worker, /importScripts\(asset\('live-peer\.js'\)\)/);
    assert.doesNotMatch(worker, /tabCapture|getMediaStreamId|offscreen/);
    assert.match(popup, /type: 'start-pairing'/);
    assert.doesNotMatch(popup, /tabCapture|getMediaStreamId|source-probe\.js/);
  })();

  await record('ST-11:state-probe-is-passive-and-timestamped', async () => {
    assert.doesNotMatch(probe, /position:\s*['"]fixed['"]|captureStream|drawImage|requestFullscreen/);
    assert.match(probe, /\[aria-label\*="Next" i\]/);
    assert.match(probe, /strmcx-embed/);
    assert.match(probe, /sampledAt:Date\.now\(\)/);
    assert.doesNotMatch(probe, /typeof element\.(?:play|pause|seek)/,
      'The isolated probe must trust the main-world adapter instead of rechecking hidden custom-element methods.');
  })();

  await record('ST-12:manual-find-load-detaches-linked-source', async () => {
    assert.match(bootstrap, /watchFusionLinkedTab\?\.active\?\.\(\)[\s\S]{0,100}watchFusionLinkedTab\.stop\(\{quiet:true\}\)/);
    const mediaControls = readClient('media-controls.js');
    assert.match(mediaControls, /loadSelectedMedia\(\)[\s\S]{0,260}watchFusionLinkedTab\.stop\(\{quiet:true\}\)/);
    assert.match(worker, /message\.type==='start-pairing'/);
    assert.equal((worker.match(/startCurrentTab\(/g)||[]).length,2,'Only the public method and explicit start-pairing route may start a tab link.');
  })();

  await record('ST-13:linked-room-mirror-is-projected-and-bounded', async () => {
    assert.match(linkedTab, /MIRROR_INTERVAL_MS=1500/);
    assert.match(linkedTab, /projectedPosition\?\.\(metadata\)/);
    assert.match(linkedTab, /positionJumped\?\.\(position,scheduleMirror\.sample,now\)/);
    assert.match(linkedPlayback, /function mediaPlan/);
  })();

  await record('ST-14:linked-direct-media-does-not-permanently-mask-host-controls', async () => {
    assert.match(mediaPlayer, /if\(!seek&&!rateChanged&&!volumeChanged&&!pauseChanged\)return true;[\s\S]{0,120}mediaAttachedGuardUntil=performance\.now\(\)\+450/);
    assert.match(linkedTab, /CONTROL_ECHO_TTL_MS=2500/);
    assert.match(linkedTab, /applyPendingControls/);
  })();

  await record('ST-15:linked-youtube-poll-detects-host-seeks-without-buffering-event', async () => {
    assert.match(commands, /positionJumped\?\.\(position,linkedYoutubePositionSample,now\)/);
    assert.match(commands, /if\(jumped&&isHost\(\)\)linked\.control\('seek',position\)/);
  })();

  await record('ST-16:linked-controls-stay-compact-over-the-normal-player', async () => {
    assert.match(linkedTab, /classList\.add\('linked-tab-active'\)/);
    assert.match(linkedTab, /classList\.remove\('linked-tab-active'\)/);
    assert.match(liveSourceCss, /\.watch-shell\.linked-tab-active \.live-controls \{ max-height:150px; \}/);
  })();

  return results;
}
