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
const outer = read('js/modules/features/watchfusion/watchfusion.js');
const css = read('css/modules/watchfusion-resilience.css');
const registry = JSON.parse(read('config/eveos-ports.json'));

check(manifest.includes('watchfusion/watchfusion.resilience.js'), 'resilience layer is not loaded after WatchFusion');
check(resilience.includes("overview") && resilience.includes("nuvio") && resilience.includes("voxelvision")
    && resilience.includes("findMedia") && resilience.includes("watchParty"),
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
check(outer.includes('Opening WatchFusion is presentation-only'),
    'outer WatchFusion click contract no longer guarantees presentation-only open');
check(css.includes('.watchfusion-offline-tabs') && css.includes('.watchfusion-offline-panel'),
    'degraded workspace navigation has no scoped EveOS styling');

const ports = registry.ports || {};
check(Number(ports.WATCHFUSION_PORT?.port) !== Number(ports.GEMINI_WS_PORT?.port),
    'WatchFusion and Gemini still collide in the canonical registry');
check(Number(ports.WATCHFUSION_PORT?.port) === 9087,
    'expected WatchFusion default assignment is not 9087');

if (failures.length) {
    console.error(`WATCHFUSION_DEGRADED_WORKSPACE_FAIL ${failures.length}`);
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
}

console.log('WATCHFUSION_DEGRADED_WORKSPACE_OK');
