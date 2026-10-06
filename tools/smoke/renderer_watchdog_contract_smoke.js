#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
function read(relative) { return fs.readFileSync(path.join(ROOT, relative), 'utf8'); }
function assert(condition, message) { if (!condition) throw new Error(message); }

const watchdog = read('tools/smoke/renderer_watchdog.js');
const launcher = read('tools/smoke/playwright-browser.js');
const runner = read('tools/smoke/run_with_renderer_watchdog.mjs');
const freeze = read('tools/smoke/gemini_renderer_freeze_diagnostic.js');
const hotloop = read('tools/smoke/gemini_renderer_hotloop_probe.js');

assert(watchdog.includes("cdp.send('Runtime.evaluate'") && watchdog.includes('renderer heartbeat'),
    'Renderer watchdog is missing active CDP heartbeat probes');
assert(watchdog.includes('SystemInfo.getProcessInfo') && watchdog.includes('Debugger.pause'),
    'Renderer watchdog is missing CPU/debugger stall diagnostics');
assert(watchdog.includes('Log.startViolationsReport') && watchdog.includes('longLayout'),
    'Renderer watchdog is missing long-task/layout violation capture');
assert(watchdog.includes('Debugger.resume') && !watchdog.includes('Runtime.terminateExecution'),
    'Universal renderer watchdog must resume diagnostics without terminating smoke execution');
assert(watchdog.includes('EVE_SMOKE_RENDERER_WATCHDOG_STRICT') && watchdog.includes('process.exitCode = 1'),
    'Strict renderer-watchdog mode is not wired to smoke failure');

const reservationIndex = watchdog.indexOf('watchedPages.set(page, reservation)');
const cdpSessionIndex = watchdog.indexOf('newCDPSession(page)');
assert(reservationIndex >= 0 && cdpSessionIndex >= 0 && reservationIndex < cdpSessionIndex,
    'Renderer watchdog must reserve each page before asynchronous CDP setup');
assert(watchdog.includes('if (watchedPages.has(page)) return watchedPages.get(page)')
    && watchdog.includes('resolveReservation(controller)'),
    'Renderer watchdog attachment is not single-flight across concurrent page hooks');

assert(launcher.includes("require('./renderer_watchdog')") && launcher.includes('watchedBrowser('),
    'Shared Playwright launcher does not opt into renderer-watchdog instrumentation');
assert(runner.includes("EVE_SMOKE_RENDERER_WATCHDOG: '1'") && runner.includes('--watchdog-strict'),
    'Renderer watchdog command wrapper is not forwarding diagnostic/strict mode');
assert(runner.includes('eveos_profile_runner.mjs') && runner.includes("commandSeparator = args.indexOf('--')"),
    'Renderer watchdog wrapper cannot drive profiles and arbitrary smoke commands');
assert(freeze.includes('[GEMINI_FREEZE_DIAG_HEARTBEAT]') && freeze.includes('Runtime.terminateExecution'),
    'Recovered Gemini freeze diagnostic lost its aggressive forensic/recovery path');
assert(hotloop.includes('[GEMINI_HOTLOOP_HEARTBEAT]') && hotloop.includes('Debugger.getScriptSource'),
    'Recovered Gemini hot-loop probe lost paused-source capture');

console.log('renderer watchdog contract smoke: PASS');
