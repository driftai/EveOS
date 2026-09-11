import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server-harness.js';
import { request } from '../helpers/http-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const PORT = 19180;

export async function runFastSmoke() {
  const results = [];
  const check = async (id, fn) => {
    try { await fn(); results.push({ id, status: 'PASS' }); }
    catch (error) { results.push({ id, status: 'FAIL', error: error.message }); }
  };

  await check('FAST-01:source-tab-contract', () => {
    const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'index.html'), 'utf8');
    assert.match(html, /id="shortcutNuvioBtn"/);
    assert.match(html, /id="shortcutVoxelVisionBtn"/);
    assert.match(html, /id="resolveTabBtn"/);
    assert.match(html, /id="mediaStage"/);
    assert.match(html, /id="nuvioFrame"/);
    assert.match(html, /id="voxelVisionFrame"/);
  });

  await check('FAST-02:source-switch-wiring', () => {
    const bootstrap = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'bootstrap.js'), 'utf8');
    const adapter = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'nuvio-adapter.js'), 'utf8');
    const voxelVisionAdapter = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'voxelvision-adapter.js'), 'utf8');
    const hostFix = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'client', 'watchfusion-host-input-fix.js'), 'utf8');
    assert.match(bootstrap, /showNuvio/);
    assert.match(bootstrap, /showVoxelVision/);
    assert.match(adapter, /openNuvioBrowserMode/);
    assert.match(voxelVisionAdapter, /openVoxelVisionMode/);
    assert.doesNotMatch(hostFix, /window\.addEventListener\(['"](?:pointerdown|mousedown|click)['"][\s\S]*stopImmediatePropagation/);
    assert.match(hostFix, /shortcutNuvioBtn/);
    assert.match(hostFix, /shortcutVoxelVisionBtn/);
    assert.match(hostFix, /resolveTabBtn/);
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
      assert.match(response.body, /installWatchFusionHostInputFix/);
      assert.match(response.body, /watchfusion-host-input-fix\.js/);
      assert.match(response.body, /function openVoxelVisionMode/);
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
      // GET '/' from 127.0.0.1 triggers the canonical loopback redirect (302 to
      // 127-0-0-1.sslip.io). This is intentional server behavior. Use the canonical
      // sslip hostname to avoid the redirect and get a real 200 with the HTML.
      const canonicalBase = server.baseUrl.replace('127.0.0.1', '127-0-0-1.sslip.io');
      const html = await request(canonicalBase, '/');
      assert.equal(html.status, 200);
      assert.match(html.body, /WatchFusion/);
    } finally {
      await server.stop();
    }
  });

  return results;
}
