#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const commandSeparator = args.indexOf('--');
const wrapperArgs = commandSeparator >= 0 ? args.slice(0, commandSeparator) : args;
const explicitCommand = commandSeparator >= 0 ? args.slice(commandSeparator + 1) : [];

function has(name) {
    return wrapperArgs.includes(name);
}

function takeValue(name) {
    const index = wrapperArgs.indexOf(name);
    return index >= 0 && index + 1 < wrapperArgs.length ? wrapperArgs[index + 1] : '';
}

const consumed = new Set([
    '--watchdog-strict',
    '--watchdog-report-all',
    '--watchdog-verbose'
]);
for (const name of ['--watchdog-stall-ms', '--watchdog-interval-ms', '--watchdog-probe-timeout-ms']) {
    const index = wrapperArgs.indexOf(name);
    if (index >= 0) {
        consumed.add(name);
        if (index + 1 < wrapperArgs.length) consumed.add(wrapperArgs[index + 1]);
    }
}

const env = {
    ...process.env,
    EVE_SMOKE_RENDERER_WATCHDOG: '1',
    EVE_SMOKE_RENDERER_WATCHDOG_STRICT: has('--watchdog-strict') ? '1' : '0',
    EVE_SMOKE_RENDERER_WATCHDOG_REPORT_ALL: has('--watchdog-report-all') ? '1' : '0',
    EVE_SMOKE_RENDERER_WATCHDOG_VERBOSE: has('--watchdog-verbose') ? '1' : '0'
};

const stallMs = takeValue('--watchdog-stall-ms');
const intervalMs = takeValue('--watchdog-interval-ms');
const probeTimeoutMs = takeValue('--watchdog-probe-timeout-ms');
if (stallMs) env.EVE_SMOKE_RENDERER_WATCHDOG_STALL_MS = stallMs;
if (intervalMs) env.EVE_SMOKE_RENDERER_WATCHDOG_INTERVAL_MS = intervalMs;
if (probeTimeoutMs) env.EVE_SMOKE_RENDERER_WATCHDOG_PROBE_TIMEOUT_MS = probeTimeoutMs;

let command;
let commandArgs;
if (explicitCommand.length) {
    command = explicitCommand[0];
    commandArgs = explicitCommand.slice(1);
    if (process.platform === 'win32' && /^npm$/i.test(command)) command = 'npm.cmd';
    if (process.platform === 'win32' && /^npx$/i.test(command)) command = 'npx.cmd';
} else {
    command = process.execPath;
    commandArgs = [
        path.join(ROOT, 'tools', 'smoke', 'eveos_profile_runner.mjs'),
        ...wrapperArgs.filter((arg) => !consumed.has(arg))
    ];
}

console.log(`[RENDERER_WATCHDOG_RUNNER] mode=${env.EVE_SMOKE_RENDERER_WATCHDOG_STRICT === '1' ? 'strict' : 'diagnostic'} command=${command} ${commandArgs.join(' ')}`);
const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    windowsHide: true
});

if (result.error) {
    console.error(`[RENDERER_WATCHDOG_RUNNER] ${result.error.message}`);
    process.exit(1);
}
process.exit(result.status ?? 1);
