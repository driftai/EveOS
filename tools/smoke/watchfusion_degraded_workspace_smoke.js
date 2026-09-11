#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const manifest = read('js/config/manifest/scripts.parts/03-feature-modules.js');
const resilience = read('js/modules/features/watchfusion/watchfusion.resilience.js');
const sensor = read('js/modules/features/watchfusion/watchfusion.runtime-sensing.js');
const outer = read('js/modules/features/watchfusion/watchfusion.js');
const bridge = read('tools/WatchFusion/public/client/eveos-embed-bridge.js');
const staticFiles = read('tools/WatchFusion/src/server/static-files.js');
const systemRoutes = read('tools/WatchFusion/src/server/system-routes.js');
const shellCss = read('css/modules/watchfusion.css');
const css = read('css/modules/watchfusion-resilience.css');
const registry = JSON.parse(read('config/eveos-ports.json'));

check(manifest.includes('watchfusion/watchfusion.runtime-sensing.js'), 'runtime sensing layer is not loaded before WatchFusion');
check(manifest.includes('watchfusion/watchfusion.resilience.js'), 'resilience layer is not loaded after WatchFusion');
check(resilience.includes('overview') && resilience.includes('nuvio') && resilience.includes('voxelvision')
    && resilience.includes('findMedia') && resilience.includes('watchParty'),
'control-offline workspace is missing feature navigation');
check(resilience.includes('Live actions are intentionally inactive while WatchFusion is stopped.'),
    'stopped workspace does not explain inactive live actions');
check(resilience.includes('Local control is off. You can still browse WatchFusion'),
    'raw network failures are not replaced with a user-facing degraded-state message');
check(resilience.includes('failed to fetch') && resilience.includes('networkerror') && resilience.includes('load failed'),
    'common browser network failures are not normalized');
check(resilience.includes("dataset.wfAction = 'start'"),
    'stopped feature panels do not provide an explicit Start action');
check(!/addEventListener\(['"]click['"],[\s\S]{0,180}EveWatchFusion\.start/.test(resilience),
    'browsing a stopped feature can auto-start WatchFusion');
check(outer.includes('Presentation-only: the header must never start a terminal or runtime.'),
    'outer WatchFusion click contract no longer guarantees presentation-only open');
check(outer.includes('EveWatchFusionRuntimeSensor') || outer.includes('sensor()?.probe'),
    'healthy WatchFusion runtime cannot bypass a stale/offline control-plane status');
check(outer.includes('directRuntime: true') && outer.includes('Online · control off'),
    'direct runtime state is not represented independently from local lifecycle control');
check(outer.includes("addEventListener('eve:watchfusion-presence'") && outer.includes('detached: detachedPresence'),
    'outer EveOS workspace does not sense/report detached WatchFusion presence');
check(sensor.includes("EveOSPortRegistry?.get?.('WATCHFUSION_PORT'") && sensor.includes('/api/health'),
    'direct WatchFusion health sensing is not registry-driven');
check(sensor.includes('matchesControlStatus') && outer.includes('outdated WatchFusion port assignment'),
    'stale control-plane port snapshots are not rejected safely');
check(sensor.includes('watchfusion:detached-presence') && sensor.includes('HEARTBEAT_TTL_MS'),
    'detached-window sensing does not expire through a heartbeat contract');
check(bridge.includes('watchfusion:embedded-presence') && bridge.includes('watchfusion:detached-presence'),
    'WatchFusion runtime does not report embedded/detached presence back to EveOS');
check(staticFiles.includes("'client/eveos-embed-bridge.js'"), 'EveOS presence bridge is not bundled into WatchFusion');
check(systemRoutes.includes("app: 'WatchFusion', port: PORT"), 'WatchFusion health does not publish its resolved registry port');
check(css.includes('.watchfusion-offline-tabs') && css.includes('.watchfusion-offline-panel'),
    'degraded workspace navigation has no scoped EveOS styling');
check(css.includes('.topbar-watchfusion-btn[data-detached="1"]'),
    'detached-window presence has no visible EveOS header state');

// First-paint regression: resilience inserts .watchfusion-offline-browser between idle copy and
// component readiness. The shell therefore has four direct grid children in degraded mode. If the
// shell only reserves three rows, the browser lands in the 1fr track and produces the giant tabs /
// workspace card Drift reproduced on a fresh reload before later reflow appears to "fix" it.
check(/\.watchfusion-idle\s*\{[\s\S]*?grid-template-rows:\s*auto\s+auto\s+minmax\(0,\s*1fr\)\s+auto\s*;/.test(shellCss),
    'degraded WatchFusion shell must reserve four explicit rows so the offline browser cannot stretch into the 1fr track');
check(/\.watchfusion-offline-browser\s*\{[\s\S]*?align-self:\s*start\s*;/.test(css),
    'offline WatchFusion browser must opt out of grid-row stretching on first paint');
check(/\.watchfusion-offline-browser\s*\{[\s\S]*?grid-template-rows:\s*auto\s+auto\s*;/.test(css),
    'offline WatchFusion browser must size tabs and panel from content instead of a flexible row');
check(/\.watchfusion-offline-tabs button\s*\{[\s\S]*?flex:\s*0\s+0\s+auto\s*;/.test(css),
    'offline WatchFusion tabs must not flex-stretch into tall tiles');

const ports = registry.ports || {};
check(Number(ports.WATCHFUSION_PORT?.port) > 0, 'WatchFusion has no canonical registered port');
check(Number(ports.WATCHFUSION_PORT?.port) !== Number(ports.GEMINI_WS_PORT?.port),
    'WatchFusion and Gemini still collide in the canonical registry');

if (failures.length) {
    console.error(`WATCHFUSION_DEGRADED_WORKSPACE_FAIL ${failures.length}`);
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
}

console.log('WATCHFUSION_DEGRADED_WORKSPACE_OK');
