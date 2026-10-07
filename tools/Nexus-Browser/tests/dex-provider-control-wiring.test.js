const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
const entry = fs.readFileSync(path.join(ROOT, 'extension', 'service-worker-entry.js'), 'utf8');
const bridge = fs.readFileSync(path.join(ROOT, 'extension', 'dex-provider-control-bridge.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const dexMode = fs.readFileSync(path.join(ROOT, 'public', 'dex-mode.js'), 'utf8');
const providers = require('../extension/providers.js');
const boot = fs.readFileSync(path.join(ROOT, 'extension', 'dex-provider-control-boot.js'), 'utf8');
const freshness = fs.readFileSync(path.join(ROOT, 'extension', 'provider-adapter-freshness.js'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(ROOT, 'extension', 'service-worker.js'), 'utf8');
const participants = fs.readFileSync(path.join(ROOT, 'public', 'dex-provider-participants.js'), 'utf8');
const spawnTarget = fs.readFileSync(path.join(ROOT, 'extension', 'provider-target-spawn.js'), 'utf8');
const spawnRouting = fs.readFileSync(path.join(ROOT, 'dex', 'provider-target-spawn-routing.js'), 'utf8');

const controlScript = 'content/dex-provider-control.js';

test('every browser provider statically loads the Dex provider-control watcher', () => {
  assert.equal(manifest.content_scripts.length, providers.PROVIDERS.length);
  for (const item of manifest.content_scripts) {
    assert.ok(item.js.includes(controlScript), `Missing ${controlScript} for ${item.matches.join(', ')}`);
  }
});

test('background entry composes provider-control bridge around unchanged main service worker', () => {
  assert.equal(manifest.background.service_worker, 'service-worker-entry.js');
  assert.match(entry, /importScripts\('dex-ui-refresh\.js'\)/);
  assert.match(entry, /importScripts\('dex-provider-control-bridge\.js'\)/);
  assert.match(entry, /importScripts\('dex-provider-control-boot\.js'\)/);
  assert.match(entry, /importScripts\('provider-target-spawn\.js'\)/);
  assert.match(entry, /importScripts\('service-worker\.js'\)/);
  assert.match(bridge, /role: 'provider-control-extension'/);
  assert.match(bridge, /dex_provider_command/);
});

test('server routes provider-control extension or local requests through the Dex client', () => {
  assert.match(server, /createProviderControlRouting/);
  assert.match(server, /msg\.role === 'provider-control-extension'/);
  assert.match(server, /clientKind === 'provider-control'/);
  assert.match(server, /providerControlRouting\.handle\(ws, msg\)/);
  assert.match(server, /providerControlRouting\.dropSocket\(ws\)/);
});

test('Dex UI loads provider-control before runtime and handles routed requests', () => {
  const participantsIndex = html.indexOf('/dex-provider-participants.js');
  const controlIndex = html.indexOf('/dex-provider-control.js');
  const modeIndex = html.indexOf('/dex-mode.js');
  assert.ok(participantsIndex >= 0 && controlIndex > participantsIndex && modeIndex > controlIndex);
  assert.match(dexMode, /BrowserAiBridgeDexProviderControl/);
  assert.match(dexMode, /msg\.type === 'provider_control_request'/);
  assert.match(dexMode, /controlApi\.MUTATING_ACTIONS\.has/);
  const flushIndex = dexMode.indexOf('stateSync?.flush()');
  const resultIndex = dexMode.indexOf("send({ type: 'provider_control_result'");
  assert.ok(flushIndex >= 0 && resultIndex > flushIndex, 'mutating Dex state must flush before provider-control success can be acknowledged');
});


test('every provider can dynamically recover the Dex watcher on an already-open tab', () => {
  for (const provider of providers.PROVIDERS) {
    const group = provider.groups.find((entry) => entry.pingType === 'dex_provider_control_ping');
    assert.ok(group, `Missing dynamic Dex control group for ${provider.id}`);
    assert.equal(group.expectedAdapter, 'dex-provider-control');
    assert.deepEqual(group.files, ['content/dex-provider-control.js']);
  }
});

test('extension boot helper backfills provider-control into already-open headed provider tabs', () => {
  assert.match(boot, /chrome\.runtime\.getManifest\(\)/);
  assert.match(boot, /chrome\.tabs\.query\(\{ url: patterns \}\)/);
  assert.match(boot, /chrome\.scripting\.executeScript/);
  assert.match(boot, /BrowserAiBridgeExtensionAssets\?\.path\(CONTROL_SCRIPT\) \|\| CONTROL_SCRIPT/);
  assert.match(boot, /files: \[file\]/);
  assert.match(boot, /ensureOpenProviderTabs\(\)\.catch/);
});

test('provider-control bridge health-gates eager and lazy localhost WebSocket recovery', () => {
  assert.match(bridge, /ensureSocket\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(bridge, /async function handleContentMessage/);
  assert.match(bridge, /fetchImpl\(HEALTH_URL, \{ cache: 'no-store' \}\)/);
  const healthIndex = bridge.indexOf('await localRelayReady()');
  const socketIndex = bridge.indexOf('new WebSocket(WS_URL)', healthIndex);
  assert.ok(healthIndex >= 0 && socketIndex > healthIndex);
});


test('provider-control result injection tags Dex delivery for provider-specific submit hardening', () => {
  assert.match(bridge, /delivery: \{ kind: 'dex-control-result' \}/);
  assert.match(bridge, /type: 'send_prompt'/);
  assert.match(bridge, /dex-control-origin-receipt/);
  assert.match(bridge, /originReceipt\.originTarget/);
});


test('provider adapters carry a shared revision marker and Dex results freshness-gate exact tabs', () => {
  for (const item of manifest.content_scripts) {
    assert.equal(item.js[0], 'content/provider-adapter-revision.js');
  }
  assert.match(entry, /importScripts\('content\/provider-adapter-revision\.js'\)/);
  assert.match(entry, /importScripts\('provider-adapter-freshness\.js'\)/);
  assert.match(freshness, /provider_adapter_revision_ping/);
  assert.match(freshness, /chromeApi\.tabs\.reload\(Number\(tabId\), \{ bypassCache: true \}\)/);
  assert.match(bridge, /BrowserAiBridgeProviderAdapterFreshness/);
  assert.match(bridge, /await freshness\.ensure\(Number\(source\.targetId\), provider, chrome\)/);
});


test('warm qualification rejects stale adapter revisions without reloading the target', () => {
  assert.match(serviceWorker, /Warm qualification target has a stale adapter revision and may not be reloaded\./);
  assert.match(serviceWorker, /adapterFreshnessApi\.probe\(tab(?:\.id|Id), chrome\)/);
  assert.match(serviceWorker, /adapterFreshnessApi\.current\(revision\)/);
});

test('online provider managed-worker orchestration stays server-owned and exact-target bounded', () => {
  assert.match(server, /createProviderTargetSpawnRouting/);
  assert.match(server, /providerTargetSpawnRouting\.spawn/);
  assert.match(server, /providerTargetSpawnRouting\.close/);
  assert.match(server, /providerTargetSpawnRouting\.observe/);
  assert.match(serviceWorker, /providerTargetSpawnApi\.handle/);
  assert.match(spawnTarget, /chromeApi\.tabs\.create\(\{ url, active: false \}\)/);
  assert.match(spawnTarget, /DEX_CONTROL_PROVIDER_NOT_SPAWNABLE/);
  assert.match(spawnTarget, /chromeApi\.tabs\.remove\(tabId\)/);
  assert.match(spawnRouting, /target_spawned/);
  assert.match(spawnRouting, /target_closed/);
  assert.match(participants, /managedByDex/);
  assert.match(participants, /DEX_CONTROL_SPAWN_TARGET_MISMATCH/);
});
